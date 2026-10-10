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

function fixture(root, saved = new Map()) {
  const repo = { id: 'lifecycle', root };
  const handlers = {}, commands = new Map(), contexts = new Map(), focused = [], subscriptions = [], notices = [], signals = [];
  const disposable = { dispose() {} };
  const uri = value => ({ ...value, toString: () => JSON.stringify(value) });
  const state = { enabled: true, head: OLD_HEAD, lookup: async () => repo, eagerRead: false, watcherCount: 0 };
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, RelativePattern: class {},
    TreeItemCollapsibleState: { None: 0 },
    Uri: { file: fsPath => uri({ scheme: 'file', fsPath }) },
    window: {
      createTreeView: (_name, options) => {
        if (state.eagerRead) void options.treeDataProvider.getChildren();
        return { ...disposable, reveal: async () => {}, onDidChangeSelection: () => disposable,
          onDidChangeVisibility: callback => (handlers.visibility = callback, disposable) };
      },
      onDidChangeActiveTextEditor: callback => (handlers.editor = callback, disposable),
      onDidChangeWindowState: () => disposable,
      showInformationMessage: async text => notices.push(text),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      getConfiguration: () => ({ get: (key, fallback) => key === 'enabled' ? state.enabled : fallback }),
      createFileSystemWatcher: () => { state.watcherCount++; return { ...disposable, onDidChange() {}, onDidCreate() {}, onDidDelete() {} }; },
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
      if (args[0] === 'rev-parse' && args[1] === '--git-path') { state.onGitPath?.(args[2]); return path.join('.git', args[2]); }
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
    history: async (_repo, file, _limit, head, signal) => {
      signals.push(signal);
      if (state.history) return state.history(file, head, signal);
      return [{ hash: head, shortHash: head.slice(0, 8), subject: file, filePath: file,
        author: 'Test', date: '2026-01-01T00:00:00Z' }];
    },
  };
  return {
    state, vscode, contexts, focused, fileUri, activate, saved, notices, signals,
    visibility: visible => handlers.visibility({ visible }),
    run: (name, ...args) => commands.get(name)(...args),
    configure: async enabled => {
      state.enabled = enabled;
      await handlers.configuration({ affectsConfiguration: key => key === 'gitpeek.enabled' });
      await new Promise(setImmediate);
    },
    start: registerHistory => registerHistory({ subscriptions, workspaceState: {
      get: key => saved.get(key), update: async (key, value) => saved.set(key, structuredClone(value)),
    } }, git, { forUri: value => state.lookup(value) },
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
      ['restart restores pinned immutable history and selected commit without focus', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        const row = (await history.provider.getChildren()).find(item => item.contextValue === 'gitpeek.historyCommit');
        await app.run('gitpeek.internal.fileHistory.pin');
        await app.run(row.command.command, ...row.command.arguments);
        const snapshot = app.saved.get('gitpeek.investigation.history.v1');
        assert.equal(snapshot.trail[snapshot.cursor].ref, OLD_HEAD);
        assert.equal(snapshot.trail[snapshot.cursor].selectedHash, OLD_HEAD);
        app.dispose();
        const restarted = fixture(directory, app.saved);
        current = restarted;
        restarted.state.head = NEW_HEAD;
        restarted.state.eagerRead = true;
        restarted.vscode.window.activeTextEditor = { document: { uri: restarted.fileUri('b.txt') } };
        try {
          const restored = await restarted.start(registerHistory);
          const rows = await restored.provider.getChildren();
          assert.equal(rows[0].label, 'a.txt');
          assert.equal(rows.find(item => item.commitTarget).commitTarget.hash, OLD_HEAD);
          assert.equal(restarted.contexts.get('gitpeek.historyPinned'), true);
          assert.deepEqual(restarted.focused, []);
          restored.refresh();
          assert.equal((await restored.provider.getChildren()).find(item => item.commitTarget).commitTarget.hash, OLD_HEAD,
            'refresh must retain a pinned snapshot after HEAD moves');
        } finally { restarted.dispose(); current = app; }
      }],
      ['invalid persisted path is rejected with an explanation', async (app, registerHistory) => {
        app.saved.set('gitpeek.investigation.history.v1', { version: 1, pinned: true, cursor: 0,
          trail: [{ repo: { id: 'lifecycle', root: directory }, file: '../outside.txt', ref: OLD_HEAD, head: OLD_HEAD, limit: 20 }] });
        const history = await app.start(registerHistory);
        assert.equal((await history.provider.getChildren())[0].label, 'a.txt');
        assert.equal(app.contexts.get('gitpeek.historyPinned'), false);
        assert.ok(app.notices.some(text => text.includes('已失效')));
      }],
      ['bounded persisted trail always retains the active pinned object', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        await history.provider.getChildren();
        for (let index = 0; index < 22; index++) {
          await history.show(app.fileUri(`file-${index}.txt`));
          await history.provider.getChildren();
        }
        for (let index = 0; index < 22; index++) await app.run('gitpeek.internal.fileHistory.back');
        const snapshot = app.saved.get('gitpeek.investigation.history.v1');
        assert.equal(snapshot.trail.length, 20);
        assert.ok(snapshot.cursor >= 0);
        assert.equal(snapshot.trail[snapshot.cursor].file, 'a.txt');
        assert.equal(snapshot.pinned, true);
      }],
      ['changing target and closing view abort old read queries', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        const started = deferred();
        app.state.history = (file, head, signal) => new Promise((_resolve, reject) => {
          assert.ok(signal instanceof AbortSignal);
          signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
          started.resolve();
        });
        const old = history.provider.getChildren();
        const duplicate = history.provider.getChildren();
        await started.promise;
        await app.activate(app.fileUri('b.txt'));
        assert.deepEqual(await old, []);
        assert.deepEqual(await duplicate, []);
        assert.equal(app.signals.length, 1, 'parallel tree loads share the same read query');
        assert.equal(app.signals[0].aborted, true);
        const closing = history.provider.getChildren();
        await new Promise(setImmediate);
        app.visibility(false);
        assert.deepEqual(await closing, []);
        assert.equal(app.signals.at(-1).aborted, true);
        app.state.history = undefined;
        app.visibility(true);
        assert.equal((await history.provider.getChildren())[0].label, 'b.txt');
      }],
      ['cancelled watcher initialization can be retried', async (app, registerHistory) => {
        const history = await app.start(registerHistory);
        app.state.onGitPath = gitPath => {
          if (gitPath === 'logs/HEAD') {
            app.state.onGitPath = undefined;
            queueMicrotask(() => app.visibility(false));
          }
        };
        assert.deepEqual(await history.provider.getChildren(), []);
        app.visibility(true);
        assert.equal((await history.provider.getChildren())[0].label, 'a.txt');
        assert.equal(app.state.watcherCount, 4, 'cancelled setup must not leave a phantom watcher key');
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
