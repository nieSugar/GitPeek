const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-revisions-'));
  const originalLoad = Module._load;
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (repo, file, value) => fs.writeFileSync(path.join(repo.root, file), value, 'utf8');
  const commit = (repo, message) => { git(repo, 'add', '--all'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  const make = id => {
    const repo = { id, root: path.join(temp, id) }; fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); return repo;
  };
  const commands = new Map(), diffs = [], notices = [], errors = [], editorHandlers = [], configurationHandlers = [], calls = [];
  const disposable = { dispose() {} };
  const uri = value => ({ ...value, toString: () => JSON.stringify(value) });
  let enabled = true, provider, barrier;
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    TabInputText: class { constructor(uri) { this.uri = uri; } },
    Uri: { from: uri, file: fsPath => uri({ scheme: 'file', fsPath }) },
    window: {
      activeTextEditor: undefined, tabGroups: { activeTabGroup: {} }, createTreeView: () => disposable,
      onDidChangeActiveTextEditor: handler => (editorHandlers.push(handler), disposable),
      showQuickPick: async () => assert.fail('revision navigation must not open a picker'),
      showInformationMessage: async text => notices.push(text), showErrorMessage: async text => errors.push(text),
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
      onDidChangeConfiguration: handler => (configurationHandlers.push(handler), disposable),
      registerTextDocumentContentProvider: (_scheme, value) => (provider = value, disposable),
    },
    commands: {
      registerCommand: (name, callback) => (commands.set(name, callback), disposable),
      executeCommand: async (name, ...args) => {
        if (name !== 'vscode.diff') return;
        diffs.push(args); vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputTextDiff(args[0], args[1]) };
        activate(args[1]);
      },
    },
  };
  const activate = documentUri => {
    vscode.window.activeTextEditor = documentUri ? { document: { uri: documentUri } } : undefined;
    for (const handler of editorHandlers) handler(vscode.window.activeTextEditor);
  };
  const ref = (side = 1) => JSON.parse(diffs.at(-1)[side].query);
  const previous = target => commands.get('gitpeek.previousFileRevision')(target);
  const next = target => commands.get('gitpeek.nextFileRevision')(target);
  const pauseLog = () => {
    let release, entered;
    const gate = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
    barrier = async () => { barrier = undefined; entered(); await gate; };
    return { release, started };
  };
  try {
    await esbuild.build({ entryPoints: ['git/GitService', 'features/commitDetail'].map(file => path.join(__dirname, '../src', file + '.ts')),
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { registerCommitFeatures } = require(path.join(temp, 'features/commitDetail.cjs'));
    const service = new GitService(); const run = service.run.bind(service);
    service.run = async (repo, args, options) => { calls.push([repo.id, args]); if (args[0] === 'log' && barrier) await barrier(); return run(repo, args, options); };
    const features = registerCommitFeatures({ subscriptions: [] }, service);
    const repo = make('first'), other = make('second');
    const old = '旧 [file].txt', middle = 'middle.txt', file = '最终 [file].txt';
    write(repo, old, 'one\ntwo\nthree\n'); const root = commit(repo, 'root');
    write(repo, old, 'one\nchanged\nthree\n'); const edit = commit(repo, 'edit');
    git(repo, 'mv', old, middle); const rename = commit(repo, 'rename');
    write(repo, middle, 'one\nchanged\nnew three\n'); const editAgain = commit(repo, 'edit again');
    git(repo, 'mv', middle, file); const tip = commit(repo, 'rename again');
    write(repo, 'unrelated.txt', 'unrelated\n'); const snapshot = commit(repo, 'unrelated tip');
    write(other, file, 'other\n'); const otherRoot = commit(other, 'other root');
    write(other, file, 'other changed\n'); const otherTip = commit(other, 'other edit');

    await features.showDiff(repo, root, old, file);
    assert.equal(calls.filter(([, args]) => args[0] === 'log').length, 0, 'opening a diff does not scan file history');
    assert.equal(ref().historyHead, snapshot); assert.equal(ref().currentCommit, root);
    const rootDiff = diffs.at(-1);
    write(repo, file, 'future edit\n'); const future = commit(repo, 'HEAD moved');
    await previous(); assert.match(notices.pop(), /最早/); assert.equal(diffs.length, 1);
    for (const [hash, historicalFile] of [[edit, old], [rename, middle], [editAgain, middle], [tip, file]]) {
      await next(); assert.deepEqual(errors, []); assert.equal(ref().currentCommit, hash, JSON.stringify({ historicalFile, current: ref(), notices })); assert.equal(ref().currentFile, historicalFile);
      assert.equal(ref().historyHead, snapshot); assert.equal(ref(0).currentCommit, hash);
      assert.equal(ref().workspacePath, file); assert.equal(ref().repoId, repo.id);
    }
    await next(); assert.match(notices.pop(), /快照的最新/); assert.notEqual(ref().currentCommit, future);
    activate(diffs.at(-1)[0]); await previous(); assert.equal(ref().currentCommit, editAgain, 'before side navigates from the displayed commit, not its parent');
    await next(); assert.equal(ref().currentCommit, tip);
    activate(undefined); await previous(); assert.equal(ref().currentCommit, editAgain, 'diff tab is usable while no text editor has focus');
    activate(rootDiff[1]); await next(); assert.equal(ref().currentCommit, edit, 'revisiting an old tab retains its immutable history');
    const firstDiff = diffs.at(-1);
    await features.showDiff(other, otherTip, file, file); await previous();
    assert.equal(ref().currentCommit, otherRoot); assert.equal(ref().repoId, other.id);
    assert.equal(await provider.provideTextDocumentContent(diffs.at(-1)[1]), 'other\n');
    activate(firstDiff[1]); await next(); assert.equal(ref().currentCommit, rename); assert.equal(ref().repoId, repo.id);

    const baseDiff = diffs.at(-1);
    const count = diffs.length;
    for (const replacement of [{ historyHead: 'HEAD' }, { currentCommit: '--all' }, { historyFile: '../outside' },
      { currentFile: '/outside' }, { workspacePath: 'C:\\outside.txt' }, { repoId: other.id }, { root: other.root }, { ref: 'HEAD' }, { currentCommit: root }]) {
      const invalid = uri({ ...baseDiff[1], query: JSON.stringify({ ...ref(), ...replacement }) });
      activate(invalid); const before = calls.length; await previous();
      assert.equal(calls.length, before, 'malformed navigation metadata cannot invoke Git');
      assert.equal(errors.length, 1); errors.pop();
    }
    activate(uri({ scheme: 'gitpeek-commit', query: '{broken' })); await previous(); assert.equal(errors.length, 1); errors.pop();
    assert.equal(diffs.length, count);
    activate(baseDiff[1]); enabled = false; const beforeDisabled = calls.length; await previous();
    assert.equal(calls.length, beforeDisabled); enabled = true;

    let pause = pauseLog(); let pending = previous(); await pause.started;
    activate(vscode.Uri.file(path.join(other.root, file))); activate(baseDiff[1]);
    pause.release(); await pending; assert.equal(diffs.length, count, 'switching away and back cancels stale work');
    pause = pauseLog(); pending = previous(); await pause.started;
    enabled = false; for (const handler of configurationHandlers) handler({ affectsConfiguration: () => true });
    enabled = true; pause.release(); await pending; assert.equal(diffs.length, count, 'disable/re-enable cancels pending work');
    pause = pauseLog(); pending = previous(); await pause.started;
    await next(); assert.equal(ref().currentCommit, editAgain); const latestCount = diffs.length;
    pause.release(); await pending; assert.equal(diffs.length, latestCount, 'late navigation cannot replace a newer request');

    await features.showDiff(repo, edit, old); await previous(); assert.equal(ref().currentCommit, root);
    await next(); assert.equal(ref().currentCommit, edit); await next(); assert.match(notices.pop(), /快照的最新/);
    assert.equal(ref().historyHead, edit, 'generic commit diffs anchor at that commit without guessing a newer path');

    git(repo, 'switch', '-c', 'side', tip); write(repo, file, 'side branch\n'); const side = commit(repo, 'side edit');
    git(repo, 'switch', 'main');
    await features.showDiff(repo, side, file, file); await previous();
    assert.equal(ref().currentCommit, tip); assert.equal(ref().historyHead, side, 'a side commit starts its own history when absent from the fixed mainline');
    await next(); assert.equal(ref().currentCommit, side);

    git(repo, 'switch', '-c', 'merge-test', tip); write(repo, 'merge-main.txt', 'main\n'); commit(repo, 'main edit');
    git(repo, 'merge', '--no-ff', 'side', '-m', 'merge side'); const merge = git(repo, 'rev-parse', 'HEAD');
    await features.showDiff(repo, merge, file, file); await previous(); assert.equal(ref().currentCommit, tip, 'merge navigation follows the same first-parent semantics as its diff');
    await next(); assert.equal(ref().currentCommit, merge);
    git(repo, 'rm', '--', file); const deletion = commit(repo, 'delete');
    await features.showDiff(repo, deletion, file, file); assert.equal(ref().empty, true);
    await previous(); assert.equal(ref().currentCommit, merge); await next(); assert.equal(ref().currentCommit, deletion);
    assert.equal(await provider.provideTextDocumentContent(diffs.at(-1)[1]), '');
    const stagedRepo = make('staged-rename');
    write(stagedRepo, old, 'one\ntwo\n'); const stagedRoot = commit(stagedRepo, 'initial');
    write(stagedRepo, old, 'one\nchanged\n'); const stagedHead = commit(stagedRepo, 'edit');
    git(stagedRepo, 'mv', '--', old, file);
    await features.showDiff(stagedRepo, stagedRoot, old, file, { historyHead: stagedHead, historyFile: old });
    assert.equal(ref().historyFile, old); assert.equal(ref().workspacePath, file);
    await next(); assert.equal(ref().currentCommit, stagedHead, 'an uncommitted rename retains the committed history path');
    assert.deepEqual(errors, []);
    console.log('Revision navigation passed: two renames, immutable HEAD, both diff sides, roots/deletion/merge, multi-repo, URI validation, no picker, no eager history scan and stale cancellation.');
  } finally {
    Module._load = originalLoad;
    if (!temp.startsWith(os.tmpdir() + path.sep)) throw new Error('Test directory escaped temporary directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
