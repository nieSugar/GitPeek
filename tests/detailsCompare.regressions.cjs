const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-details-compare-'));
  const originalLoad = Module._load;
  const disposable = { dispose() {} };
  const commands = new Map(), views = new Map(), providers = new Map(), executed = [], notices = [];
  const configurationHandlers = [];
  let enabled = true;
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    Uri: { from: value => ({ ...value, toString: () => JSON.stringify(value) }) },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
      onDidChangeConfiguration: handler => (configurationHandlers.push(handler), disposable),
      registerTextDocumentContentProvider: (name, provider) => (providers.set(name, provider), disposable) },
    window: { onDidChangeActiveTextEditor: () => disposable, createTreeView: (name, options) => (views.set(name, options.treeDataProvider), disposable),
      showInformationMessage: async message => notices.push(message), showWarningMessage: async message => notices.push(message),
      showErrorMessage: async message => assert.fail(message), showQuickPick: async () => undefined },
    commands: { registerCommand: (name, handler) => (commands.set(name, handler), disposable),
      executeCommand: async (name, ...args) => commands.has(name) ? commands.get(name)(...args) : executed.push([name, ...args]) },
  };
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (repo, file, value) => fs.writeFileSync(path.join(repo.root, file), value, 'utf8');
  const commit = (repo, message) => { git(repo, 'add', '--all'); git(repo, 'commit', '-m', message); return git(repo, 'rev-parse', 'HEAD'); };
  try {
    const sources = ['git/GitService', 'features/gitContent', 'features/commitDetail', 'features/revisionCompare'];
    await esbuild.build({ entryPoints: sources.map(name => path.join(__dirname, '../src', name + '.ts')), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { resolveWorkspacePaths, loadCommitDetail } = require(path.join(temp, 'features/gitContent.cjs'));
    const { registerCommitFeatures } = require(path.join(temp, 'features/commitDetail.cjs'));
    const { compareRevisions, revisionContents, workingContents, registerRevisionCompare } = require(path.join(temp, 'features/revisionCompare.cjs'));
    const service = new GitService();
    const repo = { id: 'first', root: path.join(temp, 'repo') };
    fs.mkdirSync(repo.root); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false');
    write(repo, '旧 [file].txt', 'original\n'); write(repo, 'deleted.txt', 'deleted\n'); write(repo, 'binary.bin', Buffer.from([0, 1, 2]));
    const root = commit(repo, 'root');
    git(repo, 'mv', '旧 [file].txt', 'middle.txt'); git(repo, 'rm', 'deleted.txt'); write(repo, 'binary.bin', Buffer.from([0, 3, 4]));
    const renamed = commit(repo, 'rename binary delete');
    git(repo, 'mv', 'middle.txt', 'current.txt'); write(repo, '旧 [file].txt', 'unrelated reused old name\n'); write(repo, 'deleted.txt', 'unrelated reused deleted name\n');
    const tip = commit(repo, 'rename again and reuse names');
    const rootDetail = await loadCommitDetail(service, repo, root);
    const mapped = await resolveWorkspacePaths(service, repo, root, rootDetail.files);
    assert.equal(mapped.get('旧 [file].txt'), 'current.txt');
    assert.equal(mapped.has('deleted.txt'), false, 'deletion stops identity tracking even when the name is reused');
    const difference = await compareRevisions(service, repo, root, renamed);
    const binary = difference.files.find(file => file.path === 'binary.bin');
    const committedBinary = await revisionContents(service, repo, difference.left, difference.right, binary);
    assert.notEqual(committedBinary.before, committedBinary.after);
    assert.ok(committedBinary.before.includes(root.slice(0, 7)) && committedBinary.after.includes(renamed.slice(0, 7)));
    const workingBinary = await workingContents(service, { repo, hash: root, file: 'binary.bin' });
    assert.notEqual(workingBinary.before, workingBinary.after);
    assert.match(workingBinary.after, /工作区磁盘/);
    const context = { subscriptions: [] };
    const details = registerCommitFeatures(context, service);
    await details.showCommit(repo, root);
    const detailRows = () => views.get('gitpeek.commitDetails').getChildren();
    const detailFile = detailRows().find(row => row.commitTarget?.file === '旧 [file].txt');
    assert.equal(detailFile.fileTarget.path, 'current.txt');
    assert.equal(detailFile.commitTarget.workspacePath, 'current.txt');
    assert.equal(detailRows().find(row => row.commitTarget?.file === 'deleted.txt').commitTarget.workspacePathKnown, false);
    await commands.get('gitpeek.internal.details.pin')(); await details.showCommit(repo, tip);
    assert.ok(detailRows().some(row => row.label === root));
    await commands.get('gitpeek.internal.details.unpin')(); assert.ok(detailRows().some(row => row.label === tip));

    registerRevisionCompare(context, service);
    const run = (command, ...args) => commands.get('gitpeek.internal.compare.' + command)(...args);
    const target = hash => ({ commitTarget: { repo, hash } });
    await run('selectCompare', target(root)); await run('compareSelected', target(renamed));
    const comparisonRows = () => views.get('gitpeek.comparison').getChildren();
    const comparison = comparisonRows().find(row => row.label === 'R middle.txt');
    assert.equal(comparison.fileTarget.path, 'current.txt', 'comparison files also retain verified current paths');
    await run('openDiff', ...comparison.command.arguments);
    const firstDiff = executed.findLast(([name]) => name === 'vscode.diff');
    const content = providers.get('gitpeek-compare');
    const firstText = await content.provideTextDocumentContent(firstDiff[1]);
    for (let i = 0; i < 34; i++) await run('openDiff', ...comparison.command.arguments);
    assert.equal(await content.provideTextDocumentContent(firstDiff[1]), firstText, 'evicted commit URIs reload the same immutable content');
    const stale = comparison.command.arguments;
    await run('clear'); const beforeStale = executed.length; await run('openDiff', ...stale);
    assert.equal(executed.length, beforeStale, 'cleared comparisons reject old tree commands');
    await run('working', { commitTarget: { repo, hash: root, file: 'deleted.txt', workspacePathKnown: false } });
    assert.match(notices.at(-1), /无法确认/);

    let release, reached;
    const barrier = new Promise(resolve => release = resolve), atShow = new Promise(resolve => reached = resolve);
    const originalRun = service.run.bind(service);
    service.run = async (repository, args, options) => { if (args[0] === 'show' && args[1] === root + ':旧 [file].txt') { reached(); await barrier; } return originalRun(repository, args, options); };
    const beforeDisabled = executed.filter(([name]) => name === 'vscode.diff').length;
    const pending = run('working', { commitTarget: { repo, hash: root, file: '旧 [file].txt', workspacePath: 'current.txt' } });
    await atShow; enabled = false;
    for (const handler of configurationHandlers) handler({ affectsConfiguration: key => key === 'gitpeek.enabled' });
    release(); await pending;
    assert.equal(executed.filter(([name]) => name === 'vscode.diff').length, beforeDisabled, 'disabled async comparisons cannot open new diff editors');
    service.run = originalRun; enabled = true;
    assert.equal(await content.provideTextDocumentContent(firstDiff[1]), firstText, 'existing snapshot URIs remain readable after disable');
    const commitProvider = providers.get('gitpeek-commit');
    await assert.rejects(commitProvider.provideTextDocumentContent(vscode.Uri.from({ query: JSON.stringify({ repoId: repo.id, root: repo.root, ref: '--output=bad', file: 'current.txt' }) })), /URI 无效/);

    git(repo, 'switch', '-c', 'side', root); write(repo, 'side.txt', 'side\n'); const side = commit(repo, 'side');
    git(repo, 'switch', 'main'); git(repo, 'merge', '--no-ff', 'side', '-m', 'merge side');
    assert.equal((await resolveWorkspacePaths(service, repo, side, [{ path: 'side.txt', status: 'A' }])).size, 0, 'non-first-parent origins do not invent mappings');
    console.log('Details/compare regressions passed: verified rename identities, deletion/name reuse, binary references, pin, stale/disabled actions and immutable URI reload.');
  } finally {
    Module._load = originalLoad;
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Test directory escaped temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
