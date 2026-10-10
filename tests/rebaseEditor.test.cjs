const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, sep } = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'gitpeek-rebase-view-'));
  const originalLoad = Module._load;
  try {
    const repo = { root: directory, id: directory };
    const commits = [
      { hash: 'a'.repeat(40), subject: '<script>中文</script>', message: 'first\n\nbody' },
      { hash: 'b'.repeat(40), subject: 'second', message: 'second' },
    ];
    const plan = { repo, branch: 'feature', head: commits[1].hash, commits, published: true };
    const disposable = { dispose() {} }, commands = new Map(), panels = [], errors = [], warnings = [], shown = [], executed = [];
    let enabled = true, answer, startCalls = 0, pendingStart, savedState, operationState, resumeCalls = 0, recoveryCalls = 0;
    const backup = { ref: 'refs/gitpeek/rebase/test', head: 'c'.repeat(40), date: '2026-10-10', subject: 'old history' };
    const backend = {
      loadRebasePlan: async () => plan,
      validateRebaseSteps: (_plan, steps) => { if (!Array.isArray(steps)) throw new Error('计划无效'); return steps; },
      readGitOperation: async () => operationState ?? (savedState ? { kind: 'rebase', conflicts: ['conflict.txt'], rebase: savedState } : undefined),
      listRebaseBackups: async () => [backup],
      compareRebaseBackup: async () => ({ repo, backup, head: commits[1].hash, files: [{ status: 'M', path: 'conflict.txt' }] }),
      createRecoveryBranch: async () => { recoveryCalls++; },
      startRebase: async () => { startCalls++; return new Promise(resolve => { pendingStart = resolve; }); },
      continueRebase: async () => { resumeCalls++; return { status: 'completed' }; },
      abortRebase: async () => ({ status: 'aborted' }),
    };
    const vscode = {
      ViewColumn: { Active: -1 },
      Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
      workspace: { isTrusted: true, textDocuments: [], getConfiguration: () => ({ get: () => enabled }) },
      window: {
        createWebviewPanel: () => {
          const panel = {
            active: true, messages: [], reveal() {}, dispose() { this.closed?.(); },
            onDidDispose(callback) { this.closed = callback; return disposable; },
            webview: { onDidReceiveMessage(callback) { panel.receive = callback; return disposable; }, postMessage(message) { panel.messages.push(message); return Promise.resolve(true); } },
          };
          panels.push(panel); return panel;
        },
        showWarningMessage: async (...args) => { warnings.push(args); return typeof answer === 'function' ? answer() : answer; },
        showErrorMessage: async value => errors.push(value), showInformationMessage: async () => answer,
        showQuickPick: async items => items[0], showInputBox: async () => 'recovery/safe',
      },
      commands: {
        registerCommand: (name, callback) => { commands.set(name, callback); return disposable; },
        executeCommand: async (...args) => { executed.push(args); }, getCommands: async () => ['git.openMergeEditor', 'git.openChange'],
      },
    };
    globalThis.__gitpeekRebaseTestBackend = backend;
    const outfile = join(directory, 'editor.cjs');
    await esbuild.build({
      entryPoints: [join(__dirname, '..', 'src', 'features', 'rebaseEditor.ts')], bundle: true,
      platform: 'node', format: 'cjs', external: ['vscode'], outfile,
      plugins: [{ name: 'rebase-backend', setup(build) {
        build.onResolve({ filter: /^\.\/interactiveRebase$/ }, () => ({ path: 'backend', namespace: 'test' }));
        build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__gitpeekRebaseTestBackend', loader: 'js' }));
      } }],
    });
    Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    const { registerRebaseEditor, rebaseHtml } = require(outfile);
    const feature = registerRebaseEditor({ subscriptions: [] }, {}, { pickRepository: async () => repo }, async (...args) => shown.push(args));
    assert.equal(commands.size, 5);
    await feature.show(repo, commits[0].hash);
    const panel = panels[0];
    await panel.receive({ type: 'ready' });
    const token = panel.messages.find(message => message.type === 'plan').token;
    const steps = commits.map(commit => ({ hash: commit.hash, action: 'pick' }));
    await panel.receive({ type: 'start', token: 'stale', steps });
    assert.equal(warnings.length, 0, 'stale webview messages cannot operate');
    await panel.receive({ type: 'showCommit', token, hash: commits[0].hash });
    await panel.receive({ type: 'showCommit', token, hash: 'f'.repeat(40) });
    assert.deepEqual(shown, [[repo, commits[0].hash]], 'only commits in this plan can be opened');
    await panel.receive({ type: 'start', token, steps });
    assert.equal(startCalls, 0, 'cancel does not execute');
    assert.match(warnings[0][1].detail, /远程跟踪引用/);
    answer = '开始整理';
    const dirty = { isDirty: true, uri: { scheme: 'file', fsPath: join(directory, 'unsaved.ts') } };
    vscode.workspace.textDocuments = [dirty];
    await panel.receive({ type: 'start', token, steps });
    assert.equal(startCalls, 0); assert.match(errors.at(-1), /未保存/);
    vscode.workspace.textDocuments = [];
    answer = () => { vscode.workspace.textDocuments = [dirty]; return '开始整理'; };
    await panel.receive({ type: 'start', token, steps });
    assert.equal(startCalls, 0, 'unsaved changes created during confirmation are guarded');
    vscode.workspace.textDocuments = [];
    answer = '开始整理';
    enabled = false;
    await panel.receive({ type: 'start', token, steps });
    enabled = true; vscode.workspace.isTrusted = false;
    await panel.receive({ type: 'start', token, steps });
    assert.equal(startCalls, 0, 'disabled and untrusted workspaces cannot rewrite history');
    vscode.workspace.isTrusted = true;
    const started = panel.receive({ type: 'start', token, steps });
    await new Promise(resolve => setImmediate(resolve));
    await panel.receive({ type: 'start', token, steps });
    assert.equal(startCalls, 1, 'double clicks cannot start two rebases');
    pendingStart({ status: 'completed', backupRef: 'refs/gitpeek/rebase/test' });
    await started;
    assert.equal(panel.messages.at(-1).canStart, false);
    assert.equal(panel.messages.at(-1).state.backupRef, 'refs/gitpeek/rebase/test');
    await panel.receive({ type: 'refresh', token });
    assert.equal(panel.messages.at(-1).state.backupRef, 'refs/gitpeek/rebase/test', 'refresh retains the completed recovery reference');
    panel.dispose();
    savedState = { status: 'paused', backupRef: 'refs/gitpeek/rebase/test' };
    await feature.show(repo);
    assert.equal(panels.length, 2, 'a closed panel can reopen a paused operation');
    await panels[1].receive({ type: 'ready' });
    assert.equal(panels[1].messages.at(-1).state.status, 'paused');
    const pausedToken = panels[1].messages.find(message => message.type === 'plan').token;
    await panels[1].receive({ type: 'openConflict', token: pausedToken, file: '../outside.txt' });
    assert.equal(executed.some(call => call[0] === 'git.openMergeEditor'), false, 'webview cannot choose files outside the conflict list');
    await panels[1].receive({ type: 'openConflict', token: pausedToken, file: 'conflict.txt' });
    assert.equal(executed.at(-1)[0], 'git.openMergeEditor');
    await panels[1].receive({ type: 'conflictDiff', token: pausedToken, file: 'conflict.txt' });
    assert.equal(executed.at(-1)[0], 'git.openChange');
    await panels[1].receive({ type: 'scm', token: pausedToken });
    assert.equal(executed.at(-1)[0], 'workbench.view.scm');
    panels[1].dispose();
    savedState = { status: 'paused', message: 'external rebase' };
    await commands.get('gitpeek.continueRebase')();
    assert.equal(resumeCalls, 0, 'public continue cannot take ownership of an external rebase');
    panels.at(-1).dispose();
    savedState = undefined; operationState = { kind: 'merge', conflicts: ['conflict.txt'] };
    await commands.get('gitpeek.showConflicts')();
    const conflictPanel = panels.at(-1); await conflictPanel.receive({ type: 'ready' });
    assert.equal(conflictPanel.messages.at(-1).operation.kind, 'merge');
    assert.equal(conflictPanel.messages.at(-1).canResume, false);
    answer = '创建恢复分支…';
    await commands.get('gitpeek.rebaseBackups')();
    const compareCalls = executed.filter(call => call[0].startsWith('gitpeek.internal.compare.'));
    assert.deepEqual(compareCalls.map(call => call[0]), ['gitpeek.internal.compare.selectCompare', 'gitpeek.internal.compare.compareSelected']);
    assert.equal(compareCalls[0][1].commitTarget.hash, commits[1].hash);
    assert.equal(compareCalls[1][1].commitTarget.hash, backup.head);
    assert.equal(recoveryCalls, 1, 'recovery is reached after the fixed-snapshot comparison');

    const html = rebaseHtml();
    assert.match(html, /default-src 'none'/);
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
    new vm.Script(script);
    class Element {
      constructor(name) { this.name = name; this.children = []; this.attributes = {}; this.dataset = {}; }
      append(...nodes) { this.children.push(...nodes); }
      replaceChildren(...nodes) { this.children = nodes; }
      setAttribute(name, value) { this.attributes[name] = value; }
      addEventListener(name, callback) { this[name] = callback; }
      focus() { this.focused = true; }
      querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || selector.split(',').includes(child.name)); }
      querySelector(selector) { return this.querySelectorAll('*').find(child => child.name === selector || child.dataset.move && selector === '[data-move="' + child.dataset.move + '"]'); }
    }
    const elements = Object.fromEntries(['commits', 'status', 'start', 'continue', 'abort', 'refresh', 'repo', 'backup', 'operation', 'conflicts', 'scm', 'backups', 'heading', 'planHelp'].map(id => [id, new Element('div')]));
    const sent = []; let receive;
    vm.runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
      document: { getElementById: id => elements[id], createElement: name => new Element(name) },
      window: { addEventListener: (_name, callback) => { receive = callback; } },
    });
    receive({ data: { type: 'plan', plan, repo: directory, token: 'test-token' } });
    receive({ data: { type: 'state', canStart: true, busy: false } });
    assert.equal(elements.commits.children.length, 2);
    assert.equal(elements.commits.children[0].children[0].children[2].textContent, commits[0].subject, 'subjects are literal text');
    elements.commits.children[1].querySelector('[data-move="up"]').click();
    const select = elements.commits.children[0].querySelector('select'); select.value = 'reword'; select.change();
    const textarea = elements.commits.children[0].querySelector('textarea'); textarea.value = '重写标题\n\n正文'; textarea.input();
    elements.start.click();
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'start', token: 'test-token', steps: [
      { hash: commits[1].hash, action: 'reword', message: '重写标题\n\n正文' }, { hash: commits[0].hash, action: 'pick' },
    ] });
    receive({ data: { type: 'state', canStart: false, busy: false, canResume: true, state: { status: 'paused', backupRef: 'refs/gitpeek/rebase/test' }, operation: { kind: 'rebase', conflicts: ['<script>literal.txt'] } } });
    assert.equal(elements.start.disabled, true); assert.equal(elements.continue.hidden, false);
    assert.equal(elements.continue.disabled, false);
    assert.match(elements.backup.textContent, /refs\/gitpeek\/rebase\/test/);
    assert.match(elements.operation.textContent, /GitPeek 发起/);
    assert.equal(elements.planHelp.hidden, true);
    assert.equal(elements.start.hidden, true);
    assert.match(elements.heading.textContent, /冲突处理/);
    assert.equal(elements.conflicts.children[0].children[0].textContent, '<script>literal.txt', 'conflict paths are rendered as text');
    elements.conflicts.children[0].children[1].click();
    assert.equal(sent.at(-1).type, 'openConflict');
    receive({ data: { type: 'state', canStart: false, busy: false, canResume: false, state: { status: 'paused', message: '外部 rebase' } } });
    assert.equal(elements.continue.disabled, true, 'external rebases cannot be resumed in this editor');
    console.log('Rebase editor checks passed (confirmation, stale messages, dirty documents, trust, double clicks, recovery, reorder, messages and CSP).');
  } finally {
    Module._load = originalLoad;
    delete globalThis.__gitpeekRebaseTestBackend;
    if (!directory.startsWith(tmpdir() + sep)) throw new Error('Temporary editor test escaped temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
