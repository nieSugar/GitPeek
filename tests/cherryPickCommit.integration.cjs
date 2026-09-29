const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, sep } = require('node:path');
const esbuild = require('esbuild');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(root, name, content, message) {
  writeFileSync(join(root, name), content, 'utf8');
  git(root, 'add', '--', name);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function initRepo(root) {
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GitPeek Cherry-pick Test');
  git(root, 'config', 'user.email', 'cherry-pick@example.invalid');
  commitFile(root, 'base.txt', 'base\n', 'base');
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-cherry-pick-'));
  try {
    const bundle = join(tempRoot, 'cherry-pick.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'cherryPickCommit.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const api = require(bundle);
    const gitBundle = join(tempRoot, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle });
    const { GitService } = require(gitBundle);
    const service = new GitService();
    const repo = (path) => ({ root: path, id: path });

    const successRepo = join(tempRoot, 'success');
    initRepo(successRepo);
    git(successRepo, 'switch', '-c', 'source');
    const pickedHash = commitFile(successRepo, 'picked.txt', 'picked\n', 'pick me');
    git(successRepo, 'switch', 'main');
    await api.cherryPickCommit(service, repo(successRepo), pickedHash);
    assert.equal(git(successRepo, 'show', 'HEAD:picked.txt'), 'picked');
    await assert.rejects(api.continueCherryPick(service, repo(successRepo)), /没有进行中的 Cherry-pick/);
    await assert.rejects(api.abortCherryPick(service, repo(successRepo)), /没有进行中的 Cherry-pick/);
    await assert.rejects(api.cherryPickCommit(service, repo(successRepo), pickedHash.slice(0, 8)), /完整的十六进制/);

    const conflictRepo = join(tempRoot, 'continue');
    initRepo(conflictRepo);
    git(conflictRepo, 'switch', '-c', 'source');
    const conflictHash = commitFile(conflictRepo, 'shared.txt', 'source\n', 'source version');
    git(conflictRepo, 'switch', 'main');
    commitFile(conflictRepo, 'shared.txt', 'main\n', 'main version');
    await assert.rejects(api.cherryPickCommit(service, repo(conflictRepo), conflictHash));
    assert.equal(await api.cherryPickInProgress(service, repo(conflictRepo)), true);
    writeFileSync(join(conflictRepo, 'shared.txt'), 'resolved\n', 'utf8');
    git(conflictRepo, 'add', '--', 'shared.txt');
    await api.continueCherryPick(service, repo(conflictRepo));
    assert.equal(await api.cherryPickInProgress(service, repo(conflictRepo)), false);
    assert.equal(git(conflictRepo, 'show', 'HEAD:shared.txt'), 'resolved');

    const abortRepo = join(tempRoot, 'abort');
    initRepo(abortRepo);
    git(abortRepo, 'switch', '-c', 'source');
    const abortHash = commitFile(abortRepo, 'shared.txt', 'source\n', 'source version');
    git(abortRepo, 'switch', 'main');
    commitFile(abortRepo, 'shared.txt', 'main\n', 'main version');
    const beforeAbort = git(abortRepo, 'rev-parse', 'HEAD');
    await assert.rejects(api.cherryPickCommit(service, repo(abortRepo), abortHash));
    await api.abortCherryPick(service, repo(abortRepo));
    assert.equal(await api.cherryPickInProgress(service, repo(abortRepo)), false);
    assert.equal(git(abortRepo, 'rev-parse', 'HEAD'), beforeAbort);
    assert.equal(git(abortRepo, 'show', 'HEAD:shared.txt'), 'main');

    const guardedRepo = join(tempRoot, 'guards');
    initRepo(guardedRepo);
    git(guardedRepo, 'switch', '-c', 'source');
    const ordinaryHash = commitFile(guardedRepo, 'source.txt', 'source\n', 'source');
    git(guardedRepo, 'switch', 'main');
    writeFileSync(join(guardedRepo, 'untracked.txt'), 'dirty\n', 'utf8');
    await assert.rejects(api.cherryPickCommit(service, repo(guardedRepo), ordinaryHash), /工作区不干净/);
    rmSync(join(guardedRepo, 'untracked.txt'));
    git(guardedRepo, 'switch', '--detach', 'HEAD');
    await assert.rejects(api.cherryPickCommit(service, repo(guardedRepo), ordinaryHash), /分离 HEAD/);

    const mergeRepo = join(tempRoot, 'merge');
    initRepo(mergeRepo);
    git(mergeRepo, 'switch', '-c', 'side');
    commitFile(mergeRepo, 'side.txt', 'side\n', 'side');
    git(mergeRepo, 'switch', 'main');
    commitFile(mergeRepo, 'main.txt', 'main\n', 'main');
    git(mergeRepo, 'merge', '--no-ff', '-m', 'merge commit', 'side');
    const mergeHash = git(mergeRepo, 'rev-parse', 'HEAD');
    await assert.rejects(api.cherryPickCommit(service, repo(mergeRepo), mergeHash), /Merge Commit/);
    console.log('Cherry-pick integration check passed (success, conflict continue/abort, and safety guards).');
  } finally {
    if (!tempRoot.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory');
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
