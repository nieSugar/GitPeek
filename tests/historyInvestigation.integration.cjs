const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-investigation-'));
  const originalLoad = Module._load;
  const subscriptions = [];
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const make = id => {
    const repo = { id, root: path.join(temp, id) };
    fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'GitPeek Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false');
    return repo;
  };
  const write = (repo, file, text) => fs.writeFileSync(path.join(repo.root, file), text, 'utf8');
  const commit = (repo, subject) => {
    git(repo, 'add', '--all'); git(repo, 'commit', '-m', subject);
    return git(repo, 'rev-parse', 'HEAD');
  };
  try {
    const repo = make('first'), other = make('second');
    const file = '调查 [file].txt', caller = 'caller.txt', archivedFile = '旧 [file].txt';
    write(repo, file, 'base\n'); write(repo, caller, 'caller base\n');
    const base = commit(repo, 'base');
    git(repo, 'switch', '-c', 'release');
    write(repo, file, 'release content\n'); const release = commit(repo, 'release fix');
    git(repo, 'switch', '-c', 'archive');
    git(repo, 'mv', '--', file, archivedFile); const archive = commit(repo, 'archive rename');
    git(repo, 'switch', 'main');
    write(repo, file, 'main one\n'); commit(repo, 'main first edit');
    write(repo, file, 'main two\n'); const main = commit(repo, 'main second edit');
    write(other, file, 'other repository\n'); const otherHead = commit(other, 'other root');
    write(repo, caller, 'staged caller\n'); git(repo, 'add', '--', caller);
    write(repo, caller, 'unsaved on disk caller\n');
    const originalIndex = git(repo, 'write-tree');
    const originalStatus = git(repo, 'status', '--porcelain');

    const commands = new Map(), contexts = new Map(), diffs = [], requests = [], errors = [], notices = [];
    const editorHandlers = [], configurationHandlers = [], revealed = [], selectionHandlers = [];
    const disposable = { dispose() {} };
    const uri = value => ({ ...value, toString: () => JSON.stringify(value) });
    let enabled = true, contentProvider, pick = async () => undefined, input = async () => undefined;
    let picks = 0;
    const vscode = {
      EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
      TreeItem: class { constructor(label) { this.label = label; } },
      ThemeIcon: class {}, RelativePattern: class {},
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      QuickPickItemKind: { Separator: -1 },
      TabInputText: class { constructor(value) { this.uri = value; } },
      TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
      TabInputWebview: class {},
      Uri: { file: fsPath => uri({ scheme: 'file', fsPath }), from: uri },
      window: {
        tabGroups: { activeTabGroup: {} },
        createTreeView: name => ({
          ...disposable,
          reveal: async item => { if (name === 'gitpeek.fileHistory') revealed.push(item); },
          onDidChangeSelection: handler => { if (name === 'gitpeek.fileHistory') selectionHandlers.push(handler); return disposable; },
        }),
        onDidChangeActiveTextEditor: handler => (editorHandlers.push(handler), disposable),
        onDidChangeWindowState: () => disposable,
        showQuickPick: async (items, options) => { picks++; return pick(await items, options); },
        showInputBox: async options => input(options),
        showInformationMessage: async text => notices.push(text),
        showWarningMessage: async text => notices.push(text),
        showErrorMessage: async text => errors.push(text),
      },
      workspace: {
        getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? enabled : key === 'limit' ? 1 : fallback }),
        createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
        onDidSaveTextDocument: () => disposable,
        onDidChangeConfiguration: handler => (configurationHandlers.push(handler), disposable),
        registerTextDocumentContentProvider: (_scheme, provider) => (contentProvider = provider, disposable),
      },
      commands: {
        registerCommand: (name, callback) => (commands.set(name, callback), disposable),
        executeCommand: async (name, ...args) => {
          if (name === 'setContext') { contexts.set(args[0], args[1]); return; }
          if (name === 'gitpeek.fileHistory.focus') return;
          if (name === 'vscode.diff') {
            diffs.push(args);
            vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputTextDiff(args[0], args[1]) };
            await activate(args[1]);
            return;
          }
          assert.ok(commands.has(name), `Unexpected command: ${name}`);
          return commands.get(name)(...args);
        },
      },
    };
    const activate = async value => {
      vscode.window.activeTextEditor = value ? { document: { uri: value } } : undefined;
      await Promise.all(editorHandlers.map(handler => handler(vscode.window.activeTextEditor)));
    };
    const fileUri = (target, name) => vscode.Uri.file(path.join(target.root, name));
    vscode.window.activeTextEditor = { document: { uri: fileUri(repo, file) } };
    await esbuild.build({
      entryPoints: ['git/GitService', 'features/history', 'features/commitDetail'].map(name => path.join(__dirname, '../src', `${name}.ts`)),
      bundle: true, platform: 'node', format: 'cjs', supported: { 'dynamic-import': false },
      external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' },
    });
    Module._load = function (name, parent, isMain) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain); };
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { registerHistory } = require(path.join(temp, 'features/history.cjs'));
    const { registerCommitFeatures } = require(path.join(temp, 'features/commitDetail.cjs'));
    const service = new GitService();
    const commits = registerCommitFeatures({ subscriptions }, service);
    const history = await registerHistory({ subscriptions }, service, {
      forUri: async value => [repo, other].find(target => (value.fsPath === target.root || value.fsPath.startsWith(target.root + path.sep))),
    }, async (...args) => { requests.push(args); await commits.showDiff(...args); });
    const run = (name, ...args) => {
      const command = name.startsWith('gitpeek.') ? name : `gitpeek.internal.fileHistory.${name}`;
      assert.ok(commands.has(command), `Missing command: ${command}`);
      return commands.get(command)(...args);
    };
    const rows = () => history.provider.getChildren();
    const commitRows = values => values.filter(item => item.contextValue === 'gitpeek.historyCommit');
    const targetOf = async () => {
      const values = await rows();
      return { file: values[0].label, commits: commitRows(values).map(item => item.command.arguments[1]), heading: `${values[0].description}\n${values[0].tooltip}` };
    };
    const choose = ref => {
      pick = async items => {
        const item = items.find(value => value.ref === ref || value.ref === `refs/heads/${ref}`);
        assert.ok(item, `Missing reference choice: ${ref}`);
        return item;
      };
      return run('chooseRef');
    };

    assert.equal((await targetOf()).file, file);
    assert.deepEqual((await targetOf()).commits, [main]);
    await activate(fileUri(repo, caller));
    assert.equal((await targetOf()).file, caller, 'unfixed history follows the ordinary active editor');
    await run('pin');
    assert.equal(contexts.get('gitpeek.historyPinned'), true);
    await activate(fileUri(repo, file));
    assert.equal((await targetOf()).file, caller, 'fixed history survives opening a caller or another file');
    await run('gitpeek.fileHistory', fileUri(repo, file));
    assert.equal((await targetOf()).file, file, 'explicit file history changes the investigation target while pinned');
    assert.equal(contexts.get('gitpeek.historyPinned'), true);
    await run('loadMore');
    assert.equal((await targetOf()).commits.length, 3);
    const selected = commitRows(await rows()).at(-1);
    for (const callback of selectionHandlers) callback({ selection: [selected] });
    await run('gitpeek.fileHistory', fileUri(repo, caller));
    assert.equal(contexts.get('gitpeek.historyCanGoBack'), true);
    await run('back');
    assert.equal((await targetOf()).file, file);
    assert.equal((await targetOf()).commits.length, 3, 'back restores the loaded page size');
    assert.equal(typeof selected.id, 'string', 'history rows have stable identities for restoring selection');
    assert.ok(revealed.some(item => item.id === selected.id), 'back brings the selected commit back into view');
    assert.equal(contexts.get('gitpeek.historyCanGoForward'), true);
    await run('forward');
    assert.equal((await targetOf()).file, caller);
    assert.equal((await targetOf()).commits.length, 1);
    assert.equal(diffs.length, 0, 'investigation navigation does not open editors or change the workspace');
    await run('unpin');
    assert.equal(contexts.get('gitpeek.historyPinned'), false);
    assert.equal((await targetOf()).file, file, 'unpin resumes the current ordinary editor');

    await choose('release');
    assert.equal(contexts.get('gitpeek.historyPinned'), true, 'choosing a branch fixes the investigation context');
    assert.deepEqual((await targetOf()).commits, [release]);
    assert.match((await targetOf()).heading, /release/, 'the branch is visible in the history heading');
    const releaseRow = commitRows(await rows())[0];
    await run(releaseRow.command.command, ...releaseRow.command.arguments);
    assert.deepEqual(requests.at(-1)[4], { historyHead: release, historyFile: file }, 'history clicks carry their immutable branch snapshot');
    const branchDiff = diffs.at(-1)[1];
    assert.equal(await contentProvider.provideTextDocumentContent(branchDiff), 'release content\n');
    await run('gitpeek.previousFileRevision');
    assert.equal(JSON.parse(diffs.at(-1)[1].query).currentCommit, base);
    await run('gitpeek.nextFileRevision');
    assert.equal(JSON.parse(diffs.at(-1)[1].query).currentCommit, release, 'next revision stays on the investigated branch');
    assert.equal(JSON.parse(diffs.at(-1)[1].query).historyHead, release);
    assert.deepEqual((await targetOf()).commits, [release], 'opening a branch Diff cannot restore workspace HEAD history');

    await choose('HEAD');
    assert.equal((await targetOf()).commits[0], main);
    assert.equal((await targetOf()).commits.length, 3, 'returning to HEAD preserves the previous page size');
    let fileChoices = 0;
    pick = async items => {
      const branch = items.find(item => item.ref === 'archive' || item.ref === 'refs/heads/archive');
      if (branch) return branch;
      fileChoices++;
      const selected = items.find(item => item.path === archivedFile || item.file === archivedFile || item.label === archivedFile);
      assert.ok(selected, 'a file absent on the target branch prompts with actual branch files');
      return selected;
    };
    await run('chooseRef');
    assert.equal(fileChoices, 1);
    assert.equal((await targetOf()).file, archivedFile);
    assert.deepEqual((await targetOf()).commits, [archive]);
    assert.match((await targetOf()).heading, /archive/);
    const archiveRow = commitRows(await rows())[0];
    await run(archiveRow.command.command, ...archiveRow.command.arguments);
    assert.deepEqual(requests.at(-1)[4], { historyHead: archive, historyFile: archivedFile });
    assert.equal(fs.existsSync(path.join(repo.root, archivedFile)), false, 'branch-only files are not written to the working tree');
    await run('back');
    assert.equal((await targetOf()).file, file);
    assert.equal((await targetOf()).commits[0], main);
    assert.equal((await targetOf()).commits.length, 3);
    await run('forward');
    const archiveTarget = await targetOf();
    assert.equal(archiveTarget.file, archivedFile);

    pick = async items => items.find(item => item.file === caller);
    await run('chooseFile');
    assert.equal((await targetOf()).file, caller, 'chooseFile browses another file within the same historical snapshot');
    assert.match((await targetOf()).heading, /archive/);
    await run('back');
    assert.deepEqual(await targetOf(), archiveTarget);
    assert.equal(requests.at(-1)[3], undefined, 'branch-only paths never claim an unverified workspace file');

    pick = async () => undefined;
    await run('chooseRef');
    assert.deepEqual(await targetOf(), archiveTarget, 'cancelled ref selection leaves the investigation untouched');
    pick = async items => items.find(item => item.ref === '');
    input = async () => 'missing-reference';
    await run('chooseRef');
    assert.deepEqual(await targetOf(), archiveTarget, 'an invalid ref does not replace the investigation');
    assert.ok(errors.length + notices.length > 0, 'invalid refs are explained to the user');
    errors.length = 0; notices.length = 0;
    pick = async items => items.find(item => item.ref === 'HEAD');
    await run('chooseRef');
    assert.deepEqual(await targetOf(), archiveTarget, 'cancelling a missing-file picker also preserves the original target');

    enabled = false;
    for (const callback of configurationHandlers) callback({ affectsConfiguration: key => key === 'gitpeek.enabled' });
    const pickCount = picks;
    await run('chooseRef'); await run('back'); await run('unpin');
    await run('gitpeek.fileHistory', fileUri(other, file));
    assert.equal(picks, pickCount, 'disabled history actions cannot start a picker');
    enabled = true;
    for (const callback of configurationHandlers) callback({ affectsConfiguration: key => key === 'gitpeek.enabled' });
    assert.deepEqual(await targetOf(), archiveTarget, 'disabled actions preserve target and navigation state');
    await activate(fileUri(repo, file));
    await run('unpin');
    pick = async items => {
      await activate(fileUri(repo, caller));
      return items.find(item => item.ref === 'release' || item.ref === 'refs/heads/release');
    };
    await run('chooseRef');
    assert.equal((await targetOf()).file, caller, 'changing active context while the picker is open discards its stale result');
    assert.equal(contexts.get('gitpeek.historyPinned'), false);

    await activate(fileUri(other, file));
    assert.deepEqual((await targetOf()).commits, [otherHead], 'same path in a second repository has its own history');
    await run('back');
    assert.equal((await targetOf()).file, caller);
    await run('forward');
    const otherRow = commitRows(await rows())[0];
    assert.equal(otherRow.command.arguments[0].id, other.id);
    await run('unpin');
    await activate(branchDiff);
    assert.deepEqual((await targetOf()).commits, [release], 'revisiting a saved branch Diff recovers its repository and snapshot');

    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), main);
    assert.equal(git(repo, 'write-tree'), originalIndex, 'investigating branches preserves staged content');
    assert.equal(git(repo, 'status', '--porcelain'), originalStatus);
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8'), 'main two\n');
    assert.equal(fs.readFileSync(path.join(repo.root, caller), 'utf8'), 'unsaved on disk caller\n');
    assert.deepEqual(errors, []);
    console.log('History investigation passed: pin, cross-file navigation, page restoration, branch snapshots, missing paths, stale pickers and isolated repositories.');
  } finally {
    Module._load = originalLoad;
    for (const subscription of subscriptions) subscription.dispose();
    if (!temp.startsWith(os.tmpdir() + path.sep)) throw new Error('Test directory outside temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
