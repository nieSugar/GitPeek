const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-batch-view-'));
  const originalLoad = Module._load;
  const subscriptions = [];
  try {
    const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (repo, name, text) => fs.writeFileSync(path.join(repo.root, name), text, 'utf8');
    const make = (name, tracked = []) => {
      const repo = { id: name, root: path.join(temp, name) };
      fs.mkdirSync(repo.root);
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Batch View Test');
      git(repo, 'config', 'user.email', 'batch@example.invalid');
      for (const file of tracked) write(repo, file, 'base\n');
      git(repo, 'add', '--all');
      git(repo, 'commit', '--allow-empty', '-m', 'base');
      return repo;
    };
    const commands = new Map(), views = new Map(), errors = [], warnings = [], executed = [];
    const disposable = { dispose() {} };
    let enabled = true;
    let fireCount = 0;
    const uri = fields => ({ ...fields, toString: () => JSON.stringify(fields) });
    const vscode = {
      EventEmitter: class { event = () => disposable; fire() { fireCount++; } dispose() {} },
      TreeItem: class { constructor(label) { this.label = label; } }, ThemeIcon: class {},
      TabInputText: class {}, TabInputTextDiff: class {}, TabInputWebview: class {},
      TreeItemCollapsibleState: { None: 0, Expanded: 2 }, StatusBarAlignment: { Left: 1 }, QuickPickItemKind: { Separator: -1 },
      Uri: { file: fsPath => uri({ scheme: 'file', fsPath }), from: uri },
      env: { clipboard: { writeText: async () => {} } },
      window: {
        activeTextEditor: undefined, tabGroups: { activeTabGroup: {} },
        createStatusBarItem: () => ({ ...disposable, hide() {}, show() {} }),
        createTreeView: (id, options) => { views.set(id, options); return disposable; },
        onDidChangeActiveTextEditor: () => disposable,
        showInformationMessage: async message => warnings.push(message),
        showWarningMessage: async message => warnings.push(message),
        showErrorMessage: async message => errors.push(message),
      },
      workspace: {
        textDocuments: [],
        getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : fallback }),
        registerTextDocumentContentProvider: () => disposable,
        onDidChangeConfiguration: () => disposable, onDidSaveTextDocument: () => disposable,
      },
      commands: {
        registerCommand: (name, callback) => { assert.ok(!commands.has(name), name); commands.set(name, callback); return disposable; },
        executeCommand: async (name, ...args) => { executed.push([name, ...args]); if (commands.has(name)) return commands.get(name)(...args); },
      },
    };
    await esbuild.build({
      entryPoints: ['features/reviewChanges', 'features/sidebar', 'git/GitService'].map(name => path.join(__dirname, '../src', name + '.ts')),
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' },
    });
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
    const service = new (require(path.join(temp, 'git/GitService.cjs')).GitService)();
    const feature = await require(path.join(temp, 'features/reviewChanges.cjs')).registerReviewChanges({ subscriptions }, service, { forUri: async () => undefined });
    require(path.join(temp, 'features/sidebar.cjs')).registerSidebar({ subscriptions }, { provider: {}, refresh() {} }, feature.sidebar, async () => {});
    assert.equal(views.get('gitpeek.changes').canSelectMany, true, 'the real sidebar accepts multiple file selections');
    const run = (action, ...args) => {
      const name = 'gitpeek.internal.reviewChanges.' + action;
      assert.ok(commands.has(name), name);
      return commands.get(name)(...args);
    };
    const group = section => feature.sidebar.getChildren().find(node => node.kind === 'section' && node.section === section);
    const files = section => feature.sidebar.getChildren(group(section));
    const node = (section, file) => { const selected = files(section).find(node => node.file.path === file); assert.ok(selected, `${section}: ${file}`); return selected; };
    const index = repo => git(repo, 'ls-files', '--stage', '-z');
    const disk = (repo, file) => fs.readFileSync(path.join(repo.root, file), 'utf8');
    const assertRejected = async (repo, action, ...args) => {
      const before = index(repo), feedback = errors.length + warnings.length;
      await run(action, ...args);
      assert.equal(index(repo), before, `${action} rejected the whole selection without partial index changes`);
      assert.ok(errors.length + warnings.length > feedback, `${action} explains why the selection was rejected`);
    };

    const repo = make('selected', ['tracked [x].txt', 'outside.txt']);
    write(repo, 'tracked [x].txt', 'tracked work\n'); write(repo, 'outside.txt', 'outside work\n'); write(repo, '新文件.txt', 'new work\n');
    await feature.refresh(repo);
    const first = node('unstaged', 'tracked [x].txt'), second = node('untracked', '新文件.txt');
    const beforeFire = fireCount;
    await run('stage', first, [first, second]);
    assert.equal(git(repo, 'show', ':tracked [x].txt'), 'tracked work');
    assert.equal(git(repo, 'show', ':新文件.txt'), 'new work', 'the command uses its second selection argument');
    assert.equal(git(repo, 'show', ':outside.txt'), 'base', 'unselected tracked changes remain outside index');
    assert.deepEqual(files('staged').map(node => node.file.path).sort(), ['tracked [x].txt', '新文件.txt']);
    assert.ok(fireCount > beforeFire, 'successful staging refreshes the sidebar');
    assert.ok(executed.some(([command]) => command === 'gitpeek.refresh'), 'successful staging refreshes the other GitPeek contexts');
    const staged = files('staged');
    write(repo, 'tracked [x].txt', 'newer disk\n');
    await run('unstage', staged[0], staged);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.equal(disk(repo, 'tracked [x].txt'), 'newer disk\n', 'batch unstage preserves newer worktree contents');
    assert.equal(disk(repo, '新文件.txt'), 'new work\n');
    assert.ok(node('untracked', '新文件.txt'), 'refreshed sidebar restores newly added files to untracked');

    const grouped = make('grouped', ['first.txt', 'second.txt', 'already.txt']);
    write(grouped, 'first.txt', 'first work\n'); write(grouped, 'second.txt', 'second work\n');
    write(grouped, 'already.txt', 'already staged\n'); git(grouped, 'add', '--', 'already.txt');
    write(grouped, 'untracked.txt', 'untracked work\n');
    await feature.refresh(grouped);
    const oldUnstagedGroup = group('unstaged');
    assert.equal(feature.sidebar.getTreeItem(oldUnstagedGroup).contextValue, 'gitpeek.reviewGroup.unstaged');
    await run('stageGroup', oldUnstagedGroup);
    assert.deepEqual(files('unstaged'), [], 'group staging refreshes the now-empty group');
    assert.notEqual(group('unstaged').snapshot, oldUnstagedGroup.snapshot, 'the refreshed group uses the new snapshot');
    assert.equal(git(grouped, 'show', ':already.txt'), 'already staged');
    assert.throws(() => git(grouped, 'show', ':untracked.txt'), 'unstaged group staging excludes untracked files');
    assert.equal(feature.sidebar.getTreeItem(group('untracked')).contextValue, 'gitpeek.reviewGroup.untracked');
    await run('stageGroup', group('untracked'));
    assert.equal(git(grouped, 'show', ':untracked.txt'), 'untracked work');
    assert.equal(feature.sidebar.getTreeItem(group('staged')).contextValue, 'gitpeek.reviewGroup.staged');
    await assertRejected(grouped, 'stageGroup', group('staged'));
    await assertRejected(grouped, 'unstageGroup', group('unstaged'));
    await run('unstageGroup', group('staged'));
    assert.equal(git(grouped, 'diff', '--cached', '--name-only'), '');
    assert.equal(disk(grouped, 'first.txt'), 'first work\n');
    assert.equal(disk(grouped, 'untracked.txt'), 'untracked work\n');

    const guarded = make('guarded', ['tracked.txt']);
    write(guarded, 'tracked.txt', 'work\n'); write(guarded, 'first.txt', 'first\n'); write(guarded, 'second.txt', 'second\n');
    await feature.refresh(guarded);
    const dirtyFirst = node('untracked', 'first.txt'), dirtySecond = node('untracked', 'second.txt');
    const dirtySecondPath = path.join(guarded.root, 'second.txt');
    vscode.workspace.textDocuments = [{ uri: vscode.Uri.file(process.platform === 'win32' ? dirtySecondPath.toLowerCase() : dirtySecondPath), isDirty: true }];
    await assertRejected(guarded, 'stage', dirtyFirst, [dirtyFirst, dirtySecond]);
    await assertRejected(guarded, 'stageGroup', group('untracked'));
    vscode.workspace.textDocuments = [];
    git(guarded, 'add', '--', 'second.txt');
    const beforeStale = index(guarded);
    await assertRejected(guarded, 'stage', dirtyFirst, [dirtyFirst, dirtySecond]);
    assert.equal(index(guarded), beforeStale, 'a stale later file cannot leave the earlier one staged');
    assert.throws(() => git(guarded, 'show', ':first.txt'));
    await feature.refresh(guarded);
    await assertRejected(guarded, 'stage', node('untracked', 'first.txt'), [node('untracked', 'first.txt'), node('staged', 'second.txt')]);
    await assertRejected(guarded, 'unstage', node('staged', 'second.txt'), [node('staged', 'second.txt'), node('unstaged', 'tracked.txt')]);
    const other = make('other'); write(other, 'other.txt', 'other\n');
    await feature.refresh(other);
    const otherNode = node('untracked', 'other.txt'), otherIndex = index(other);
    await feature.refresh(guarded);
    await assertRejected(guarded, 'stage', node('untracked', 'first.txt'), [node('untracked', 'first.txt'), otherNode]);
    assert.equal(index(other), otherIndex, 'a mixed-repository selection touches neither repository');
    enabled = false;
    const disabledBefore = index(guarded);
    await run('stage', node('untracked', 'first.txt'), [node('untracked', 'first.txt')]);
    await run('stageGroup', group('untracked'));
    await run('unstageGroup', group('staged'));
    assert.equal(index(guarded), disabledBefore, 'disabled feature blocks file and group mutations');
    enabled = true;

    const originalRun = service.run.bind(service);
    let disableDuringValidation = true;
    service.run = async (repository, args, options) => {
      const result = await originalRun(repository, args, options);
      if (disableDuringValidation && args[0] === 'ls-files' && args.includes('--unmerged')) { disableDuringValidation = false; enabled = false; }
      return result;
    };
    await assertRejected(guarded, 'stage', node('untracked', 'first.txt'), [node('untracked', 'first.txt'), node('unstaged', 'tracked.txt')]);
    enabled = true; service.run = originalRun;

    const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
    const asyncA = make('async-a', ['file.txt']), asyncB = make('async-b', ['file.txt']);
    write(asyncA, 'file.txt', 'A work\n'); write(asyncB, 'file.txt', 'B work\n');
    const refreshEntered = deferred(), releaseRefresh = deferred();
    let holdRefresh = true;
    service.run = async (repository, args, options) => {
      if (holdRefresh && repository.id === asyncA.id && args[0] === 'status') {
        holdRefresh = false; refreshEntered.resolve(); await releaseRefresh.promise;
      }
      return originalRun(repository, args, options);
    };
    const obsoleteRefresh = feature.refresh(asyncA);
    await refreshEntered.promise;
    await feature.refresh(asyncB);
    releaseRefresh.resolve();
    assert.equal(await obsoleteRefresh, undefined, 'an obsolete refresh does not return another repository snapshot');
    assert.equal(feature.getSidebarData().repo.id, asyncB.id, 'a late repository A refresh cannot replace the newer B view');
    assert.ok(feature.sidebar.getChildren().every(group => group.snapshot.repo.id === asyncB.id));
    service.run = originalRun;

    await feature.refresh(asyncA);
    const asyncNode = node('unstaged', 'file.txt');
    const mutationFinished = deferred(), releaseMutation = deferred();
    let holdMutation = true;
    service.run = async (repository, args, options) => {
      const result = await originalRun(repository, args, options);
      if (holdMutation && repository.id === asyncA.id && args[0] === 'add') {
        holdMutation = false; mutationFinished.resolve(); await releaseMutation.promise;
      }
      return result;
    };
    const pendingStage = run('stage', asyncNode, [asyncNode]);
    await mutationFinished.promise;
    await feature.refresh(asyncB);
    const beforeStageCompletion = executed.length;
    releaseMutation.resolve();
    await pendingStage;
    assert.equal(git(asyncA, 'show', ':file.txt'), 'A work', 'the original stage operation completes in its explicit repository');
    assert.equal(git(asyncB, 'show', ':file.txt'), 'base', 'switching the view does not redirect the pending stage');
    assert.equal(feature.getSidebarData().repo.id, asyncB.id, 'stage completion cannot pull the view back to A');
    assert.equal(executed.slice(beforeStageCompletion).some(([command, repository]) => command === 'gitpeek.refresh' && repository?.id === asyncA.id), false, 'late stage completion does not reset global views to its old repository');
    service.run = originalRun;
    console.log('Batch stage view passed (native multi-selection, group scopes, refresh, unsaved/stale batches, mixed sections/repositories and disabled protection).');
  } finally {
    Module._load = originalLoad;
    for (const item of subscriptions) item.dispose();
    const resolved = path.resolve(temp);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Batch view check escaped temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
