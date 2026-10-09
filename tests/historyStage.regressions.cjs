const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-history-stage-'));
  const originalLoad = Module._load;
  const commands = new Map(), errors = [], warnings = [], shown = [], diffs = [];
  const disposable = { dispose() {} };
  let pick = async items => items[0];
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 }, ThemeIcon: class {},
    StatusBarAlignment: { Left: 1 }, TabInputText: class {}, TabInputTextDiff: class {}, TabInputWebview: class {},
    Uri: { file: fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath }) },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      registerTextDocumentContentProvider: () => disposable, onDidChangeConfiguration: () => disposable, onDidSaveTextDocument: () => disposable },
    window: { tabGroups: { activeTabGroup: {} }, createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
      onDidChangeActiveTextEditor: () => disposable, showQuickPick: async items => pick(items),
      showInformationMessage: async () => {}, showWarningMessage: async text => warnings.push(text), showErrorMessage: async text => errors.push(text) },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable; }, executeCommand: async () => {} },
  };
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const make = name => {
    const repo = { id: name, root: path.join(temp, name) }; fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); return repo;
  };
  const write = (repo, file, text) => fs.writeFileSync(path.join(repo.root, file), text, 'utf8');
  const commit = (repo, message) => { git(repo, 'add', '--all'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  try {
    const sources = ['git/GitService', 'features/selectionHistory', 'features/stageFile', 'features/reviewChanges', 'features/reviewChangesData'];
    await esbuild.build({ entryPoints: sources.map(file => path.join(__dirname, '../src', file + '.ts')), bundle: true, platform: 'node',
      format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (request, parent, main) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { loadSelectionHistory, registerSelectionHistory } = require(path.join(temp, 'features/selectionHistory.cjs'));
    const { registerReviewChanges } = require(path.join(temp, 'features/reviewChanges.cjs'));
    const { loadReviewSnapshot } = require(path.join(temp, 'features/reviewChangesData.cjs'));
    const { updateFileStage } = require(path.join(temp, 'features/stageFile.cjs'));
    const service = new GitService(), repo = make('history');
    const file = '中文 [x].txt', original = 'one\ntwo\nthree\n', changed = 'changed one\ntwo\nthree\n';
    write(repo, file, original); const initial = commit(repo, 'initial');
    write(repo, file, changed); const edit = commit(repo, 'first line changed');
    for (const [set, unset] of [['--assume-unchanged', '--no-assume-unchanged'], ['--skip-worktree', '--no-skip-worktree']]) {
      git(repo, 'update-index', set, file);
      assert.equal((await loadSelectionHistory(service, repo, file, { startLine: 1, endLine: 1 })).commits[0].hash, edit);
      write(repo, file, 'local prefix\n' + changed);
      assert.equal(git(repo, 'status', '--porcelain', '--', file), '', 'status hides the local insertion');
      await assert.rejects(loadSelectionHistory(service, repo, file, { startLine: 2, endLine: 2 }), /未提交/);
      write(repo, file, changed); git(repo, 'update-index', unset, file);
    }
    const crlf = make('crlf'); git(crlf, 'config', 'core.autocrlf', 'true');
    write(crlf, file, changed.replace(/\n/g, '\r\n')); const crlfHead = commit(crlf, 'CRLF checkout');
    assert.equal((await loadSelectionHistory(service, crlf, file, { startLine: 1, endLine: 1 })).commits[0].hash, crlfHead, 'CRLF checkout maps to the same HEAD lines');

    const selection = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
    const document = { uri: vscode.Uri.file(path.join(repo.root, file)), isDirty: false, version: 1, getText() { return fs.readFileSync(this.uri.fsPath, 'utf8'); } };
    const editor = { document, selection };
    vscode.window.activeTextEditor = editor;
    registerSelectionHistory({ subscriptions: [] }, service, { forUri: async () => repo }, async (_repo, hash) => shown.push(hash), async (target, hash, filePath, workspacePath) => diffs.push({ repo: target, hash, filePath, workspacePath }));
    pick = async items => { assert.match(items[0].label, /first line changed/); return items[0]; };
    await commands.get('gitpeek.selectionHistory')(); assert.deepEqual(diffs, [{ repo, hash: edit, filePath: file, workspacePath: file }], 'selection opens the matching historical file directly');
    assert.deepEqual(shown, [], 'known paths skip the commit/file selection step');
    diffs.length = 0;
    git(repo, 'update-index', '--assume-unchanged', file);
    pick = async items => { write(repo, file, 'local prefix\n' + changed); return items[0]; };
    await commands.get('gitpeek.selectionHistory')(); assert.deepEqual(shown, []); assert.deepEqual(errors, [], 'a changed editor snapshot silently invalidates the old picker');
    write(repo, file, changed); git(repo, 'update-index', '--no-assume-unchanged', file);
    pick = async items => { write(repo, 'other.txt', 'new HEAD\n'); commit(repo, 'unrelated HEAD changed'); return items[0]; };
    await commands.get('gitpeek.selectionHistory')(); assert.deepEqual(shown, []); assert.match(errors.pop(), /HEAD 已变化/);
    pick = async () => undefined;
    await commands.get('gitpeek.selectionHistory')(); assert.deepEqual(shown, []); assert.deepEqual(errors, []);
    assert.notEqual(git(repo, 'rev-parse', 'HEAD'), initial);
    assert.deepEqual(diffs, [], 'stale or cancelled selections cannot open a diff');

    const renamed = make('renamed'), oldPath = 'before [x].txt';
    write(renamed, oldPath, original); const oldHash = commit(renamed, 'before rename');
    git(renamed, 'mv', '--', oldPath, file); commit(renamed, 'rename only');
    document.uri = vscode.Uri.file(path.join(renamed.root, file));
    registerSelectionHistory({ subscriptions: [] }, service, { forUri: async () => renamed },
      async (_repo, hash) => shown.push(hash), async (target, hash, filePath, workspacePath) => diffs.push({ repo: target, hash, filePath, workspacePath }));
    pick = async items => items.find(item => item.hash === oldHash);
    await commands.get('gitpeek.selectionHistory')();
    assert.deepEqual(diffs, [{ repo: renamed, hash: oldHash, filePath: oldPath, workspacePath: file }], 'rename history uses its original path and selected repository');
    assert.deepEqual(shown, []);
    document.uri = vscode.Uri.file(path.join(repo.root, file));
    const missingPath = new GitService(), runWithPath = missingPath.run.bind(missingPath);
    missingPath.run = (target, args, options) => args[0] === 'log' && args.includes('--follow') ? Promise.resolve('') : runWithPath(target, args, options);
    registerSelectionHistory({ subscriptions: [] }, missingPath, { forUri: async () => repo },
      async (_repo, hash) => shown.push(hash), async () => assert.fail('an unknown historical path must not be guessed'));
    pick = async items => items[0];
    await commands.get('gitpeek.selectionHistory')();
    assert.deepEqual(shown, [edit], 'unknown paths fall back to commit details');

    vscode.window.activeTextEditor = undefined;
    vscode.workspace.textDocuments = [document];
    const delayed = new GitService(), originalRun = delayed.run.bind(delayed);
    let onRun = () => {};
    delayed.run = async (target, args, options) => { onRun(args); return originalRun(target, args, options); };
    await registerReviewChanges({ subscriptions: [] }, delayed, { forUri: async () => repo });
    const state = async (target, section, path) => (await loadReviewSnapshot(service, target)).groups.find(group => group.section === section).files.find(file => file.path === path);
    write(repo, file, 'disk edit\n');
    let node = { kind: 'file', repo, file: await state(repo, 'unstaged', file) };
    onRun = args => { if (args[0] === 'ls-files') document.isDirty = true; };
    await commands.get('gitpeek.internal.reviewChanges.stage')(node);
    assert.match(errors.pop(), /未保存/); assert.equal(git(repo, 'diff', '--cached', '--name-only'), '', 'new unsaved edits prevent staging disk content');
    document.isDirty = false; onRun = () => {};
    await commands.get('gitpeek.internal.reviewChanges.stage')(node); assert.equal(git(repo, 'show', ':' + file), 'disk edit');
    node = { kind: 'file', repo, file: await state(repo, 'staged', file) };
    onRun = args => { if (args[0] === 'rev-parse' && args.includes('--quiet')) document.isDirty = true; };
    await commands.get('gitpeek.internal.reviewChanges.unstage')(node);
    assert.match(errors.pop(), /未保存/); assert.equal(git(repo, 'show', ':' + file), 'disk edit', 'new unsaved edits prevent reset');
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8'), 'disk edit\n');
    document.isDirty = false; onRun = () => {};
    await commands.get('gitpeek.internal.reviewChanges.unstage')(node); assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    document.isDirty = true;
    await commands.get('gitpeek.internal.reviewChanges.stage')({ kind: 'file', repo, file: await state(repo, 'unstaged', file) });
    assert.match(warnings.pop(), /未保存/); assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');

    const empty = make('unborn'); write(empty, 'first.txt', 'disk first\n');
    await updateFileStage(service, empty, await state(empty, 'untracked', 'first.txt'), true);
    const first = await state(empty, 'staged', 'first.txt');
    await assert.rejects(updateFileStage(service, empty, first, false, () => { throw new Error('cancelled'); }), /cancelled/);
    assert.equal(git(empty, 'show', ':first.txt'), 'disk first');
    await updateFileStage(service, empty, first, false);
    assert.equal(git(empty, 'ls-files'), ''); assert.equal(fs.readFileSync(path.join(empty.root, 'first.txt'), 'utf8'), 'disk first\n');
    assert.deepEqual(errors, []);
    console.log('History/Stage regression checks passed: hidden changes, CRLF, stale picker, dirty mutation guards and unborn HEAD.');
  } finally {
    Module._load = originalLoad;
    if (!temp.startsWith(os.tmpdir() + path.sep)) throw new Error('Test directory outside temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
