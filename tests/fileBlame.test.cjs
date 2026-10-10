const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-file-blame-'));
  const handlers = {}, commands = new Map(), watchers = [], messages = [], suspended = [], calls = [], decorations = [];
  const disposable = () => ({ dispose() {} });
  const repoA = { root: join(temp, 'A'), id: 'A' }, repoB = { root: join(temp, 'B'), id: 'B' };
  const uri = filename => ({ scheme: 'file', fsPath: filename, toString: () => `file:${filename}` });
  const makeEditor = (repo, file, contents) => {
    const document = { uri: uri(join(repo.root, file)), version: 1, isDirty: true, contents,
      get lineCount() { return this.lines ?? this.contents.split('\n').length; }, getText() { return this.contents; },
      lineAt(line) { return { range: { start: { line, character: 0 }, end: { line, character: this.contents.split('\n')[line].length } } }; } };
    return { document, rendered: [], setDecorations(_, items) { this.rendered.push(items); } };
  };
  const first = makeEditor(repoA, '目录/改名.ts', '稳定代码\n新修改\n');
  const second = makeEditor(repoB, 'other.ts', '第二仓库\n');
  const config = { enabled: true, 'blame.enabled': true, 'blame.delay': 0 };
  const vscode = {
    window: {
      activeTextEditor: first,
      createTextEditorDecorationType: options => (decorations.push(options), disposable()),
      onDidChangeActiveTextEditor: handler => (handlers.active = handler, disposable()),
      onDidChangeWindowState: handler => (handlers.focus = handler, disposable()),
      showInformationMessage: async message => { messages.push(message); },
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }),
      onDidCloseTextDocument: handler => (handlers.close = handler, disposable()),
      onDidChangeTextDocument: handler => (handlers.change = handler, disposable()),
      onDidSaveTextDocument: handler => (handlers.save = handler, disposable()),
      onDidChangeConfiguration: handler => (handlers.config = handler, disposable()),
      createFileSystemWatcher: pattern => {
        const watcher = { pattern, disposed: false, dispose() { this.disposed = true; },
          onDidChange(handler) { this.change = handler; }, onDidCreate(handler) { this.create = handler; }, onDidDelete(handler) { this.delete = handler; } };
        watchers.push(watcher);
        return watcher;
      },
    },
    commands: { registerCommand: (name, callback) => (commands.set(name, callback), disposable()) },
    languages: { registerHoverProvider: (_, provider) => (handlers.hover = provider.provideHover, disposable()) },
    Uri: { file: uri }, ThemeColor: class {},
    Range: class { constructor(line, character, endLine, endCharacter) { Object.assign(this, { line, character, endLine, endCharacter }); } },
    Hover: class { constructor(contents) { this.contents = contents; } },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(value) { this.value += value; } appendText(value) { this.value += value; } },
    RelativePattern: class { constructor(baseUri, pattern) { Object.assign(this, { baseUri, pattern }); } },
    Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
  };
  let head = 'a'.repeat(40), unborn = false, tracked = true;
  const line = (author = '很长的作者名字', currentLine = 1, hash = 'b'.repeat(40), authorEmail) => ({ hash, author, authorEmail, currentLine,
    originalLine: currentLine, authorTime: 1700000000, summary: '修复 <引用>', filename: '旧目录/原名.ts' });
  let blame = async () => [line(), line('Not Committed Yet', 2, '0'.repeat(40))];
  const git = {
    userEmail: async repo => { calls.push({ repo, identity: true }); return repo.id === 'A' ? 'own@example.invalid' : 'other@example.invalid'; },
    run: async (repo, args) => {
      calls.push({ repo, args });
      if (args[0] === 'rev-parse' && args[1] === '--git-path') return join('.git', args[2]);
      if (args[0] === 'rev-parse') { if (unborn) throw new Error('no HEAD'); return head; }
      if (args[0] === 'symbolic-ref') return 'refs/heads/main';
      if (args[0] === 'for-each-ref') return unborn ? '' : 'refs/heads/main';
      if (args[0] === 'ls-tree') return tracked ? '目录/改名.ts\0' : '';
      throw new Error(`Unexpected command: ${args}`);
    },
    blameContents: async (repo, file, contents) => { calls.push({ repo, file, contents }); return blame(repo, file, contents); },
  };
  const actions = { showCommit: (...args) => { actions.commit = args; }, showDiff: (...args) => { actions.diff = args; },
    setLineBlameSuspended: value => suspended.push(value) };
  const switchEditor = editor => { vscode.window.activeTextEditor = editor; handlers.active(editor); };
  const edit = contents => { first.document.contents = contents; first.document.version++; handlers.change({ document: first.document }); };
  const visible = editor => editor.rendered.at(-1) ?? [];
  const toggle = () => commands.get('gitpeek.toggleFileBlame')();
  let controller;
  try {
    const output = join(temp, 'fileBlame.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'fileBlame.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: output });
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    let registerFileBlame;
    try { ({ registerFileBlame } = require(output)); } finally { Module._load = originalLoad; }
    const context = { subscriptions: [] };
    controller = registerFileBlame(context, git, { forUri: async uri => uri.fsPath.startsWith(repoA.root) ? repoA : repoB }, actions);
    assert.equal(context.subscriptions[0], controller);
    assert.equal(calls.length, 0, 'feature remains opt-in');

    toggle();
    await until(() => visible(first).length === 2);
    assert.equal(suspended.at(-1), true);
    assert.equal(calls.find(call => call.contents).contents, '稳定代码\n新修改\n', 'dirty editor content goes to blame');
    assert.match(visible(first)[0].renderOptions.before.contentText, /作者.*bbbbbbb/);
    assert.equal(visible(first)[1].renderOptions.before.contentText, '你 · 未提交');
    const hover = handlers.hover(first.document, { line: 0 }).contents;
    assert.equal(decorations[0].before.width, '36ch', 'fixed width keeps source indentation aligned');
    assert.match(visible(first)[0].renderOptions.before.contentText, /^很长的作者…/);
    assert.match(hover.value, /很长的作者名字/, 'hover retains the full author name');
    const diffLink = hover.value.match(/command:gitpeek.internal.fileBlameDiff\?([^)]*)/);
    const diffArgs = JSON.parse(decodeURIComponent(diffLink[1]));
    assert.deepEqual(diffArgs, [repoA, 'b'.repeat(40), '旧目录/原名.ts', '目录/改名.ts']);
    commands.get('gitpeek.internal.fileBlameDiff')(...diffArgs);
    assert.deepEqual(actions.diff, diffArgs, 'rename Diff preserves historical and workspace paths');
    assert.equal(watchers.length, 4);
    assert.ok(watchers.some(watcher => watcher.pattern.baseUri.fsPath === resolve(repoA.root, '.git', 'refs') && watcher.pattern.pattern === '**/*'));

    blame = async () => [line('同名作者', 1, 'b'.repeat(40), 'OWN@EXAMPLE.INVALID'), line('同名作者', 2, 'b'.repeat(40), 'different@example.invalid')];
    controller.refresh();
    await until(() => visible(first)[0]?.renderOptions.before.contentText.startsWith('你 ·'));
    assert.match(visible(first)[1].renderOptions.before.contentText, /^同名作者 ·/, 'the same name with another email is not treated as the current user');
    const ownHover = handlers.hover(first.document, { line: 0 }).contents.value;
    assert.match(ownHover, /^\*\*你\*\*/, 'hover uses the same current-user label');
    assert.match(ownHover, /同名作者 · OWN@EXAMPLE/, 'hover preserves the original author and email');
    assert.match(ownHover, /command:gitpeek.internal.fileBlameCommit/);
    assert.match(ownHover, /command:gitpeek.internal.fileBlameDiff/);
    assert.match(handlers.hover(first.document, { line: 1 }).contents.value, /^\*\*同名作者\*\*/, 'other authors retain their name in hover');

    const pending = [];
    blame = () => new Promise(resolve => pending.push(resolve));
    edit('第一次编辑\n');
    assert.equal(visible(first).length, 0, 'edits synchronously clear old attribution');
    assert.equal(handlers.hover(first.document, { line: 0 }), undefined);
    await until(() => pending.length === 1);
    edit('第二次编辑\n');
    await until(() => pending.length === 2);
    pending[1]([line('最新结果')]);
    await until(() => visible(first).length === 1);
    pending[0]([line('过期结果')]);
    await tick();
    assert.match(visible(first)[0].renderOptions.before.contentText, /最新结果/);

    watchers[0].change();
    await until(() => pending.length === 3);
    head = 'c'.repeat(40);
    pending[2]([line('旧 HEAD')]);
    await until(() => pending.length === 4);
    assert.equal(visible(first).length, 0, 'HEAD drift discards completed blame before repaint');
    pending[3]([line('新 HEAD')]);
    await until(() => visible(first).length === 1);
    assert.match(visible(first)[0].renderOptions.before.contentText, /新 HEAD/);
    assert.equal(watchers.length, 4, 'refresh does not accumulate watchers');

    edit('即将切换\n');
    await until(() => pending.length === 5);
    switchEditor(second);
    assert.equal(visible(first).length, 0);
    assert.ok(watchers.every(watcher => watcher.disposed));
    assert.equal(suspended.at(-1), false);
    pending[4]([line('错误仓库')]);
    await tick();
    assert.equal(visible(first).length, 0);
    blame = async repo => [line(repo.id)];
    toggle();
    await until(() => visible(second).length === 1);
    assert.equal(calls.filter(call => call.contents).at(-1).repo.id, 'B');
    assert.match(visible(second)[0].renderOptions.before.contentText, /B/);
    handlers.close(second.document);
    assert.equal(visible(second).length, 0);
    assert.ok(watchers.every(watcher => watcher.disposed));

    switchEditor(first);
    tracked = false;
    blame = async () => { throw new Error('not in HEAD'); };
    toggle();
    await until(() => visible(first).length === 1);
    assert.equal(visible(first)[0].renderOptions.before.contentText, '你 · 未提交', 'new files degrade without fabricated commit links');
    assert.doesNotMatch(handlers.hover(first.document, { line: 0 }).contents.value, /command:/);
    assert.ok(calls.some(call => call.args?.[0] === 'ls-tree' && call.args.at(-1) === ':(literal)目录/改名.ts'));
    toggle();
    unborn = true;
    toggle();
    await until(() => visible(first).length === 1);
    assert.equal(visible(first)[0].renderOptions.before.contentText, '你 · 未提交', 'unborn HEAD is supported');

    config.enabled = false;
    handlers.config({ affectsConfiguration: name => name === 'gitpeek.enabled' });
    assert.equal(visible(first).length, 0);
    assert.equal(suspended.at(-1), false);
    assert.ok(watchers.every(watcher => watcher.disposed));
    const disabledCalls = calls.length;
    controller.refresh(); toggle(); await tick();
    assert.equal(calls.length, disabledCalls, 'disabled feature does no Git work');
    config.enabled = true; unborn = false;

    for (const contents of ['binary\0data', '中'.repeat(700_000)]) {
      first.document.contents = contents;
      const before = calls.length, messagesBefore = messages.length;
      toggle();
      await until(() => messages.length > messagesBefore);
      assert.equal(calls.length, before, 'binary or UTF-8 byte limit blocks Git calls');
      assert.equal(suspended.at(-1), false);
    }
    first.document.contents = 'line'; first.document.lines = 20_001;
    const before = calls.length, messagesBefore = messages.length;
    toggle(); await until(() => messages.length > messagesBefore);
    assert.equal(calls.length, before, 'line limit blocks Git calls');
    delete first.document.lines;

    first.document.contents = 'dispose\n'; tracked = true;
    blame = () => new Promise(resolve => pending.push(resolve));
    toggle();
    await until(() => pending.length === 6);
    controller.dispose(); controller = undefined;
    pending[5]([line('已释放')]); await tick();
    assert.equal(visible(first).length, 0);
    assert.ok(watchers.every(watcher => watcher.disposed));
    console.log('File blame passed (dirty content, stale document/HEAD, multi-repo, rename Diff, unborn/new files, limits and lifecycle).');
  } finally {
    controller?.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
}

async function tick() { await new Promise(resolve => setTimeout(resolve, 10)); }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for file blame');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
