// Run with: node tests/stashDrop.integration.cjs
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

function stashOids(root) {
  const output = git(root, 'stash', 'list', '--format=%H');
  return output ? output.split(/\r?\n/) : [];
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-stash-drop-'));
  try {
    const bundle = join(tempRoot, 'stash-drop.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'stashDrop.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const { dropStash } = require(bundle);
    const gitBundle = join(tempRoot, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle });
    const { GitService } = require(gitBundle);
    const service = new GitService();
    const repo = (root) => ({ root, id: root });

    const multipleRoot = join(tempRoot, 'multiple');
    initRepo(multipleRoot);
    const olderOid = stashChange(multipleRoot, 'older\n', 'older stash');
    const selectedOid = stashChange(multipleRoot, 'selected\n', 'selected stash');
    const selectedEntry = { ref: 'stash@{0}', oid: selectedOid, subject: 'selected stash', time: 0 };
    assert.deepEqual(stashOids(multipleRoot), [selectedOid, olderOid]);
    await dropStash(service, repo(multipleRoot), selectedEntry);
    assert.deepEqual(stashOids(multipleRoot), [olderOid]);
    assert.equal(git(multipleRoot, 'stash', 'list', '--format=%gd'), 'stash@{0}');

    const driftRoot = join(tempRoot, 'drift');
    initRepo(driftRoot);
    const staleOid = stashChange(driftRoot, 'stale\n', 'stale stash');
    stashChange(driftRoot, 'newer\n', 'newer stash');
    await assert.rejects(dropStash(service, repo(driftRoot), { ref: 'stash@{0}', oid: staleOid, subject: 'stale stash', time: 0 }), /列表已变化/);
    assert.deepEqual(stashOids(driftRoot), [git(driftRoot, 'rev-parse', 'stash@{0}'), staleOid]);

    const expiredRoot = join(tempRoot, 'expired');
    initRepo(expiredRoot);
    const expiredOid = stashChange(expiredRoot, 'expired\n', 'expired stash');
    git(expiredRoot, 'stash', 'drop', 'stash@{0}');
    await assert.rejects(dropStash(service, repo(expiredRoot), { ref: 'stash@{0}', oid: expiredOid, subject: 'expired stash', time: 0 }), /列表已变化或无法验证/);
    assert.deepEqual(stashOids(expiredRoot), []);

    const isolatedA = join(tempRoot, 'isolated-a');
    const isolatedB = join(tempRoot, 'isolated-b');
    initRepo(isolatedA);
    initRepo(isolatedB);
    const isolatedOid = stashChange(isolatedA, 'only A\n', 'only A');
    const otherOid = stashChange(isolatedB, 'only B\n', 'only B');
    await dropStash(service, repo(isolatedA), { ref: 'stash@{0}', oid: isolatedOid, subject: 'only A', time: 0 });
    assert.deepEqual(stashOids(isolatedA), []);
    assert.deepEqual(stashOids(isolatedB), [otherOid]);
    console.log('Stash drop integration check passed (selected entry only, ref drift, expired ref, and repository isolation).');
  } finally {
    if (!tempRoot.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory');
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
