const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-selection-check-'));
  const originalLoad = Module._load;
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const make = name => {
    const repo = { id: name, root: path.join(temp, name) }; fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); return repo;
  };
  try {
    await esbuild.build({ entryPoints: ['git/GitService', 'features/selectionSnapshot', 'features/selectionHistory'].map(name => path.join(__dirname, '../src', `${name}.ts`)),
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outdir: temp, outExtension: { '.js': '.cjs' } });
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { mapSelectionSnapshot } = require(path.join(temp, 'features/selectionSnapshot.cjs'));
    const service = new GitService(), repo = make('repo');
    const file = '中文 [x].txt', original = 'one\ntwo\nthree\nfour\n';
    fs.writeFileSync(path.join(repo.root, file), original, 'utf8'); git(repo, 'add', '--all'); git(repo, 'commit', '-m', 'initial');
    const head = git(repo, 'rev-parse', 'HEAD');
    const range = (startLine, endLine = startLine) => ({ startLine, endLine });
    const spans = (current, committed) => [{ current, committed }];
    const map = (text, selection) => mapSelectionSnapshot(service, repo, file, text, selection);
    assert.deepEqual((await map('prefix\n' + original, range(3))).ranges, spans(range(3), range(2)));
    assert.deepEqual((await map('two\nthree\nfour\n', range(2))).ranges, spans(range(2), range(3)));
    assert.deepEqual((await map(original.replace(/\n/g, '\r\n'), range(2, 3))).ranges, spans(range(2, 3), range(2, 3)));
    assert.deepEqual((await map('one\nlocal\nthree\nfour\n', range(1, 3))).ranges,
      [...spans(range(1), range(1)), ...spans(range(3), range(3))]);
    assert.deepEqual((await map('one\nthree\nfour\n', range(1, 2))).ranges,
      [...spans(range(1), range(1)), ...spans(range(2), range(3))], 'deleted lines are not silently included in a selected range');
    assert.deepEqual((await map('new\n', range(1))).ranges, []);
    assert.deepEqual((await map('', range(1))).ranges, []);
    assert.deepEqual((await map(original, range(5))).ranges, [], 'editor trailing empty line has no Git history');
    assert.deepEqual((await map(original + 'new\n', range(5))).ranges, []);
    assert.equal((await map(original, range(1))).head, head);
    await assert.rejects(map('x\0y', range(1)), /二进制/);
    await assert.rejects(map('x'.repeat(2 * 1024 * 1024 + 1), range(1)), /2 MB/);
    await assert.rejects(map(original, range(0)), /行号/);
    await assert.rejects(mapSelectionSnapshot(service, repo, '../outside', original, range(1)), /不在仓库/);
    assert.deepEqual((await mapSelectionSnapshot(service, make('empty'), 'new.txt', 'new\n', range(1))).ranges, []);
    assert.deepEqual((await mapSelectionSnapshot(service, repo, 'untracked.txt', 'new\n', range(1))).ranges, []);

    git(repo, 'config', 'diff.interHunkContext', '5');
    assert.deepEqual((await map('FIRST\ntwo\nthree\nLAST\n', range(2, 3))).ranges, spans(range(2, 3), range(2, 3)), 'user inter-hunk settings cannot hide unchanged lines');
    git(repo, 'config', '--unset', 'diff.interHunkContext');
    const bom = make('bom');
    fs.writeFileSync(path.join(bom.root, file), '\uFEFFone\ntwo\n', 'utf8'); git(bom, 'add', '--all'); git(bom, 'commit', '-m', 'BOM');
    assert.deepEqual((await mapSelectionSnapshot(service, bom, file, 'one\ntwo\n', range(1))).ranges, spans(range(1), range(1)), 'editor BOM metadata does not make line one look rewritten');

    const commands = new Map(), infos = [], errors = [], opened = [];
    const disposable = { dispose() {} };
    let snapshotText = 'prefix\n' + original, pick = async items => items[0];
    const document = { uri: { scheme: 'file', fsPath: path.join(repo.root, file) }, isDirty: true, version: 1, getText: () => snapshotText };
    const selection = { isEmpty: false, start: { line: 2, character: 0 }, end: { line: 3, character: 0 } };
    const vscode = {
      workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: { activeTextEditor: { document, selection }, showQuickPick: async (items, options) => pick(items, options),
        showInformationMessage: async message => infos.push(message), showErrorMessage: async message => errors.push(message) },
      commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable; } },
    };
    Module._load = function (name, parent, main) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, main); };
    const { registerSelectionHistory } = require(path.join(temp, 'features/selectionHistory.cjs'));
    registerSelectionHistory({ subscriptions: [] }, service, { forUri: async () => repo },
      async () => assert.fail('known paths open the file Diff'), async (...args) => opened.push(args));
    await commands.get('gitpeek.selectionHistory')();
    assert.deepEqual(opened.pop(), [repo, head, file, file, { historyHead: head, historyFile: file }], 'unsaved insertion maps without saving');
    snapshotText = 'one\nlocal\nthree\nfour\n'; document.version++;
    selection.start.line = 0;
    let picks = 0;
    pick = async (items, options) => {
      if (++picks === 1) { assert.match(options.title, /未提交/); assert.equal(items.length, 2); return items[1]; }
      return items[0];
    };
    await commands.get('gitpeek.selectionHistory')(); assert.equal(picks, 2); assert.equal(opened.pop()[1], head);
    snapshotText = 'new\n'; document.version++; selection.end.line = 1;
    await commands.get('gitpeek.selectionHistory')(); assert.match(infos.pop(), /新增或改写/); assert.equal(opened.length, 0);
    snapshotText = original; document.version++;
    pick = async items => { document.version++; return items[0]; };
    await commands.get('gitpeek.selectionHistory')(); assert.equal(opened.length, 0, 'document edits invalidate an open picker');
    pick = async () => undefined;
    await commands.get('gitpeek.selectionHistory')(); assert.equal(opened.length, 0);
    assert.deepEqual(errors, []);
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8'), original, 'editor queries never save the buffer');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'editor queries never modify the index');

    const renamed = '新路径 [x].txt'; git(repo, 'mv', '--', file, renamed);
    const indexBefore = git(repo, 'ls-files', '--stage');
    const renamedSnapshot = await mapSelectionSnapshot(service, repo, renamed, 'prefix\n' + original, range(3));
    assert.equal(renamedSnapshot.file, file);
    assert.deepEqual(renamedSnapshot.ranges, spans(range(3), range(2)));
    assert.equal(git(repo, 'ls-files', '--stage'), indexBefore);
    document.uri.fsPath = path.join(repo.root, renamed); document.version++;
    snapshotText = original; pick = async items => items[0];
    await commands.get('gitpeek.selectionHistory')();
    assert.deepEqual(opened.pop(), [repo, head, file, renamed, { historyHead: head, historyFile: file }], 'staged rename passes HEAD path separately from workspace path');
    console.log('Selection snapshots passed: unsaved/staged mappings, insert/delete/rewrite, CRLF, mixed ranges, rename, cancellation and no disk/index writes.');
  } finally {
    Module._load = originalLoad;
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
