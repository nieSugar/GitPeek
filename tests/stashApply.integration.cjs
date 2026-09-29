// Run with: node tests/stashApply.integration.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, sep } = require('node:path');
const esbuild = require('esbuild');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root) {
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GitPeek Stash Test');
  git(root, 'config', 'user.email', 'stash@example.invalid');
  writeFileSync(join(root, 'file.txt'), 'base\n', 'utf8');
  git(root, 'add', '--', 'file.txt');
  git(root, 'commit', '-m', 'base');
}

function stashChange(root, content, message) {
  writeFileSync(join(root, 'file.txt'), content, 'utf8');
  git(root, 'stash', 'push', '-m', message);
  return git(root, 'rev-parse', 'refs/stash');
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-stash-'));
  try {
    const bundle = join(tempRoot, 'stash-apply.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'stashApply.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const { applyStash } = require(bundle);
    const gitBundle = join(tempRoot, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle });
    const { GitService } = require(gitBundle);
    const service = new GitService();
    const repo = (root) => ({ root, id: root });

    const successRoot = join(tempRoot, 'success');
    initRepo(successRoot);
    const successOid = stashChange(successRoot, 'saved\n', 'saved change');
    const successEntry = { ref: 'stash@{0}', oid: successOid, subject: 'On main: saved change', time: 0 };
    await applyStash(service, repo(successRoot), successEntry);
    assert.equal(git(successRoot, 'show', 'HEAD:file.txt'), 'base');
    assert.equal(require('node:fs').readFileSync(join(successRoot, 'file.txt'), 'utf8').replace(/\r\n/g, '\n'), 'saved\n');
    assert.equal(git(successRoot, 'rev-parse', 'refs/stash'), successOid);

    const conflictRoot = join(tempRoot, 'conflict');
    initRepo(conflictRoot);
    const conflictOid = stashChange(conflictRoot, 'stash version\n', 'conflicting change');
    writeFileSync(join(conflictRoot, 'file.txt'), 'head version\n', 'utf8');
    git(conflictRoot, 'commit', '-am', 'conflicting edit');
    await assert.rejects(applyStash(service, repo(conflictRoot), { ref: 'stash@{0}', oid: conflictOid, subject: 'conflicting change', time: 0 }), /执行失败/);
    assert.equal(git(conflictRoot, 'rev-parse', 'refs/stash'), conflictOid);
    assert.match(git(conflictRoot, 'status', '--porcelain'), /^UU file\.txt$/);
    assert.match(git(conflictRoot, 'show', ':1:file.txt'), /base/);
    assert.match(git(conflictRoot, 'show', ':2:file.txt'), /head version/);
    assert.match(git(conflictRoot, 'show', ':3:file.txt'), /stash version/);

    const dirtyRoot = join(tempRoot, 'dirty');
    initRepo(dirtyRoot);
    const dirtyOid = stashChange(dirtyRoot, 'stash\n', 'dirty guard');
    writeFileSync(join(dirtyRoot, 'untracked.txt'), 'keep me\n', 'utf8');
    await assert.rejects(applyStash(service, repo(dirtyRoot), { ref: 'stash@{0}', oid: dirtyOid, subject: 'dirty guard', time: 0 }), /工作区不干净/);
    assert.equal(git(dirtyRoot, 'rev-parse', 'refs/stash'), dirtyOid);
    assert.equal(git(dirtyRoot, 'status', '--porcelain'), '?? untracked.txt');

    const driftRoot = join(tempRoot, 'drift');
    initRepo(driftRoot);
    const oldOid = stashChange(driftRoot, 'old\n', 'old entry');
    stashChange(driftRoot, 'new\n', 'new entry');
    await assert.rejects(applyStash(service, repo(driftRoot), { ref: 'stash@{0}', oid: oldOid, subject: 'old entry', time: 0 }), /列表已变化/);
    assert.equal(git(driftRoot, 'show', 'HEAD:file.txt'), 'base');
    assert.equal(git(driftRoot, 'rev-parse', 'refs/stash'), git(driftRoot, 'rev-parse', 'stash@{0}'));

    const isolatedA = join(tempRoot, 'isolated-a');
    const isolatedB = join(tempRoot, 'isolated-b');
    initRepo(isolatedA);
    initRepo(isolatedB);
    const isolatedOid = stashChange(isolatedA, 'only A\n', 'only A');
    await applyStash(service, repo(isolatedA), { ref: 'stash@{0}', oid: isolatedOid, subject: 'only A', time: 0 });
    assert.equal(git(isolatedA, 'diff', '--', 'file.txt').includes('+only A'), true);
    assert.equal(git(isolatedB, 'status', '--porcelain'), '');
    assert.equal(git(isolatedB, 'show', 'HEAD:file.txt'), 'base');
    console.log('Stash apply integration check passed (success, retained stash, conflict state, dirty guard, ref drift, and repository isolation).');
  } finally {
    if (!tempRoot.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory');
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
