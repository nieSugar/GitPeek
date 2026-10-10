const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const OLD_HEAD = 'a'.repeat(40), NEW_HEAD = 'b'.repeat(40);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(root) {
  const repo = { id: 'lifecycle', root };
  const handlers = {}, commands = new Map(), contexts = new Map(), focused = [], subscriptions = [];
  const disposable = { dispose() {} };
  const uri = value => ({ ...value, toString: () => JSON.stringify(value) });
  const state = { enabled: true, head: OLD_HEAD, lookup: async () => repo };
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, RelativePattern: class {},
    TreeItemCollapsibleState: { None: 0 },
    Uri: { file: fsPath => uri({ scheme: 'file', fsPath }) },
    window: {
      createTreeView: () => ({ ...disposable, reveal: async () => {}, onDidChangeSelection: () => disposable }),
      onDidChangeActiveTextEditor: callback => (handlers.editor = callback, disposable),
      onDidChangeWindowState: () => disposable,
      showInformationMessage: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? state.enabled : fallback }),
      createFileSystemWatcher: () => ({ ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }),
      onDidSaveTextDocument: () => disposable,
      onDidChangeConfiguration: callback => (handlers.configuration = callback, disposable),
    },
    commands: {
      registerCommand: (name, callback) => (commands.set(name, callback), disposable),
      executeCommand: async (name, ...args) => {
        if (name === 'setContext') return contexts.set(args[0], args[1]);
        if (name === 'gitpeek.fileHistory.focus') return focused.push(name);
        assert.ok(commands.has(name), `Unexpected command: ${name}`);
        return commands.get(name)(...args);
      },
    },
  };
  const fileUri = file => vscode.Uri.file(path.join(root, file));
  vscode.window.activeTextEditor = { document: { uri: fileUri('a.txt') } };
  const activate = async value => {
    vscode.window.activeTextEditor = { document: { uri: value } };
    await handlers.editor(vscode.window.activeTextEditor);
  };
  const git = {
    run: async (_repo, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return path.join('.git', args[2]);
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1).replace(/\^\{commit\}$/, '');
        assert.ok(ref === 'HEAD' || [OLD_HEAD, NEW_HEAD].includes(ref));
        return ref === 'HEAD' ? state.head : ref;
      }
      if (args[0] === 'rev-list') return [...new Set([state.head, OLD_HEAD])].join('\n');
      if (args[0] === 'ls-tree') return 'a.txt\0b.txt\0';
      if (args[0] === 'log') return '';
      assert.fail(`Unexpected Git command: ${args}`);
    },
    history: async (_repo, file, _limit, head) => [{
      hash: head, shortHash: head.slice(0, 8), subject: file, filePath: file,
      author: 'Test', date: '2026-01-01T00:00:00Z',
    }],
  };
  return {
    state, vscode, contexts, focused, fileUri, activate,
    run: (name, ...args) => commands.get(name)(...args),
    configure: async enabled => {
      state.enabled = enabled;
      await handlers.configuration({ affectsConfiguration: key => key === 'gitpeek.enabled' });
      await new Promise(setImmediate);
    },
    start: registerHistory => registerHistory({ subscriptions }, git, { forUri: value => state.lookup(value) },
      async (_repo, hash, file, workspacePath, snapshot) => activate(uri({
        scheme: 'gitpeek-commit', query: JSON.stringify({
          repoId: repo.id, root, workspacePath, ...snapshot, currentCommit: hash, currentFile: file,
        }),
      }))),
    dispose: () => subscriptions.forEach(item => item.dispose()),
  };
}

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'gitpeek-history-lifecycle-'));
  const outfile = path.join(directory, 'history.cjs');
  const originalLoad = Module._load;
  let current;
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, '..', 'src', 'features', 'history.ts')],
      bundle: true, platform: 'node', format: 'cjs', supported: { 'dynamic-import': false }, external: ['vscode'], outfile });
    Module._load = function (name, parent, isMain) {
      return name === 'vscode' ? current.vscode : originalLoad.call(this, name, parent, isMain);
    };
    const cases = [
      ['old Diff keeps its snapshot before hidden history reloads', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        const row = (await history.provider.getChildren()).find(item => item.contextValue === 'gitpeek.historyCommit');
        await app.run(row.command.command, ...row.command.arguments);
        const oldDiff = app.vscode.window.activeTextEditor.document.uri;
        app.state.head = NEW_HEAD;
        await app.run('gitpeek.fileHistory', oldDiff);
        const restored = (await history.provider.getChildren()).find(item => item.contextValue === 'gitpeek.historyCommit');
        assert.equal(restored.commitTarget.hash, OLD_HEAD, 'a hidden view must not replace an old Diff snapshot with current HEAD');
        assert.equal(restored.command.arguments[4].historyHead, OLD_HEAD);
      }],
      ['late startup lookup cannot overwrite a newer active file', async (app, registerHistory) => {
        const started = deferred(), resume = deferred();
        const lookup = app.state.lookup;
        let first = true;
        app.state.lookup = async value => {
          if (first) { first = false; started.resolve(); await resume.promise; }
          return lookup(value);
        };
        const pending = app.start(registerHistory);
        await started.promise;
        await app.activate(app.fileUri('b.txt'));
        resume.resolve();
        const history = await pending;
        assert.equal((await history.provider.getChildren())[0].label, 'b.txt');
        assert.deepEqual(app.focused, [], 'background initialization must not take focus');
      }],
      ['reenabling resumes the editor only when history is unpinned', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        await history.provider.getChildren();
        await app.configure(false);
        await app.activate(app.fileUri('b.txt'));
        await app.configure(true);
        assert.equal((await history.provider.getChildren())[0].label, 'b.txt');
        assert.equal(app.contexts.get('gitpeek.historyPinned'), false);
        await app.run('gitpeek.internal.fileHistory.pin');
        await app.configure(false);
        await app.activate(app.fileUri('a.txt'));
        await app.configure(true);
        assert.equal((await history.provider.getChildren())[0].label, 'b.txt', 'reenabling preserves a pinned investigation');
        assert.equal(app.contexts.get('gitpeek.historyPinned'), true);
        assert.deepEqual(app.focused, [], 'configuration updates must not take focus');
      }],
    ];
    for (const [name, verify] of cases) {
      current = fixture(directory);
      delete require.cache[outfile];
      try { await verify(current, require(outfile).registerHistory); }
      finally { current.dispose(); }
      console.log(`History lifecycle passed: ${name}.`);
    }
  } finally {
    Module._load = originalLoad;
    if (!directory.startsWith(tmpdir() + path.sep)) throw new Error('Test directory outside temp root');
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
