const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-blame-'));
  const handlers = {};
  const rendered = [];
  const document = {
    uri: { scheme: 'file', fsPath: join(process.cwd(), 'sample.ts'), toString: () => 'file:sample.ts' },
    lineCount: 2, version: 1, isDirty: false,
    lineAt: (line) => ({ range: { end: { line, character: 4 } } }),
  };
  const editor = { document, selection: { active: { line: 0 } }, setDecorations: (_, items) => rendered.push(items) };
  const disposable = { dispose() {} };
  const vscode = {
    window: {
      activeTextEditor: editor,
      createTextEditorDecorationType: () => disposable,
      onDidChangeActiveTextEditor: (handler) => (handlers.active = handler, disposable),
      onDidChangeTextEditorSelection: (handler) => (handlers.selection = handler, disposable),
      onDidChangeWindowState: (handler) => (handlers.focus = handler, disposable),
    },
    workspace: {
      fs: { stat: async () => ({ size: 100 }) },
      getConfiguration: () => ({ get: (key, fallback) => key === 'blame.delay' ? 0 : fallback }),
      onDidChangeTextDocument: (handler) => (handlers.change = handler, disposable),
      onDidSaveTextDocument: (handler) => (handlers.save = handler, disposable),
      onDidChangeConfiguration: (handler) => (handlers.config = handler, disposable),
    },
    languages: { registerHoverProvider: () => disposable },
    commands: { registerCommand: () => disposable },
    env: { clipboard: { writeText: async () => {} } },
    ThemeColor: class {}, Range: class {}, Hover: class {},
    MarkdownString: class { appendMarkdown() {} },
    Disposable: { from: () => disposable },
  };
  const pending = [];
  const git = {
    run: async () => 'a'.repeat(40),
    blame: () => new Promise((resolve) => pending.push(resolve)),
  };
  const repo = { root: process.cwd(), id: 'test' };
  try {
    const output = join(temp, 'blame.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'blame.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: output });
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    let BlameController;
    try { ({ BlameController } = require(output)); } finally { Module._load = originalLoad; }
    const controller = new BlameController(git, { forUri: async () => repo });
    await until(() => pending.length === 1);
    editor.selection.active.line = 1;
    handlers.selection({ textEditor: editor });
    await until(() => pending.length === 2);
    pending[1]([{ hash: 'a'.repeat(40), author: 'New', authorTime: 1700000000, summary: 'new line' }]);
    await until(() => rendered.at(-1)?.[0]?.renderOptions?.after?.contentText?.includes('new line'));
    pending[0]([{ hash: 'b'.repeat(40), author: 'Old', authorTime: 1700000000, summary: 'old line' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(rendered.at(-1)[0].renderOptions.after.contentText, /new line/);
    document.isDirty = true;
    handlers.change({ document });
    assert.equal(rendered.at(-1)[0].renderOptions.after.contentText, '未保存的更改');
    document.isDirty = false;
    document.lineCount = 20_001;
    handlers.change({ document });
    await until(() => rendered.at(-1)?.[0]?.renderOptions?.after?.contentText === 'GitPeek：大文件已停用当前行归属显示。');
    assert.equal(pending.length, 2, 'large files must not query blame');
    document.lineCount = 2;
    vscode.workspace.fs.stat = async () => ({ size: 2 * 1024 * 1024 + 1 });
    handlers.change({ document });
    await until(() => rendered.at(-1)?.[0]?.renderOptions?.after?.contentText === 'GitPeek：大文件已停用当前行归属显示。');
    assert.equal(pending.length, 2, 'large file size must not query blame');
    document.uri = { scheme: 'file', fsPath: join(process.cwd(), 'staged-new.ts'), toString: () => 'file:staged-new.ts' };
    vscode.workspace.fs.stat = async () => ({ size: 100 });
    const commands = [];
    git.run = async (_repo, args) => { commands.push(args); return args[0] === 'ls-tree' ? '' : 'a'.repeat(40); };
    git.blame = async () => { throw new Error('no such path in HEAD'); };
    handlers.change({ document });
    await until(() => rendered.at(-1)?.[0]?.renderOptions?.after?.contentText === '你 · 未提交的更改');
    assert.ok(commands.some((args) => args[0] === 'ls-tree' && args.at(-1) === ':(literal)staged-new.ts'));
    controller.dispose();
    console.log('Blame check passed (stale result, dirty/large files, staged new file).');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for blame update');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
