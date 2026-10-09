const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-comparison-layout-'));
  const originalLoad = Module._load;
  const disposable = { dispose() {} };
  const commands = new Map(), contexts = new Map(), executed = [], notices = [], errors = [], configurationHandlers = [];
  let view, enabled = true;
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    Uri: { from: value => ({ ...value, toString: () => JSON.stringify(value) }) },
    workspace: { textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
      onDidChangeConfiguration: handler => (configurationHandlers.push(handler), disposable), registerTextDocumentContentProvider: () => disposable },
    window: { createTreeView: (_name, options) => (view = { ...disposable, ...options }),
      showInformationMessage: async message => notices.push(message), showErrorMessage: async message => errors.push(message) },
    commands: { registerCommand: (name, handler) => (commands.set(name, handler), disposable), executeCommand: async (name, ...args) => {
      executed.push([name, ...args]);
      if (name === 'setContext') contexts.set(args[0], args[1]);
      if (name === 'gitpeek.comparison.focus') assert.equal(contexts.get('gitpeek.hasComparison'), true, 'view is revealed only after its visibility context is set');
    } },
  };
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await esbuild.build({ entryPoints: ['git/GitService', 'features/revisionCompare'].map(name => path.join(__dirname, '../src', name + '.ts')), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    Module._load = function (name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { registerRevisionCompare } = require(path.join(temp, 'features/revisionCompare.cjs'));
    const repo = { id: 'repo', root: path.join(temp, '仓库名称') };
    fs.mkdirSync(repo.root); git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'core.autocrlf', 'false');
    const file = path.join(repo.root, 'file.txt');
    fs.writeFileSync(file, 'before\n', 'utf8'); git(repo, 'add', '--all'); git(repo, 'commit', '-m', '初始版本');
    const start = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(file, 'after\n', 'utf8'); git(repo, 'commit', '-am', '修复边界条件');
    const end = git(repo, 'rev-parse', 'HEAD');
    const service = new GitService();
    registerRevisionCompare({ subscriptions: [] }, service);
    const rows = () => view.treeDataProvider.getChildren();
    const run = (command, ...args) => commands.get('gitpeek.internal.compare.' + command)(...args);
    const target = hash => ({ commitTarget: { repo, hash } });
    const focuses = () => executed.filter(([name]) => name === 'gitpeek.comparison.focus').length;
    assert.equal(contexts.get('gitpeek.hasComparison'), false);
    await run('compareSelected', target(end));
    assert.equal(contexts.get('gitpeek.hasComparison'), false);
    assert.match(notices.at(-1), /先右键/);
    await run('selectCompare', target(start));
    assert.equal(view.description, '仓库名称');
    assert.equal(rows()[0].label, '起点：初始版本');
    assert.equal(rows()[0].description, start.slice(0, 7));
    assert.ok(rows()[0].tooltip.includes(start) && rows()[0].tooltip.includes(repo.root));
    assert.match(rows()[1].label, /右键另一提交/);
    await run('compareSelected', target(end));
    assert.deepEqual(rows().slice(0, 2).map(row => row.label), ['起点：初始版本', '终点：修复边界条件']);
    assert.equal(rows()[1].description, end.slice(0, 7));
    assert.ok(rows()[1].tooltip.includes(end) && rows()[1].tooltip.includes(repo.root));
    assert.equal(rows()[2].label, '1 个变更文件');
    assert.equal(rows()[2].description, '+1 −1');
    const changed = rows().find(row => row.contextValue === 'gitpeek.comparisonFile');
    assert.equal(changed.command.arguments[0].left, start);
    assert.equal(changed.command.arguments[0].right, end, 'row identity and immutable diff direction remain aligned');
    await run('compareSelected', { commitTarget: { repo: { ...repo, root: path.join(temp, 'different') }, hash: end } });
    assert.match(errors.pop(), /不同仓库/);
    await run('compareSelected', target(start));
    assert.equal(rows()[2].label, '0 个变更文件');
    assert.equal(rows()[3].label, '两个提交的文件内容相同。');

    const originalRun = service.run.bind(service);
    const holdSubject = hash => {
      let reached, release;
      const waiting = new Promise(resolve => reached = resolve), barrier = new Promise(resolve => release = resolve);
      service.run = async (repository, args, options) => {
        if (args[0] === 'show' && args.includes('--format=%s') && args.includes(hash)) { reached(); await barrier; }
        return originalRun(repository, args, options);
      };
      return { waiting, release, restore: () => { service.run = originalRun; } };
    };
    let pendingSubject = holdSubject(end);
    const pending = run('selectCompare', target(end));
    await pendingSubject.waiting;
    await run('clear');
    const beforeClear = focuses();
    pendingSubject.release(); await pending; pendingSubject.restore();
    assert.equal(contexts.get('gitpeek.hasComparison'), false);
    assert.equal(view.description, undefined);
    assert.equal(focuses(), beforeClear, 'cleared metadata requests cannot reopen the comparison view');
    assert.equal(rows()[0].label, '比较选择已清除。');

    await run('selectCompare', target(start));
    pendingSubject = holdSubject(end);
    const comparing = run('compareSelected', target(end));
    await pendingSubject.waiting;
    enabled = false;
    for (const handler of configurationHandlers) handler({ affectsConfiguration: key => key === 'gitpeek.enabled' });
    const beforeDisable = focuses();
    pendingSubject.release(); await comparing; pendingSubject.restore();
    assert.equal(contexts.get('gitpeek.hasComparison'), false);
    assert.deepEqual(rows(), []);
    assert.equal(focuses(), beforeDisable, 'disabled metadata requests cannot reopen the view');
    assert.deepEqual(errors, []);
    console.log('Comparison layout passed: readable immutable endpoints, compact repository, visibility lifecycle, same-ID repository guard, empty result and stale metadata requests.');
  } finally {
    Module._load = originalLoad;
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Test directory escaped temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
