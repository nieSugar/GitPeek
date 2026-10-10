const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-workflows-'));
  const originalLoad = Module._load;
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const make = name => {
    const repo = { root: path.join(temp, name), id: name }; fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', '作者'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); return repo;
  };
  const write = (repo, file, text) => { const full = path.join(repo.root, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text, 'utf8'); };
  const commit = (repo, message) => { git(repo, 'add', '--all'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  const commands = new Map(), views = new Map(), providers = new Map(), executed = [], errors = [], info = [];
  const disposable = { dispose() {} };
  let enabled = true;
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    Uri: { file: fsPath => ({ scheme: 'file', fsPath, toString: () => fsPath }), from: values => ({ ...values, toString: () => JSON.stringify(values) }) },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
      onDidChangeConfiguration: () => disposable, registerTextDocumentContentProvider: (name, provider) => { providers.set(name, provider); return disposable; } },
    window: { onDidChangeActiveTextEditor: () => disposable, createTreeView: (name, options) => { views.set(name, options.treeDataProvider); return disposable; },
      showInformationMessage: async text => info.push(text), showWarningMessage: async text => info.push(text), showErrorMessage: async text => errors.push(text),
      showQuickPick: async () => undefined },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable; },
      executeCommand: async (name, ...args) => commands.has(name) ? commands.get(name)(...args) : executed.push([name, ...args]) },
  };
  try {
    const sources = ['git/GitService', 'features/commitDetail', 'features/commitGraphData', 'features/revisionCompare', 'features/selectionHistory', 'features/stageFile', 'features/reviewChangesData'];
    await esbuild.build({ entryPoints: sources.map(f => path.join(__dirname, '../src', f + '.ts')), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (request, parent, main) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { registerCommitFeatures } = require(path.join(temp, 'features/commitDetail.cjs'));
    const { loadGraph } = require(path.join(temp, 'features/commitGraphData.cjs'));
    const { compareRevisions, revisionContents, workingContents, registerRevisionCompare } = require(path.join(temp, 'features/revisionCompare.cjs'));
    const { loadSelectionHistory } = require(path.join(temp, 'features/selectionHistory.cjs'));
    const { updateFileStage } = require(path.join(temp, 'features/stageFile.cjs'));
    const { loadReviewSnapshot } = require(path.join(temp, 'features/reviewChangesData.cjs'));
    const service = new GitService();
    const repo = make('repo'), other = make('other');
    const old = '旧 文件 [x].txt', file = '新 文件 [x].txt';
    write(repo, old, 'one\ntwo\nthree\n'); write(repo, 'deleted.txt', 'deleted\n'); write(repo, 'binary.bin', Buffer.from([0, 1, 2]));
    const root = commit(repo, 'initial');
    write(repo, old, 'prefix\none\nchanged\nthree\n'); const edit = commit(repo, 'edit');
    git(repo, 'mv', old, file); const rename = commit(repo, 'rename');
    const range = { startLine: 3, endLine: 3 };
    const lines = await loadSelectionHistory(service, repo, file, range);
    assert.deepEqual(lines.commits.map(c => c.hash), [edit, root]);
    assert.ok(lines.commits.every(c => c.filePath === old), 'line history retains rename-era paths');
    assert.equal((await loadSelectionHistory(service, repo, file, range, 1)).hasMore, true);
    write(repo, file, 'prefix\none\nunsaved on disk\nthree\n');
    await assert.rejects(loadSelectionHistory(service, repo, file, range), /未提交/);
    write(repo, file, 'prefix\none\nchanged\nthree\n');
    git(repo, 'switch', '-c', 'side'); write(repo, file, 'prefix\none\nside edit\nthree\n'); const side = commit(repo, 'side change');
    git(repo, 'switch', 'main'); write(repo, 'main-only.txt', 'main\n'); commit(repo, 'main only');
    const direct = await compareRevisions(service, repo, side, 'HEAD');
    assert.deepEqual(direct.files.map(f => f.path).sort(), [file, 'main-only.txt'].sort());
    const branch = await service.compare(repo, 'side');
    assert.deepEqual(branch.files.map(f => f.path), ['main-only.txt'], 'base comparison retains merge-base semantics');
    git(repo, 'merge', '--no-ff', 'side', '-m', 'merge');
    const merge = git(repo, 'rev-parse', 'HEAD');
    const mergedLines = await loadSelectionHistory(service, repo, file, range);
    assert.equal(mergedLines.commits[0].hash, merge, 'first-parent trace treats merge result as a mainline change');
    assert.ok(!mergedLines.commits.some(c => c.hash === side));
    write(repo, file, 'one\nside edit\nthree\n'); commit(repo, 'delete preceding line');
    const shiftedLines = await loadSelectionHistory(service, repo, file, { startLine: 2, endLine: 2 });
    assert.deepEqual(shiftedLines.commits.map(c => c.hash), mergedLines.commits.map(c => c.hash), 'deleting a preceding line keeps the same code history');
    fs.unlinkSync(path.join(repo.root, 'deleted.txt')); write(repo, 'added.txt', 'added\n');
    write(repo, 'binary.bin', Buffer.from([0, 3, 4])); const tip = commit(repo, 'add delete binary');
    const diff = await compareRevisions(service, repo, root, tip);
    assert.equal((await compareRevisions(service, repo, edit, rename)).files.find(f => f.path === file).status, 'R');
    for (const change of diff.files) {
      const data = await revisionContents(service, repo, diff.left, diff.right, change);
      if (change.status === 'A') assert.equal(data.before, '');
      if (change.status === 'D') assert.equal(data.after, '');
      if (change.path === 'binary.bin') assert.match(data.after, /二进制/);
    }
    const reversed = await compareRevisions(service, repo, tip, root);
    assert.equal(reversed.files.find(f => f.path === 'deleted.txt').status, 'A');
    const working = await workingContents(service, { repo, hash: root, file: old, workspacePath: file });
    assert.equal(working.before, 'one\ntwo\nthree\n'); assert.match(working.after, /side edit/);
    await assert.rejects(workingContents(service, { repo, hash: root, file: old, workspacePath: '../escape' }), /不在仓库/);

    const context = { subscriptions: [] };
    const details = registerCommitFeatures(context, service);
    await details.showCommit(repo, root);
    const provider = views.get('gitpeek.commitDetails');
    assert.ok(provider.getChildren().some(row => row.commitTarget?.hash === root));
    const detailFile = provider.getChildren().find(row => row.contextValue === 'gitpeek.detailFile');
    await commands.get('gitpeek.internal.details.pin')(); await details.showCommit(other, root);
    assert.ok(provider.getChildren().some(row => row.commitTarget?.hash === root), 'pin retains original repository and commit');
    await details.showCommit(repo, tip); await commands.get('gitpeek.internal.details.unpin')();
    assert.ok(provider.getChildren().some(row => row.commitTarget?.hash === tip), 'unpin loads the last selected commit');
    await vscode.commands.executeCommand(detailFile.command.command, ...detailFile.command.arguments);
    assert.equal(executed.at(-1)[0], 'vscode.diff');
    let release; const barrier = new Promise(resolve => release = resolve);
    const delayed = new GitService(); const originalRun = delayed.run.bind(delayed);
    delayed.run = async (r, args, options) => { if (args[0] === 'rev-parse' && args.at(-1) === root + '^{commit}') await barrier; return originalRun(r, args, options); };
    const delayedDetails = registerCommitFeatures({ subscriptions: [] }, delayed);
    const slow = delayedDetails.showCommit(repo, root); await delayedDetails.showCommit(repo, tip); release(); await slow;
    assert.ok(views.get('gitpeek.commitDetails').getChildren().some(row => row.commitTarget?.hash === tip), 'late detail request cannot replace latest');
    registerRevisionCompare(context, service);
    const target = hash => ({ commitTarget: { repo, hash } });
    await commands.get('gitpeek.internal.compare.selectCompare')(target(root));
    await commands.get('gitpeek.internal.compare.compareSelected')(target(tip));
    const comparisonRows = views.get('gitpeek.comparison').getChildren();
    assert.ok(comparisonRows.some(row => row.contextValue === 'gitpeek.comparisonFile'));
    await commands.get('gitpeek.internal.compare.compareSelected')({ commitTarget: { repo: other, hash: root } });
    assert.match(errors.pop(), /不同仓库/);
    await commands.get('gitpeek.internal.compare.clear')();
    await commands.get('gitpeek.internal.compare.compareSelected')(target(tip));
    assert.match(info.at(-1), /先右键/);
    const dirtyPath = path.join(repo.root, file);
    vscode.workspace.textDocuments = [{ uri: vscode.Uri.file(process.platform === 'win32' ? dirtyPath.toLowerCase() : dirtyPath), isDirty: true, getText: () => 'unsaved editor content\n' }];
    const beforeDirty = executed.length;
    await commands.get('gitpeek.internal.compare.working')({ commitTarget: { repo, hash: root, file: old, workspacePath: file } });
    assert.equal(executed.length, beforeDirty + 1); assert.match(executed.at(-1)[3], /编辑器快照（未保存）/);
    assert.equal(await providers.get('gitpeek-compare').provideTextDocumentContent(executed.at(-1)[2]), 'unsaved editor content\n');
    vscode.workspace.textDocuments = [];

    const state = async (r, section, file) => (await loadReviewSnapshot(service, r)).groups.find(g => g.section === section).files.find(f => f.path === file);
    write(repo, file, 'staged content\n');
    await updateFileStage(service, repo, await state(repo, 'unstaged', file), true);
    write(repo, file, 'working content\n');
    assert.equal(git(repo, 'show', ':' + file), 'staged content');
    await updateFileStage(service, repo, await state(repo, 'staged', file), false);
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8'), 'working content\n');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    write(repo, file, working.after);
    git(repo, 'mv', file, 'renamed.txt');
    const stagedRename = await state(repo, 'staged', 'renamed.txt'); assert.equal(stagedRename.status, 'R');
    await updateFileStage(service, repo, stagedRename, false);
    assert.ok(fs.existsSync(path.join(repo.root, 'renamed.txt')));
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    await updateFileStage(service, repo, await state(repo, 'unstaged', file), true);
    assert.ok((await state(repo, 'staged', file)).status === 'D');
    await updateFileStage(service, repo, await state(repo, 'untracked', 'renamed.txt'), true);
    assert.equal((await state(repo, 'staged', 'renamed.txt')).status, 'R');
    write(other, 'first [x].txt', 'first staged\n');
    await updateFileStage(service, other, await state(other, 'untracked', 'first [x].txt'), true);
    write(other, 'first [x].txt', 'first worktree\n');
    await updateFileStage(service, other, await state(other, 'staged', 'first [x].txt'), false);
    assert.equal(git(other, 'ls-files'), '');
    assert.equal(fs.readFileSync(path.join(other.root, 'first [x].txt'), 'utf8'), 'first worktree\n');
    assert.ok(git(repo, 'diff', '--cached', '--name-only'), 'other repository index untouched');
    const stale = await state(other, 'untracked', 'first [x].txt');
    await updateFileStage(service, other, stale, true);
    await assert.rejects(updateFileStage(service, other, stale, true), /状态已变化/);
    const conflicted = make('conflicted');
    write(conflicted, 'conflict.txt', 'base\n'); commit(conflicted, 'base');
    git(conflicted, 'switch', '-c', 'side'); write(conflicted, 'conflict.txt', 'side\n'); commit(conflicted, 'side');
    git(conflicted, 'switch', 'main'); write(conflicted, 'conflict.txt', 'main\n'); commit(conflicted, 'main');
    assert.throws(() => git(conflicted, 'merge', 'side'));
    const conflictNode = await state(conflicted, 'unstaged', 'conflict.txt');
    await assert.rejects(updateFileStage(service, conflicted, conflictNode, true), /冲突/);
    assert.match(fs.readFileSync(path.join(conflicted.root, 'conflict.txt'), 'utf8'), /<<<<<<< HEAD/);

    const long = make('long-history'); const stream = [];
    for (let i = 1; i <= 510; i++) {
      const message = i === 1 ? '远古针眼' : 'ordinary ' + i;
      stream.push(`commit refs/heads/main\nmark :${i}\nauthor ${i === 1 ? 'Ancient Author' : 'Test'} <test@example.invalid> ${1700000000 + i} +0000\ncommitter Test <test@example.invalid> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i > 1 ? 'from :' + (i - 1) + '\n' : ''}M 100644 inline file.txt\ndata 2\nx\n\n`);
    }
    execFileSync('git', ['-C', long.root, 'fast-import', '--quiet'], { input: stream.join(''), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const ancient = git(long, 'rev-list', '--max-parents=0', 'HEAD');
    assert.ok(!(await loadGraph(service, long, 100)).rows.some(row => row.hash === ancient));
    for (const [kind, text] of [['message', '远古针眼'], ['author', 'Ancient Author'], ['hash', ancient.slice(0, 9)]]) {
      const result = await loadGraph(service, long, 100, { kind, text, scope: 'all' });
      assert.deepEqual(result.rows.filter(r => r.hash).map(r => r.hash), [ancient]);
    }
    assert.equal((await loadGraph(service, long, 100, { kind: 'message', text: 'ordinary', scope: 'current' })).hasMore, true);
    assert.equal((await loadGraph(service, long, 600)).rows.filter(r => r.hash).length, 510);
    await assert.rejects(loadGraph(service, long, 100, { kind: 'hash', text: '--all', scope: 'all' }), /十六进制/);
    assert.deepEqual(errors, []);
    console.log('Workflow checks passed: pinned/stale details, >500 history search, snapshot/working comparison, first-parent line history, stage/unstage with rename and unborn HEAD.');
  } finally {
    Module._load = originalLoad;
    if (!temp.startsWith(os.tmpdir() + path.sep)) throw new Error('Test directory outside temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
