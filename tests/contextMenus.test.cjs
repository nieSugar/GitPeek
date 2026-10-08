const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = mkdtempSync(path.join(tmpdir(), 'gitpeek-context-'));
  const originalLoad = Module._load;
  const subscriptions = [];
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const repoA = { id: 'repo-a', root: path.join(temp, 'repo-a') };
    const repoB = { id: 'repo-b', root: path.join(temp, 'repo-b') };
    const file = '菜单 [file].txt';
    mkdirSync(repoA.root);
    git(repoA.root, 'init', '-b', 'main');
    git(repoA.root, 'config', 'user.name', 'GitPeek Test');
    git(repoA.root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(repoA.root, file), 'base\n', 'utf8');
    git(repoA.root, 'add', '--all');
    git(repoA.root, 'commit', '-m', 'base');
    git(repoA.root, 'switch', '-c', 'feature');
    writeFileSync(path.join(repoA.root, file), 'feature\n', 'utf8');
    git(repoA.root, 'commit', '-am', 'feature');
    git(temp, 'clone', '--no-hardlinks', repoA.root, repoB.root);
    git(repoB.root, 'branch', 'main', 'origin/main');
    git(repoB.root, 'config', 'user.name', 'GitPeek Test');
    git(repoB.root, 'config', 'user.email', 'test@example.invalid');
    const hash = git(repoA.root, 'rev-parse', 'HEAD');
    const commands = new Map(), messages = [], copied = [], opened = [], shown = [], warnings = [], info = [], errors = [];
    const disposable = { dispose() {} };
    let receive, selectedRepo = repoA, enabled = true, warningAnswer;
    let picks = 0;
    const uri = fields => ({ ...fields, toString() { return JSON.stringify(fields); } });
    const panel = {
      reveal() {}, onDidDispose: () => disposable, onDidChangeViewState: () => disposable,
      webview: { postMessage: async message => messages.push(message), onDidReceiveMessage: handler => { receive = handler; return disposable; } },
    };
    const vscode = {
      EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
      TreeItem: class { constructor(label) { this.label = label; } },
      ThemeIcon: class {}, RelativePattern: class {}, TabInputText: class {}, TabInputTextDiff: class {}, TabInputWebview: class {},
      TreeItemCollapsibleState: { None: 0, Expanded: 2 }, StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: -1 }, QuickPickItemKind: { Separator: -1 },
      FileType: { File: 1, Directory: 2 }, FileSystemError: class extends Error {},
      Uri: { file: fsPath => uri({ scheme: 'file', fsPath }), from: uri },
      env: { clipboard: { writeText: async value => copied.push(value) } },
      window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: {} },
        onDidChangeActiveTextEditor: () => disposable, onDidChangeWindowState: () => disposable,
        createWebviewPanel: () => panel, createTreeView: () => disposable,
        createStatusBarItem: () => ({ ...disposable, hide() {}, show() {} }),
        showQuickPick: async () => { picks++; },
        showInformationMessage: async message => info.push(message),
        showWarningMessage: async (...args) => { warnings.push(args); return typeof warningAnswer === 'function' ? warningAnswer() : warningAnswer; },
        showErrorMessage: async message => errors.push(message),
      },
      workspace: {
        textDocuments: [],
        fs: { stat: async uri => {
          try { return { type: statSync(uri.fsPath).isDirectory() ? 2 : 1 }; }
          catch (error) { throw Object.assign(new vscode.FileSystemError(error.message), { code: error.code === 'ENOENT' ? 'FileNotFound' : error.code }); }
        } },
        getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : key === 'baseBranch' ? 'main' : fallback }),
        asRelativePath: value => value.fsPath,
        createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
        onDidSaveTextDocument: () => disposable, onDidChangeConfiguration: () => disposable,
        registerTextDocumentContentProvider: () => disposable,
      },
      commands: {
        registerCommand: (name, callback) => { assert.ok(!commands.has(name), name); commands.set(name, callback); return disposable; },
        executeCommand: async (name, ...args) => commands.has(name) ? commands.get(name)(...args) : opened.push([name, ...args]),
      },
    };
    const names = ['commitGraph', 'history', 'sidebar', 'branchCompare', 'reviewChanges', 'commitDetail', 'revisionCompare', 'selectionHistory'];
    await esbuild.build({ entryPoints: [...names.map(name => path.join(__dirname, '..', 'src', 'features', `${name}.ts`)), path.join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', supported: { 'dynamic-import': false }, external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    const { GitService } = require(path.join(temp, 'git', 'GitService.cjs'));
    const feature = name => require(path.join(temp, 'features', `${name}.cjs`));
    const service = new GitService();
    const repositories = {
      forUri: async value => [repoA, repoB].find(repo => value.fsPath.startsWith(repo.root + path.sep)),
      pickRepository: async () => selectedRepo,
    };
    const context = { subscriptions };
    feature('commitDetail').registerCommitFeatures(context, service);
    feature('revisionCompare').registerRevisionCompare(context, service);
    feature('selectionHistory').registerSelectionHistory(context, service, repositories, async () => {});
    const showCommit = async (...args) => shown.push(args);
    const graph = feature('commitGraph').registerCommitGraph(context, service, repositories, showCommit);
    const history = await feature('history').registerHistory(context, service, repositories, async (...args) => opened.push(['historyDiff', ...args]));
    const review = await feature('reviewChanges').registerReviewChanges(context, service, repositories);
    feature('sidebar').registerSidebar(context, history, review.sidebar, showCommit);
    const branch = feature('branchCompare').registerBranchCompare(context, service, repositories, showCommit);
    const run = (name, ...args) => { assert.ok(commands.has(name), name); return commands.get(name)(...args); };

    await run('gitpeek.showCommitGraph');
    receive({ type: 'ready' });
    await graph.refresh();
    const graphTarget = () => {
      const render = messages.findLast(message => message.type === 'render');
      return { gitpeekGraphRepoId: render.repoId, gitpeekGraphGeneration: render.generation, gitpeekCommitHash: hash };
    };
    const targetA = graphTarget();
    await run('gitpeek.internal.graph.copy', targetA);
    assert.equal(copied.at(-1), hash);
    await run('gitpeek.internal.graph.commit', targetA);
    assert.deepEqual(shown.at(-1), [repoA, hash]);
    for (const action of ['checkout', 'cherryPick']) await run(`gitpeek.internal.graph.${action}`, targetA);
    assert.equal(warnings.length, 2, 'native actions retain confirmation');
    assert.equal(picks, 0, 'native menu actions do not open a second action picker');
    assert.equal(git(repoA.root, 'branch', '--show-current'), 'feature', 'cancel preserves branch');
    assert.equal(git(repoA.root, 'rev-parse', 'HEAD'), hash, 'cancel preserves HEAD');
    warningAnswer = async () => { await graph.refresh(); return '检出'; };
    await run('gitpeek.internal.graph.checkout', targetA);
    assert.equal(git(repoA.root, 'branch', '--show-current'), 'feature', 'refresh during confirmation invalidates the operation');
    const count = copied.length;
    await run('gitpeek.internal.graph.copy', targetA);
    await run('gitpeek.internal.graph.copy', { ...graphTarget(), gitpeekCommitHash: 'f'.repeat(40) });
    assert.equal(copied.length, count, 'stale and unknown commits are rejected');
    selectedRepo = repoB;
    await run('gitpeek.showCommitGraph');
    await run('gitpeek.internal.graph.copy', { ...graphTarget(), gitpeekGraphRepoId: repoA.id });
    assert.equal(copied.length, count, 'the same hash in another repository cannot reuse a menu');
    enabled = false;
    await run('gitpeek.internal.graph.copy', graphTarget());
    assert.equal(copied.length, count, 'disabled graph rejects actions');
    enabled = true;
    await run('gitpeek.internal.graph.commit', graphTarget());
    assert.deepEqual(shown.at(-1), [repoB, hash]);

    vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file(path.join(repoA.root, file)) } };
    const targetUri = vscode.Uri.file(path.join(repoB.root, file));
    await run('gitpeek.fileHistory', targetUri);
    const historyItem = (await history.provider.getChildren()).find(item => item.contextValue === 'gitpeek.historyCommit');
    assert.ok(historyItem);
    await run('gitpeek.internal.tree.openDiff', historyItem);
    assert.deepEqual(opened.at(-1), ['historyDiff', repoB, hash, file]);
    await run('gitpeek.internal.tree.showCommit', historyItem);
    assert.deepEqual(shown.at(-1), [repoB, hash]);
    await run('gitpeek.internal.tree.copyHash', historyItem);
    assert.equal(copied.at(-1), hash);
    for (const item of [historyItem, (await history.provider.getChildren())[0]]) {
      await run('gitpeek.internal.file.open', item);
      assert.equal(opened.at(-1)[0], 'vscode.open');
      assert.equal(opened.at(-1)[1].fsPath, path.join(repoB.root, file));
      assert.equal(opened.at(-1)[2].preview, false);
      await run('gitpeek.internal.file.copyRelativePath', item);
      assert.equal(copied.at(-1), file);
    }
    await run('gitpeek.compareWithBase', targetUri);
    assert.equal(branch.summary.repo.id, repoB.id, 'Explorer comparison uses the clicked file, not the active editor');
    const commitItem = branch.items.find(item => item.contextValue === 'gitpeek.branchCommit');
    const fileItem = branch.items.find(item => item.contextValue === 'gitpeek.branchFile');
    assert.ok(commitItem && fileItem);
    await run('gitpeek.internal.tree.showCommit', commitItem);
    assert.deepEqual(shown.at(-1), [repoB, hash]);
    await run('gitpeek.internal.tree.openDiff', fileItem);
    assert.equal(opened.at(-1)[0], 'vscode.diff');
    assert.equal(JSON.parse(opened.at(-1)[2].query).repoId, repoB.id);
    await run('gitpeek.internal.file.open', fileItem);
    assert.equal(opened.at(-1)[1].fsPath, path.join(repoB.root, file));
    await run('gitpeek.internal.file.copyRelativePath', fileItem);
    assert.equal(copied.at(-1), file);

    writeFileSync(path.join(repoB.root, file), 'staged\n', 'utf8');
    git(repoB.root, 'add', '--all');
    writeFileSync(path.join(repoB.root, file), 'working\n', 'utf8');
    writeFileSync(path.join(repoB.root, 'new.txt'), 'untracked\n', 'utf8');
    await review.refresh(repoB);
    for (const group of review.sidebar.getChildren()) {
      const node = review.sidebar.getChildren(group)[0];
      assert.ok(node);
      assert.equal(review.sidebar.getTreeItem(node).contextValue, `gitpeek.review.${group.section}`);
      await run('gitpeek.internal.reviewChanges.openFromContext', node);
      const ref = JSON.parse(opened.at(-1)[2].query);
      assert.equal(ref.repoId, repoB.id);
      assert.equal(ref.section, group.section, 'right-click retains staged/unstaged/untracked identity');
      await run('gitpeek.internal.file.open', node);
      assert.equal(opened.at(-1)[1].fsPath, path.join(repoB.root, node.file.path));
      await run('gitpeek.internal.file.copyRelativePath', node);
      assert.equal(copied.at(-1), node.file.path);
    }

    git(repoB.root, 'add', '--all');
    git(repoB.root, 'commit', '-m', 'review fixtures');
    mkdirSync(path.join(repoB.root, '中文目录'));
    const renamed = '中文目录/当前 文件.txt';
    git(repoB.root, 'mv', '--', file, renamed);
    git(repoB.root, 'commit', '-m', 'rename file');
    await run('gitpeek.fileHistory', vscode.Uri.file(path.join(repoB.root, renamed)));
    const oldCommitItem = (await history.provider.getChildren()).find(item => item.command?.arguments?.[2] === file);
    assert.ok(oldCommitItem, 'history retains the old commit path for diffs');
    await run('gitpeek.internal.file.open', oldCommitItem);
    assert.equal(opened.at(-1)[1].fsPath, path.join(repoB.root, renamed), 'old history entries open the current workspace path');
    await run('gitpeek.internal.file.copyRelativePath', oldCommitItem);
    assert.equal(copied.at(-1), renamed, 'copied path is repo-relative, using forward slashes');
    unlinkSync(path.join(repoB.root, renamed));
    writeFileSync(path.join(repoB.root, file), 'unrelated file reusing the old name\n', 'utf8');
    const beforeMissing = opened.length;
    await run('gitpeek.internal.file.open', oldCommitItem);
    assert.equal(opened.length, beforeMissing, 'missing files do not create editors or open a reused old name');
    assert.ok(info.at(-1).includes(renamed) && info.at(-1).includes('不存在'));
    await run('gitpeek.internal.file.copyRelativePath', oldCommitItem);
    assert.equal(copied.at(-1), renamed, 'deleted file paths can still be copied');
    await run('gitpeek.internal.file.open', { fileTarget: { repo: repoB, path: '中文目录' } });
    assert.equal(opened.length, beforeMissing);
    assert.match(info.at(-1), /目录/);
    assert.deepEqual(errors, []);
    await run('gitpeek.internal.file.open', { fileTarget: { repo: repoB, path: '../outside.txt' } });
    assert.equal(opened.length, beforeMissing);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /不在所选仓库/);
    const beforeDisabledCopy = copied.length;
    enabled = false;
    await run('gitpeek.internal.file.open', fileItem);
    await run('gitpeek.internal.file.copyRelativePath', fileItem);
    enabled = true;
    assert.equal(copied.length, beforeDisabledCopy);
    assert.equal(opened.length, beforeMissing);
    const openedCount = opened.length;
    await run('gitpeek.internal.tree.openDiff', new vscode.TreeItem('加载更多'));
    await run('gitpeek.internal.reviewChanges.openFromContext', { kind: 'message' });
    await run('gitpeek.internal.file.open', new vscode.TreeItem('加载更多'));
    await run('gitpeek.internal.file.copyRelativePath', { kind: 'message' });
    assert.equal(opened.length, openedCount, 'non-action rows do not dispatch operations');

    const { contributes } = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const menuCommands = contributes.commands.filter(item => item.command.startsWith('gitpeek.internal.'));
    for (const { command } of menuCommands) {
      assert.ok(commands.has(command), `menu command is registered: ${command}`);
      assert.ok(contributes.menus.commandPalette.some(item => item.command === command && item.when === 'false'));
    }
    assert.equal(contributes.commands.length - menuCommands.length, 11, 'only selection history adds a public command');
    assert.equal(contributes.menus['webview/context'].length, 6);
    assert.equal(contributes.commands.find(item => item.command === 'gitpeek.refresh').icon, '$(refresh)');
    assert.ok(contributes.menus['view/title'].some(item => item.command === 'gitpeek.refresh' && item.group.startsWith('navigation')));
    for (const item of contributes.menus['webview/context']) assert.match(item.when, /webviewId == gitpeek.commitGraph && webviewSection == commit/);
    console.log('Context menus passed (graph actions, cancellation, tree nodes, multi-repository file actions, rename/deletion, review sections and refresh entry).');
  } finally {
    Module._load = originalLoad;
    for (const item of subscriptions) item.dispose();
    if (!temp.startsWith(tmpdir() + path.sep)) throw new Error('Context test directory escaped temp directory');
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
