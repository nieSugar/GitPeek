const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-blame-'));
  const handlers = {}, commands = new Map(), watchers = [], calls = [], pending = [];
  const rendered = [];
  const document = {
    uri: uri(join(process.cwd(), 'sample.ts')), contents: 'first\nsecond\n',
    lineCount: 3, version: 1, isDirty: false,
    getText() { return this.contents; },
    lineAt: line => ({ range: { end: { line, character: 4 } } }),
  };
  const editor = { document, selection: { active: { line: 0 } }, setDecorations: (_, items) => rendered.push(items) };
  const disposable = { dispose() {} };
  let delay = 0, size = 100, enabled = true, head = 'a'.repeat(40), unborn = false, tracked = true;
  const vscode = {
    window: {
      activeTextEditor: editor,
      createTextEditorDecorationType: () => disposable,
      onDidChangeActiveTextEditor: handler => (handlers.active = handler, disposable),
      onDidChangeTextEditorSelection: handler => (handlers.selection = handler, disposable),
      onDidChangeWindowState: handler => (handlers.focus = handler, disposable),
    },
    workspace: {
      fs: { stat: async () => ({ size }) },
      getConfiguration: () => ({ get: (key, fallback) => key === 'blame.delay' ? delay : key === 'enabled' ? enabled : fallback }),
      onDidChangeTextDocument: handler => (handlers.change = handler, disposable),
      onDidSaveTextDocument: handler => (handlers.save = handler, disposable),
      onDidCloseTextDocument: handler => (handlers.close = handler, disposable),
      onDidChangeConfiguration: handler => (handlers.config = handler, disposable),
      createFileSystemWatcher: pattern => {
        const watcher = { pattern, disposed: false, dispose() { this.disposed = true; },
          onDidChange(handler) { this.change = handler; }, onDidCreate(handler) { this.create = handler; }, onDidDelete(handler) { this.delete = handler; } };
        watchers.push(watcher);
        return watcher;
      },
    },
    languages: { registerHoverProvider: (_, provider) => (handlers.hover = provider.provideHover, disposable) },
    commands: { registerCommand: (name, callback) => (commands.set(name, callback), disposable) },
    env: { clipboard: { writeText: async hash => { vscode.copied = hash; } } },
    Uri: { file: uri }, ThemeColor: class {}, Range: class {},
    RelativePattern: class { constructor(baseUri, pattern) { Object.assign(this, { baseUri, pattern }); } },
    Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(value) { this.value += value; } },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
  };
  const repo = { root: process.cwd(), id: 'test' };
  const git = {
    run: async (_repo, args) => {
      calls.push(args);
      if (args.includes('--git-path')) return ['HEAD', 'index', 'packed-refs', 'refs', 'logs/HEAD', 'config'].map(entry => `.git/${entry}`).join('\n');
      if (args[0] === 'rev-parse') { if (unborn) throw new Error('no HEAD'); return head; }
      if (args[0] === 'ls-tree') return tracked ? 'sample.ts\0' : '';
      throw new Error(`Unexpected command: ${args}`);
    },
    userEmail: async repository => { calls.push(['identity', repository.id]); return repository.id === 'test' ? 'self@example.invalid' : 'other@example.invalid'; },
    blame: (...args) => { calls.push(['blame', ...args]); return new Promise(resolve => pending.push(resolve)); },
  };
  const actions = { showCommit: (...args) => { actions.commit = args; }, showDiff: (...args) => { actions.diff = args; } };
  const info = (author, currentLine, authorEmail, summary = `${author} line`) => ({ hash: head, author, authorEmail, currentLine,
    originalLine: currentLine, authorTime: 1700000000, summary, filename: 'old-name.ts' });
  const select = line => { editor.selection.active.line = line; handlers.selection({ textEditor: editor }); };
  const text = () => rendered.at(-1)?.[0]?.renderOptions?.after?.contentText;
  let controller;
  try {
    const output = join(temp, 'blame.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'blame.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: output });
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    let BlameController, blameAuthor;
    try { ({ BlameController, blameAuthor } = require(output)); } finally { Module._load = originalLoad; }
    assert.equal(blameAuthor(info('Self', 1, ' SELF@example.invalid '), 'self@example.invalid'), '你');
    assert.equal(blameAuthor(info('Self', 1, 'different@example.invalid'), 'self@example.invalid'), 'Self');
    assert.equal(blameAuthor(info('Self', 1), 'self@example.invalid'), 'Self');
    assert.equal(blameAuthor(info('Self', 1, 'self@example.invalid')), 'Self');
    controller = new BlameController(git, { forUri: async value => value.fsPath.includes('other.ts') ? { ...repo, id: 'other' } : repo }, actions);
    await until(() => pending.length === 1);
    assert.deepEqual(calls.find(call => call[0] === 'blame').slice(2), ['sample.ts', 1, 2], 'load both actual lines, excluding trailing empty editor line');
    delay = 40;
    select(1);
    await tick();
    assert.equal(pending.length, 1, 'cursor moves share the pending file query');
    pending[0]([info('Self', 1, 'self@example.invalid'), info('Other', 2, 'other@example.invalid')]);
    await until(() => text()?.includes('Other line'));
    assert.match(text(), /^Other ·/, 'completed file query paints the latest selection');
    assert.equal(pending.length, 1, 'a query completed before the selection timer is reused');

    delay = 600;
    const warmCalls = calls.length;
    const started = performance.now();
    select(0);
    assert.match(text(), /^你 ·/, 'a previously unselected line renders synchronously from the file cache');
    assert.equal(calls.length, warmCalls, 'cached cursor moves spawn no Git processes');
    const warmMs = performance.now() - started;
    const hover = handlers.hover(document, { line: 0 }).contents;
    assert.equal(handlers.hover(document, { line: 0 }).range.end.line, 0, 'Hover covers the source line, including the end of line');
    assert.match(hover.value, /\*\*你\*\*/);
    assert.match(hover.value, /Self · self@example\\\.invalid/, 'hover retains original attribution');
    assert.deepEqual(hover.isTrusted.enabledCommands, ['gitpeek.internal.blameCommit', 'gitpeek.internal.blameDiff', 'gitpeek.internal.copyBlameHash']);
    for (const command of hover.isTrusted.enabledCommands) assert.match(hover.value, new RegExp(`command:${command.replaceAll('.', '\\.')}\\?`));
    const diffArgs = JSON.parse(decodeURIComponent(hover.value.match(/command:gitpeek.internal.blameDiff\?([^)]*)/)[1]));
    commands.get('gitpeek.internal.blameDiff')(...diffArgs);
    assert.deepEqual(actions.diff, [repo, head, 'old-name.ts']);
    select(0);
    assert.equal(calls.length, warmCalls, 'clicking elsewhere on the same line retains immediate Hover');
    assert.ok(handlers.hover(document, { line: 0 }));
    select(2);
    assert.equal(text(), undefined, 'trailing empty line has no fabricated attribution');
    assert.equal(handlers.hover(document, { line: 0 }), undefined, 'Hover does not retain the previous line');

    delay = 0;
    select(0);
    document.isDirty = true;
    document.version++;
    handlers.change({ document });
    assert.equal(text(), '未保存的更改');
    assert.equal(handlers.hover(document, { line: 0 }), undefined);
    document.isDirty = false;
    handlers.save(document);
    await until(() => pending.length === 2);
    head = 'c'.repeat(40);
    pending[1]([info('Stale HEAD', 1)]);
    await until(() => pending.length === 3);
    assert.equal(text(), undefined, 'HEAD changes during a query cannot paint stale results');
    pending[2]([info('Fresh HEAD', 1)]);
    await until(() => text()?.includes('Fresh HEAD'));
    assert.equal(watchers.length, 6, 'refresh reuses repository watchers');
    watchers.find(watcher => watcher.pattern.pattern === 'index').change();
    assert.equal(text(), undefined, 'index changes clear cached attribution immediately');
    await until(() => pending.length === 4);
    pending[3]([info('Uncommitted', 1, undefined, 'pending')].map(value => ({ ...value, hash: '0'.repeat(40) })));
    await until(() => text() === '你 · 未提交的更改');

    watchers.find(watcher => watcher.pattern.pattern === 'HEAD').change();
    await until(() => pending.length === 5);
    document.version++;
    handlers.change({ document });
    await until(() => pending.length === 6);
    pending[5]([info('New document', 1)]);
    await until(() => text()?.includes('New document'));
    pending[4]([info('Old document', 1)]);
    await tick();
    assert.match(text(), /New document/, 'old file results never overwrite a changed document');

    document.lineCount = 20_001;
    handlers.change({ document });
    await until(() => text() === 'GitPeek：大文件已停用当前行归属显示。');
    assert.equal(pending.length, 6, 'line limit blocks Git blame');
    document.lineCount = 3;
    size = 2 * 1024 * 1024 + 1;
    handlers.change({ document });
    await until(() => text() === 'GitPeek：大文件已停用当前行归属显示。');
    assert.equal(pending.length, 6, 'byte limit blocks Git blame');
    size = 100;
    document.uri = uri(join(process.cwd(), 'staged-new.ts'));
    tracked = false;
    git.blame = async () => { throw new Error('no such path in HEAD'); };
    handlers.change({ document });
    await until(() => text() === '你 · 未提交的更改');
    assert.ok(calls.some(args => args[0] === 'ls-tree' && args.at(-1) === ':(literal)staged-new.ts'));
    const beforeSuspension = calls.length;
    controller.setSuspended(true);
    controller.refresh();
    await tick();
    assert.deepEqual(rendered.at(-1), [], 'full-file blame clears single-line decorations');
    assert.equal(calls.length, beforeSuspension);
    controller.setSuspended(false);
    await until(() => text() === '你 · 未提交的更改');

    unborn = true;
    controller.refresh();
    await until(() => text() === '你 · 未提交的更改');
    unborn = false;
    const otherDocument = { ...document, uri: uri(join(process.cwd(), 'other.ts')) };
    const otherRendered = [];
    const otherEditor = { document: otherDocument, selection: { active: { line: 0 } }, setDecorations: (_, items) => otherRendered.push(items) };
    git.blame = async () => [info('Other identity', 1, 'self@example.invalid')];
    vscode.window.activeTextEditor = otherEditor;
    handlers.active(otherEditor);
    await until(() => otherRendered.at(-1)?.[0]);
    assert.match(otherRendered.at(-1)[0].renderOptions.after.contentText, /^Other identity ·/, 'current user matching is isolated by repository');

    git.blame = async repository => repository.id === 'test'
      ? new Promise(resolve => pending.push(resolve)) : [info('Other identity', 1, 'self@example.invalid')];
    vscode.window.activeTextEditor = editor;
    handlers.active(editor);
    await until(() => pending.length === 7);
    vscode.window.activeTextEditor = otherEditor;
    handlers.active(otherEditor);
    await until(() => otherRendered.at(-1)?.[0]);
    assert.equal(watchers.filter(watcher => !watcher.disposed).length, 6, 'returning to a cached repository reinstalls its watchers');
    pending[6]([info('Wrong repository', 1)]);
    await tick();
    assert.doesNotMatch(otherRendered.at(-1)[0].renderOptions.after.contentText, /Wrong repository/);
    git.blame = async () => [info('Other identity', 1, 'self@example.invalid')];
    vscode.window.activeTextEditor = editor;
    handlers.active(editor);
    await until(() => text()?.includes('Other identity'));
    const focusCalls = calls.length;
    handlers.focus({ focused: true });
    await until(() => calls.length > focusCalls && text()?.includes('Other identity'));
    enabled = false;
    handlers.config({ affectsConfiguration: () => true });
    const disabledCalls = calls.length;
    await tick();
    assert.equal(calls.length, disabledCalls);
    assert.equal(text(), undefined);
    controller.dispose(); controller = undefined;
    assert.ok(watchers.every(watcher => watcher.disposed), 'all repository watchers are released');
    console.log(`Blame passed: shared file query, synchronous warm selection (${warmMs.toFixed(2)} ms; zero Git calls), identity, Hover actions, HEAD/index/document invalidation, limits, new files and lifecycle.`);
  } finally {
    controller?.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
}

function uri(fsPath) { return { scheme: 'file', fsPath, toString: () => `file:${fsPath}` }; }
async function tick() { await new Promise(resolve => setTimeout(resolve, 10)); }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for blame update');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
