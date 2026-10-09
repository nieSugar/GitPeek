// Run with: node tests/commit-detail.integration.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, sep } = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-commit-'));
  try {
    const repoPath = join(temp, '临时仓库');
    mkdirSync(repoPath);
    try { git(repoPath, 'init', '-b', 'main'); } catch { git(repoPath, 'init'); git(repoPath, 'checkout', '-b', 'main'); }
    git(repoPath, 'config', 'user.name', 'GitPeek Test');
    git(repoPath, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repoPath, 'before name.txt'), 'before\n', 'utf8');
    writeFileSync(join(repoPath, 'deleted.txt'), 'remove me\n', 'utf8');
    writeFileSync(join(repoPath, 'asset.bin'), Buffer.from([0, 1, 2, 255, 0]));
    git(repoPath, 'add', '--all');
    git(repoPath, 'commit', '-m', 'root commit');
    const rootHash = git(repoPath, 'rev-parse', 'HEAD');

    const compiled = join(temp, 'git-content.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'gitContent.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled });
    const { loadCommitDetail, loadCommitDiffContents, readCommitContent } = require(compiled);
    const serviceOut = join(temp, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: serviceOut });
    const { GitService } = require(serviceOut);
    const gitService = new GitService();
    const repo = { root: repoPath, id: 'temporary-repository' };

    const root = await loadCommitDetail(gitService, repo, rootHash);
    assert.equal(root.files.length, 3);
    const rootText = await loadCommitDiffContents(gitService, repo, root, 'before name.txt');
    assert.equal(rootText.oldContent, '');
    assert.equal(rootText.newContent, 'before\n');
    const rootBinary = await loadCommitDiffContents(gitService, repo, root, 'asset.bin');
    assert.equal(rootBinary.binary, true);
    assert.match(rootBinary.newContent, /二进制文件（提交后）/);

    git(repoPath, 'mv', 'before name.txt', 'renamed name.txt');
    git(repoPath, 'rm', 'deleted.txt');
    writeFileSync(join(repoPath, 'added.txt'), 'brand new\n', 'utf8');
    git(repoPath, 'add', '--all');
    git(repoPath, 'commit', '-m', 'rename add delete');
    const changeHash = git(repoPath, 'rev-parse', 'HEAD');
    const changed = await loadCommitDetail(gitService, repo, changeHash);
    const rename = changed.files.find((file) => file.status === 'R');
    assert.ok(rename);
    assert.equal(rename.oldPath, 'before name.txt');
    assert.equal(rename.path, 'renamed name.txt');
    const renameContent = await loadCommitDiffContents(gitService, repo, changed, rename.path);
    assert.equal(renameContent.oldContent, 'before\n');
    assert.equal(renameContent.newContent, 'before\n');
    assert.equal(await readCommitContent(gitService, repo, { ref: renameContent.parent, file: rename.oldPath }), 'before\n');
    assert.equal(await readCommitContent(gitService, repo, { ref: '', file: 'before name.txt', empty: true }), '');
    await assert.rejects(readCommitContent(gitService, repo, { ref: renameContent.parent, file: 'missing.txt' }), /执行失败/);
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'added.txt')).oldContent, '');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'added.txt')).newContent, 'brand new\n');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'deleted.txt')).oldContent, 'remove me\n');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'deleted.txt')).newContent, '');
    await assert.rejects(loadCommitDiffContents(gitService, repo, changed, 'missing.txt'), /不属于提交/);

    git(repoPath, 'checkout', '-b', 'side');
    writeFileSync(join(repoPath, 'side.txt'), 'side\n', 'utf8');
    git(repoPath, 'add', 'side.txt');
    git(repoPath, 'commit', '-m', 'side change');
    git(repoPath, 'checkout', 'main');
    writeFileSync(join(repoPath, 'main.txt'), 'main\n', 'utf8');
    git(repoPath, 'add', 'main.txt');
    git(repoPath, 'commit', '-m', 'main change');
    git(repoPath, 'merge', '--no-ff', 'side', '-m', 'merge change');
    const mergeHash = git(repoPath, 'rev-parse', 'HEAD');
    const merge = await loadCommitDetail(gitService, repo, mergeHash);
    assert.deepEqual(merge.files.map((file) => file.path), ['side.txt']);
    assert.equal((await loadCommitDiffContents(gitService, repo, merge, 'side.txt')).newContent, 'side\n');
    await checkHistoryClicks(temp, gitService, repo);
    console.log('Commit detail integration passed (root, binary, added, deleted, rename, merge first-parent, invalid path).');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function checkHistoryClicks(temp, gitService, repo) {
  const otherRepo = { id: 'other-repository', root: join(temp, 'other-repository') };
  writeFileSync(join(repo.root, 'renamed name.txt'), 'after\n', 'utf8');
  writeFileSync(join(repo.root, 'added.txt'), 'unrelated change\n', 'utf8');
  git(repo.root, 'add', '--all');
  git(repo.root, 'commit', '-m', 'modify multiple files');
  const currentFile = '最终 [name].txt';
  git(repo.root, 'mv', 'renamed name.txt', currentFile);
  git(repo.root, 'commit', '-m', 'rename again');

  const commands = new Map();
  const diffs = [];
  const disposable = { dispose() {} };
  const uri = (fields) => ({ ...fields, toString() { return JSON.stringify(fields); } });
  let contentProvider, changeEditor;
  const activate = async documentUri => {
    vscode.window.activeTextEditor = { document: { uri: documentUri } };
    await changeEditor(vscode.window.activeTextEditor);
  };
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, RelativePattern: class {}, TreeItemCollapsibleState: { None: 0 },
    Uri: { file: (fsPath) => uri({ scheme: 'file', fsPath }), from: uri },
    window: {
      createTreeView: () => disposable,
      activeTextEditor: { document: { uri: uri({ scheme: 'file', fsPath: join(repo.root, currentFile) }) } },
      onDidChangeActiveTextEditor: (handler) => (changeEditor = handler, disposable),
      onDidChangeWindowState: () => disposable,
      showQuickPick: async () => assert.fail('file history must open the diff without a file picker'),
      showInformationMessage: async (message) => assert.fail(message),
      showErrorMessage: async (message) => assert.fail(message),
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      asRelativePath: (uri) => uri.fsPath,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
      onDidSaveTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable,
      registerTextDocumentContentProvider: (_scheme, provider) => (contentProvider = provider, disposable),
    },
    commands: {
      registerCommand: (name, callback) => (commands.set(name, callback), disposable),
      executeCommand: async (name, ...args) => {
        if (name === 'gitpeek.fileHistory.focus') return;
        assert.equal(name, 'vscode.diff');
        diffs.push(args);
        await activate(args[1]);
      },
    },
  };
  const outdir = join(temp, 'history-ui');
  await esbuild.build({ entryPoints: ['history', 'commitDetail'].map((name) => join(__dirname, '..', 'src', 'features', `${name}.ts`)), bundle: true, platform: 'node', format: 'cjs', supported: { 'dynamic-import': false }, external: ['vscode'], outdir, outExtension: { '.js': '.cjs' } });
  const originalLoad = Module._load;
  const context = { subscriptions: [] };
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
    };
    const { registerHistory } = require(join(outdir, 'history.cjs'));
    const { registerCommitFeatures } = require(join(outdir, 'commitDetail.cjs'));
    const commits = registerCommitFeatures(context, gitService);
    const history = await registerHistory(context, gitService, {
      forUri: async uri => uri.fsPath.startsWith(otherRepo.root + sep) ? otherRepo : repo,
    }, commits.showDiff);
    const allRows = await history.provider.getChildren();
    assert.equal(allRows[0].label, currentFile);
    assert.equal(allRows[0].description, basename(repo.root));
    assert.ok(allRows[0].tooltip.includes(repo.root));
    const rows = allRows.filter((row) => row.command);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.command.arguments[2]), [currentFile, 'renamed name.txt', 'renamed name.txt', 'before name.txt']);
    assert.ok(rows.at(-1).tooltip.includes('历史文件：before name.txt'));
    assert.ok(rows.at(-1).tooltip.includes(`当前文件：${currentFile}`));
    const expected = [['after\n', 'after\n'], ['before\n', 'after\n'], ['before\n', 'before\n'], ['', 'before\n']];
    for (const [index, row] of rows.entries()) {
      const { command, arguments: args } = row.command;
      await commands.get(command)(...args);
      assert.equal(diffs.length, index + 1);
      const [before, after, title] = diffs.at(-1);
      assert.equal(await contentProvider.provideTextDocumentContent(before), expected[index][0]);
      assert.equal(await contentProvider.provideTextDocumentContent(after), expected[index][1]);
      assert.equal(JSON.parse(after.query).file, args[2]);
      assert.equal(JSON.parse(after.query).workspacePath, currentFile);
      const parent = JSON.parse(before.query).ref;
      const hash = JSON.parse(after.query).ref;
      assert.ok(title.startsWith(basename(repo.root) + ' · '));
      assert.ok(title.includes(`${parent ? parent.slice(0, 7) : '空文件'} → ${hash.slice(0, 7)}`), 'diff title names both immutable versions');
    }
    assert.equal((await history.provider.getChildren()).length, rows.length + 1, 'diff editors preserve the current file history');
    await commands.get('gitpeek.fileHistory')();
    assert.equal((await history.provider.getChildren())[0].label, currentFile, 'file history command from a diff retains its workspace file');
    mkdirSync(otherRepo.root);
    git(otherRepo.root, 'init', '-b', 'main'); git(otherRepo.root, 'config', 'user.name', 'GitPeek Test'); git(otherRepo.root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(otherRepo.root, currentFile), 'other repository\n', 'utf8');
    git(otherRepo.root, 'add', '--all'); git(otherRepo.root, 'commit', '-m', 'other root');
    const oldDiff = diffs.at(-1)[1];
    await activate(vscode.Uri.file(join(otherRepo.root, currentFile)));
    const otherRows = await history.provider.getChildren();
    assert.equal(otherRows[0].description, basename(otherRepo.root));
    await commands.get(otherRows[1].command.command)(...otherRows[1].command.arguments);
    const otherDiff = diffs.pop()[1];
    await activate(oldDiff);
    assert.equal((await history.provider.getChildren())[0].description, basename(repo.root), 'old diff restores its repository even when another repository has the same filename');
    await activate(otherDiff);
    assert.equal((await history.provider.getChildren())[0].description, basename(otherRepo.root));
    await commands.get('gitpeek.fileHistory')();
    assert.equal((await history.provider.getChildren())[0].description, basename(otherRepo.root), 'file history command in a diff keeps the correct repository');
    for (let index = 0; index < 15; index++) {
      await activate(vscode.Uri.file(join(repo.root, 'added.txt')));
      assert.equal((await history.provider.getChildren())[0].label, 'added.txt');
      await activate(diffs[index % diffs.length][index % 2]);
      assert.equal((await history.provider.getChildren())[0].label, currentFile, 'switching among old diff tabs restores the original file through renames');
    }
    for (const replacement of [{ workspacePath: '../escape.txt' }, { workspacePath: repo.root }, { repoId: 'wrong-repo' }, { root: otherRepo.root }, { workspacePath: undefined }]) {
      await activate(vscode.Uri.file(join(repo.root, 'added.txt')));
      await activate(uri({ ...oldDiff, query: JSON.stringify({ ...JSON.parse(oldDiff.query), ...replacement }) }));
      assert.equal((await history.provider.getChildren())[0].label, 'added.txt', 'invalid diff source metadata cannot replace the current file');
    }
    console.log('File history clicks passed (multi-file commit, two renames, root, 15 tab revisits, version titles, virtual command, source validation, no picker).');
  } finally {
    Module._load = originalLoad;
    for (const subscription of context.subscriptions) subscription.dispose();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
