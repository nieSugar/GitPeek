const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-batch-stage-'));
  const git = (repo, ...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const make = name => {
    const repo = { id: name, root: path.join(temp, name) }; fs.mkdirSync(repo.root);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'core.autocrlf', 'false'); return repo;
  };
  const write = (repo, file, text) => fs.writeFileSync(path.join(repo.root, file), text, 'utf8');
  const read = (repo, file) => fs.readFileSync(path.join(repo.root, file), 'utf8');
  const commit = (repo, message) => { git(repo, 'add', '--all'); git(repo, 'commit', '-m', message); };
  const index = repo => git(repo, 'ls-files', '--stage', '-z');
  try {
    const sources = ['git/GitService', 'features/stageFile', 'features/reviewChangesData'];
    await esbuild.build({ entryPoints: sources.map(file => path.join(__dirname, '../src', file + '.ts')), bundle: true,
      platform: 'node', format: 'cjs', outdir: temp, outExtension: { '.js': '.cjs' } });
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { updateFilesStage, updateFileStage } = require(path.join(temp, 'features/stageFile.cjs'));
    const { loadReviewSnapshot } = require(path.join(temp, 'features/reviewChangesData.cjs'));
    const service = new GitService(), calls = [], originalRun = service.run.bind(service);
    service.run = async (repo, args, options) => { calls.push({ repo: repo.id, args }); return originalRun(repo, args, options); };
    const state = async (repo, section, file) => (await loadReviewSnapshot(service, repo)).groups.find(group => group.section === section).files.find(item => item.path === file);
    const mutations = () => calls.filter(call => ['add', 'reset', 'rm'].includes(call.args[0]));
    const assertOneBatch = command => {
      assert.equal(calls.filter(call => call.args[0] === 'status').length, 1, 'one review snapshot for the whole batch');
      assert.equal(calls.filter(call => call.args[0] === 'ls-files').length, 1, 'one conflict query for all literal paths');
      assert.equal(mutations().length, 1); assert.equal(mutations()[0].args[0], command);
      const paths = mutations()[0].args.filter(arg => arg.startsWith(':(literal)'));
      assert.equal(new Set(paths).size, paths.length, 'duplicates and rename sides are de-duplicated');
    };
    const assertRejected = async (repo, selected, stage, pattern, guard) => {
      const before = index(repo); calls.length = 0;
      await assert.rejects(updateFilesStage(service, repo, selected, stage, guard), pattern);
      assert.equal(index(repo), before, 'a rejected batch must leave every index entry unchanged');
      assert.deepEqual(mutations(), []);
    };
    const repo = make('mixed'), other = make('other');
    const old = '旧 文件 [x].txt', renamed = '新 文件 [x].txt', deleted = '删除 [d].txt', special = '中文 [x].txt', decoy = '中文 x.txt';
    const renameText = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    for (const [file, text] of [[old, renameText], [deleted, 'deleted\n'], ['partial.txt', 'base\n'], ['untouched.txt', 'base other\n'], [special, 'special base\n'], [decoy, 'decoy base\n']]) write(repo, file, text);
    commit(repo, 'initial');
    write(other, 'other.txt', 'other index\n'); git(other, 'add', '--', 'other.txt');
    const otherIndex = index(other);
    write(repo, 'partial.txt', 'partial staged\n'); git(repo, 'add', '--', 'partial.txt'); write(repo, 'partial.txt', 'partial worktree\n');
    git(repo, 'mv', '--', old, renamed);
    const stagedPartial = await state(repo, 'staged', 'partial.txt'), stagedRename = await state(repo, 'staged', renamed);
    assert.equal(stagedRename.status, 'R');
    await assertRejected(repo, [stagedPartial, { ...stagedRename, oldPath: 'wrong.txt' }], false, /状态已变化/);
    calls.length = 0;
    await updateFilesStage(service, repo, [stagedPartial, stagedRename, stagedRename], false);
    assertOneBatch('reset'); assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.equal(read(repo, 'partial.txt'), 'partial worktree\n'); assert.equal(read(repo, renamed), renameText); assert.ok(!fs.existsSync(path.join(repo.root, old)));
    const renamePaths = mutations()[0].args;
    assert.ok(renamePaths.includes(':(literal)' + old)); assert.ok(renamePaths.includes(':(literal)' + renamed));

    fs.unlinkSync(path.join(repo.root, deleted)); write(repo, '新增.txt', 'added\n'); write(repo, '--option.txt', 'literal option\n');
    write(repo, special, 'special changed\n'); write(repo, decoy, 'decoy changed\n'); write(repo, 'untouched.txt', 'other worktree\n');
    const snapshot = await loadReviewSnapshot(service, repo);
    const chosen = snapshot.groups.flatMap(group => group.files).filter(file => ![decoy, 'untouched.txt'].includes(file.path));
    assert.ok(chosen.some(file => file.section === 'unstaged')); assert.ok(chosen.some(file => file.section === 'untracked'));
    calls.length = 0; await updateFilesStage(service, repo, chosen, true); assertOneBatch('add');
    assert.equal(git(repo, 'show', ':partial.txt'), 'partial worktree'); assert.equal(git(repo, 'show', ':' + renamed), renameText.trim());
    assert.equal(git(repo, 'show', ':' + special), 'special changed'); assert.equal(git(repo, 'show', ':' + decoy), 'decoy base');
    assert.equal(git(repo, 'show', ':untouched.txt'), 'base other'); assert.ok(!git(repo, 'ls-files', '--', deleted));
    assert.equal((await state(repo, 'staged', renamed)).status, 'R'); assert.equal(index(other), otherIndex, 'batch in one repo never touches another');
    write(repo, 'partial.txt', 'newer worktree\n'); git(repo, 'add', '--', 'untouched.txt');
    const selectedStaged = (await loadReviewSnapshot(service, repo)).groups.find(group => group.section === 'staged').files.filter(file => file.path !== 'untouched.txt');
    const disk = new Map([['partial.txt', read(repo, 'partial.txt')], [renamed, read(repo, renamed)], [special, read(repo, special)], ['新增.txt', read(repo, '新增.txt')], ['--option.txt', read(repo, '--option.txt')]]);
    calls.length = 0; await updateFilesStage(service, repo, selectedStaged, false); assertOneBatch('reset');
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'untouched.txt', 'unselected staged changes are preserved');
    for (const [file, text] of disk) assert.equal(read(repo, file), text, 'unstage must preserve all working tree files');
    assert.ok(!fs.existsSync(path.join(repo.root, old))); assert.ok(!fs.existsSync(path.join(repo.root, deleted)));
    assert.equal(index(other), otherIndex);

    const valid = await state(repo, 'unstaged', 'partial.txt'), pending = await state(repo, 'untracked', '新增.txt');
    await assertRejected(repo, [], true, /请先选择/);
    await assertRejected(repo, null, true, /请先选择/);
    await assertRejected(repo, new Array(2), true, /信息无效/);
    for (const invalid of [null, undefined, {}, { ...valid, path: '' }, { ...valid, section: 'bad' }, { ...valid, status: 'BAD' }, { ...valid, oldPath: '' }, { ...valid, path: 'bad\0path' }]) {
      await assertRejected(repo, [valid, invalid], true, /信息无效/);
    }
    await assertRejected(repo, [valid, selectedStaged[0]], true, /分组已变化/);
    await assertRejected(repo, [valid], false, /分组已变化/);
    await assertRejected(repo, [valid, { ...pending, status: 'M' }], true, /状态已变化/);
    await assertRejected(repo, [valid, pending], true, /未保存/, () => { throw new Error('文件有未保存修改。'); });
    await assertRejected(repo, [valid, pending], true, /取消/, async () => { throw new Error('用户取消。'); });
    git(repo, 'add', '--', '新增.txt');
    await assertRejected(repo, [valid, pending], true, /状态已变化/);
    await assertRejected(repo, [{ ...valid, path: '../outside' }], true, /状态已变化|不在仓库/);

    const empty = make('unborn'); write(empty, '首次 [x].txt', 'first\n'); write(empty, 'second.txt', 'second\n');
    const firstFiles = (await loadReviewSnapshot(service, empty)).groups.find(group => group.section === 'untracked').files;
    calls.length = 0; await updateFilesStage(service, empty, firstFiles, true); assertOneBatch('add');
    const firstStaged = (await loadReviewSnapshot(service, empty)).groups.find(group => group.section === 'staged').files;
    write(empty, 'second.txt', 'second worktree\n');
    await assertRejected(empty, firstStaged, false, /未保存/, () => { throw new Error('未保存。'); });
    calls.length = 0; await updateFilesStage(service, empty, firstStaged, false); assertOneBatch('rm');
    assert.equal(git(empty, 'ls-files'), ''); assert.equal(read(empty, '首次 [x].txt'), 'first\n'); assert.equal(read(empty, 'second.txt'), 'second worktree\n');
    assert.equal(index(other), otherIndex);
    await updateFileStage(service, empty, await state(empty, 'untracked', 'second.txt'), true);
    assert.equal(git(empty, 'show', ':second.txt'), 'second worktree', 'single-file wrapper keeps existing behavior');

    const conflicted = make('conflicted'); write(conflicted, 'conflict.txt', 'base\n'); write(conflicted, 'clean.txt', 'base clean\n'); commit(conflicted, 'base');
    git(conflicted, 'switch', '-c', 'side'); write(conflicted, 'conflict.txt', 'side\n'); commit(conflicted, 'side');
    git(conflicted, 'switch', 'main'); write(conflicted, 'conflict.txt', 'main\n'); commit(conflicted, 'main');
    assert.throws(() => git(conflicted, 'merge', 'side')); write(conflicted, 'clean.txt', 'clean changed\n');
    const conflicts = (await loadReviewSnapshot(service, conflicted)).groups.find(group => group.section === 'unstaged').files;
    const conflictFile = conflicts.find(file => file.path === 'conflict.txt'), cleanFile = conflicts.find(file => file.path === 'clean.txt');
    assert.ok(conflictFile); assert.ok(cleanFile);
    await assertRejected(conflicted, [cleanFile, conflictFile], true, /冲突/);
    assert.match(read(conflicted, 'conflict.txt'), /<<<<<<< HEAD/); assert.equal(read(conflicted, 'clean.txt'), 'clean changed\n');
    console.log('Batch Stage checks passed: one snapshot/mutation, mixed status, partial changes, rename, literal paths, atomic rejection, dirty guard, unborn HEAD and repository isolation.');
  } finally {
    if (!temp.startsWith(os.tmpdir() + path.sep)) throw new Error('Test directory outside temp root');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
