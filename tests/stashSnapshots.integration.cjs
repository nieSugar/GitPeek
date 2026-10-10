const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-stash-snapshots-'));
  const originalLoad = Module._load;
  const commands = new Map(), providers = new Map(), views = new Map(), visibility = new Map(), diffs = [], errors = [], notices = [], configurations = [];
  const disposable = { dispose() {} };
  let choose, visible = [], enabled = true;
  const uri = values => ({ ...values, toString: () => JSON.stringify(values) });
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    Uri: { from: uri, file: fsPath => uri({ scheme: 'file', fsPath }) },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    Selection: class { constructor(anchor, active) { this.anchor = anchor; this.active = active; } },
    TextEditorRevealType: { InCenter: 1 },
    workspace: {
      textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
      onDidChangeConfiguration: handler => (configurations.push(handler), disposable),
      registerTextDocumentContentProvider: (scheme, provider) => (providers.set(scheme, provider), disposable),
    },
    window: {
      activeTextEditor: undefined, get visibleTextEditors() { return visible; },
      createTreeView: (name, options) => (views.set(name, options.treeDataProvider), { ...disposable, onDidChangeVisibility: handler => (visibility.set(name, handler), disposable) }), onDidChangeActiveTextEditor: () => disposable,
      showQuickPick: async (items, options) => choose(items, options),
      showInformationMessage: async text => notices.push(text), showErrorMessage: async text => errors.push(text),
    },
    commands: {
      registerCommand: (name, handler) => (commands.set(name, handler), disposable),
      executeCommand: async (name, ...args) => {
        if (commands.has(name)) return commands.get(name)(...args);
        if (name !== 'vscode.diff') return;
        diffs.push(args);
        visible = args.slice(0, 2).map(documentUri => ({ document: { uri: documentUri }, revealRange(range) { this.revealed = range; } }));
      },
    },
  };
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (repo, file, text) => fs.writeFileSync(path.join(repo.root, file), text, typeof text === 'string' ? 'utf8' : undefined);
  try {
    const sources = ['git/GitService', 'features/stashList', 'features/stashFeature', 'features/revisionCompare', 'features/commitDetail'];
    await esbuild.build({ entryPoints: sources.map(source => path.join(__dirname, '../src', source + '.ts')), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { listStashes, previewStash } = require(path.join(temp, 'features/stashList.cjs'));
    const { registerStashFeatures } = require(path.join(temp, 'features/stashFeature.cjs'));
    const { registerRevisionCompare, workingContents } = require(path.join(temp, 'features/revisionCompare.cjs'));
    const { registerCommitFeatures } = require(path.join(temp, 'features/commitDetail.cjs'));
    const service = new GitService(), repo = { id: 'stash', root: path.join(temp, 'repo') };
    fs.mkdirSync(repo.root); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false');
    write(repo, 'tracked.txt', 'base\n'); write(repo, 'old.txt', 'rename\n'); write(repo, 'deleted.txt', 'deleted\n');
    write(repo, 'reused.txt', 'former tracked\n'); write(repo, 'binary.bin', Buffer.from([0, 1, 2]));
    git(repo, 'add', '--all'); git(repo, 'commit', '-m', 'base'); const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'mv', 'old.txt', 'new.txt'); git(repo, 'rm', 'deleted.txt'); git(repo, 'rm', '--cached', 'reused.txt');
    write(repo, 'reused.txt', 'new untracked\n'); write(repo, 'tracked.txt', 'base\nchanged\n'); write(repo, 'added.txt', 'added\n');
    git(repo, 'add', 'added.txt'); write(repo, 'untracked 中文 [x].txt', 'untracked\n');
    write(repo, 'binary.bin', Buffer.from([0, 4, 5])); write(repo, 'untracked.bin', Buffer.from([0, 6, 7]));
    git(repo, 'stash', 'push', '-u', '-m', 'snapshot variants');
    const entry = (await listStashes(service, repo))[0], stashState = git(repo, 'stash', 'list'), index = git(repo, 'write-tree');
    const preview = await previewStash(service, repo, entry), untrackedRef = git(repo, 'rev-parse', entry.oid + '^3');
    assert.equal(preview.files.filter(file => file.path === 'reused.txt').length, 2, 'tracked deletion and untracked addition retain separate snapshots');
    assert.equal(preview.files.find(file => file.path === 'new.txt').oldPath, 'old.txt');
    assert.equal(preview.files.find(file => file.path === 'untracked 中文 [x].txt').ref, untrackedRef);
    const context = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
    registerRevisionCompare(context, service); registerStashFeatures(context, service, { pickRepository: async () => repo });
    const content = providers.get('gitpeek-compare');
    for (const file of preview.files) {
      choose = items => items.find(item => item.entry) ?? items.find(item => item.action === 'preview') ?? items.find(item => item.file.path === file.path && item.file.untracked === file.untracked);
      await commands.get('gitpeek.stash')();
      const diff = diffs.at(-1), left = JSON.parse(diff[0].query).content, right = JSON.parse(diff[1].query).content;
      assert.equal(right.ref, file.untracked ? untrackedRef : entry.oid);
      assert.equal(left.ref, file.untracked ? untrackedRef : base);
      const before = await content.provideTextDocumentContent(diff[0]), after = await content.provideTextDocumentContent(diff[1]);
      if (file.status === 'A') assert.equal(before, '');
      if (file.status === 'D') assert.equal(after, '');
      if (file.status === 'R') { assert.equal(before, 'rename\n'); assert.equal(after, 'rename\n'); }
      if (file.path === 'tracked.txt') { assert.equal(before, 'base\n'); assert.equal(after, 'base\nchanged\n'); }
      if (file.path === 'reused.txt' && file.untracked) assert.equal(after, 'new untracked\n');
      if (file.path === 'reused.txt' && !file.untracked) assert.equal(before, 'former tracked\n');
      if (file.binary) { assert.match(after, /二进制/); assert.match(diff[2], /二进制文件/); }
    }
    assert.equal(git(repo, 'stash', 'list'), stashState); assert.equal(git(repo, 'write-tree'), index);
    assert.equal(git(repo, 'status', '--porcelain'), '', 'preview leaves worktree, index and stash untouched');
    const stableDiff = diffs[0], stableText = await content.provideTextDocumentContent(stableDiff[1]);
    for (let i = 0; i < 34; i++) await commands.get('gitpeek.internal.compare.stash')(repo, entry, 'tracked.txt');
    assert.equal(await content.provideTextDocumentContent(stableDiff[1]), stableText, 'evicted stash content reloads its immutable hash');

    git(repo, 'mv', 'tracked.txt', 'current.txt'); git(repo, 'commit', '-m', 'rename current file');
    write(repo, 'tracked.txt', 'unrelated reused name\n'); git(repo, 'add', 'tracked.txt'); git(repo, 'commit', '-m', 'reuse historical path');
    const target = { repo, hash: base, file: 'tracked.txt', workspacePath: 'current.txt' };
    write(repo, 'current.txt', 'disk changes\n'); const workingIndex = git(repo, 'write-tree');
    const document = { uri: vscode.Uri.file(process.platform === 'win32' ? path.join(repo.root, 'current.txt').toLowerCase() : path.join(repo.root, 'current.txt')), isDirty: true, getText: () => 'unsaved captured\n', save: () => assert.fail('comparison cannot save') };
    vscode.workspace.textDocuments = [document];
    let release, reached; const barrier = new Promise(resolve => release = resolve), started = new Promise(resolve => reached = resolve);
    const delayed = new GitService(), run = delayed.run.bind(delayed);
    delayed.run = async (repository, args, options) => { if (args[0] === 'rev-parse') { reached(); await barrier; } return run(repository, args, options); };
    const pending = workingContents(delayed, target); await started; document.getText = () => 'later editor text\n'; release();
    const captured = await pending; assert.equal(captured.after, 'unsaved captured\n'); assert.match(captured.source, /未保存/);
    assert.equal(fs.readFileSync(path.join(repo.root, 'current.txt'), 'utf8'), 'disk changes\n');
    await commands.get('gitpeek.internal.compare.working')({ commitTarget: target });
    const workingDiff = diffs.at(-1); assert.match(workingDiff[2], /编辑器快照（未保存）/);
    assert.equal(await content.provideTextDocumentContent(workingDiff[1]), 'later editor text\n');
    document.isDirty = false; assert.match((await workingContents(service, target)).source, /已保存/);
    vscode.workspace.textDocuments = []; assert.equal((await workingContents(service, target)).after, 'disk changes\n');
    await assert.rejects(workingContents(service, { ...target, workspacePath: 'tracked.txt' }), /无法确认/, 'a reused historic path never replaces verified identity');
    assert.equal(git(repo, 'write-tree'), workingIndex); assert.equal(git(repo, 'stash', 'list'), stashState);

    const details = registerCommitFeatures(context, service), current = git(repo, 'rev-parse', 'HEAD');
    const shifting = new GitService(), shiftingRun = shifting.run.bind(shifting);
    shifting.run = async (repository, args, options) => {
      const result = await shiftingRun(repository, args, options);
      if (args[0] === 'show' && args.includes(base + ':tracked.txt')) git(repo, 'update-ref', 'HEAD', base);
      return result;
    };
    await assert.rejects(workingContents(shifting, target), /HEAD 已变化/, 'a moving HEAD cannot authorize a stale file identity');
    git(repo, 'update-ref', 'HEAD', current);
    await details.showDiff(repo, current, 'tracked.txt', undefined, undefined, { side: 'right', line: 1, text: 'unrelated' });
    assert.equal(visible[1].selection.active.line, 0); assert.ok(visible[1].revealed);
    await details.showDiff(repo, current, 'tracked.txt', undefined, undefined, { side: 'left', line: 1, text: 'unrelated' });
    assert.equal(visible[0].selection, undefined); assert.match(notices.at(-1), /无法确认/, 'invalid search location does not select an unrelated editor');

    const originalRun = service.run.bind(service), call = (command, ...args) => commands.get('gitpeek.internal.compare.' + command)(...args);
    const item = hash => ({ commitTarget: { repo, hash } });
    const rows = () => views.get('gitpeek.comparison').getChildren();
    const hold = predicate => {
      let entered; const reached = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Read request was not reached: ' + predicate)), 5000);
        entered = () => { clearTimeout(timer); resolve(); };
      });
      let signal, waiting = false;
      service.run = async (repository, args, options) => {
        if (waiting || !predicate(args)) return originalRun(repository, args, options);
        waiting = true;
        signal = options.signal; assert.ok(signal instanceof AbortSignal, 'read commands receive the request signal');
        entered();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Read request was not aborted')), 5000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
      };
      return { reached, signal: () => signal, restore: () => service.run = originalRun };
    };
    let held = hold(args => args[0] === 'rev-parse' && args.includes(base + '^{commit}'));
    let cancelled = call('selectCompare', item(base)); await held.reached;
    await call('selectCompare', item(current)); await cancelled;
    assert.ok(held.signal().aborted); assert.equal(rows()[0].description, current.slice(0, 7)); held.restore();
    held = hold(args => args[0] === 'diff' && args.includes('--name-status'));
    cancelled = call('compareSelected', item(base)); await held.reached;
    await call('clear'); await cancelled; assert.ok(held.signal().aborted); assert.match(rows()[0].label, /已清除/); held.restore();

    await call('selectCompare', item(base));
    held = hold(args => args[0] === 'diff' && args.includes('--name-status'));
    cancelled = call('compareSelected', item(current)); await held.reached;
    visibility.get('gitpeek.comparison')({ visible: false }); await cancelled;
    assert.ok(held.signal().aborted); assert.match(rows()[0].label, /已取消/); held.restore();
    visibility.get('gitpeek.comparison')({ visible: true }); await call('compareSelected', item(current));
    const changedFile = rows().find(row => row.contextValue === 'gitpeek.comparisonFile' && row.label.includes('current.txt'));
    held = hold(args => args[0] === 'show' && args.includes(current + ':current.txt'));
    cancelled = call('openDiff', ...changedFile.command.arguments); await held.reached;
    const previousDiffs = diffs.length; await call('working', { commitTarget: target }); await cancelled;
    assert.ok(held.signal().aborted); assert.equal(diffs.length, previousDiffs + 1, 'only the newer Diff is displayed'); held.restore();

    held = hold(args => args[0] === 'rev-parse');
    cancelled = call('working', { commitTarget: target }); await held.reached;
    enabled = false; configurations.forEach(handler => handler({ affectsConfiguration: key => key === 'gitpeek.enabled' })); await cancelled;
    assert.ok(held.signal().aborted); assert.deepEqual(rows(), []); held.restore(); enabled = true;
    held = hold(args => args[0] === 'rev-parse');
    cancelled = call('stash', repo, entry, 'tracked.txt'); await held.reached;
    context.subscriptions.forEach(subscription => subscription.dispose()); await cancelled;
    assert.ok(held.signal().aborted); held.restore();
    assert.deepEqual(errors, []);
    console.log('Stash/snapshot checks passed: tracked/untracked snapshots, same-path D/A, rename/binary, read-only preview, dirty editor capture, disk fallback, identity, Diff location and read cancellation on supersede/clear/hide/disable/dispose.');
  } finally {
    Module._load = originalLoad;
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Test directory escaped temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
