// Run with: node tests/commit-detail.integration.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const esbuild = require('esbuild');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-commit-'));
  try {
    const repoPath = join(temp, '临时仓库');
    mkdirSync(repoPath);
    try { git(repoPath, 'init', '-b', 'main'); } catch { git(repoPath, 'init'); git(repoPath, 'checkout', '-b', 'main'); }
    git(repoPath, 'config', 'user.name', 'GitPeek Test');
    git(repoPath, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repoPath, 'before name.txt'), 'before\n', 'utf8');
    writeFileSync(join(repoPath, 'deleted.txt'), 'remove me\n', 'utf8');
    writeFileSync(join(repoPath, 'asset.bin'), Buffer.from([0, 1, 2, 255, 0]));
    git(repoPath, 'add', '--all');
    git(repoPath, 'commit', '-m', 'root commit');
    const rootHash = git(repoPath, 'rev-parse', 'HEAD');

    const compiled = join(temp, 'git-content.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'gitContent.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled });
    const { loadCommitDetail, loadCommitDiffContents, readCommitContent } = require(compiled);
    const serviceOut = join(temp, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: serviceOut });
    const { GitService } = require(serviceOut);
    const gitService = new GitService();
    const repo = { root: repoPath, id: 'temporary-repository' };

    const root = await loadCommitDetail(gitService, repo, rootHash);
    assert.equal(root.files.length, 3);
    const rootText = await loadCommitDiffContents(gitService, repo, root, 'before name.txt');
    assert.equal(rootText.oldContent, '');
    assert.equal(rootText.newContent, 'before\n');
    const rootBinary = await loadCommitDiffContents(gitService, repo, root, 'asset.bin');
    assert.equal(rootBinary.binary, true);
    assert.match(rootBinary.newContent, /Binary file after/);

    git(repoPath, 'mv', 'before name.txt', 'renamed name.txt');
    git(repoPath, 'rm', 'deleted.txt');
    writeFileSync(join(repoPath, 'added.txt'), 'brand new\n', 'utf8');
    git(repoPath, 'add', '--all');
    git(repoPath, 'commit', '-m', 'rename add delete');
    const changeHash = git(repoPath, 'rev-parse', 'HEAD');
    const changed = await loadCommitDetail(gitService, repo, changeHash);
    const rename = changed.files.find((file) => file.status === 'R');
    assert.ok(rename);
    assert.equal(rename.oldPath, 'before name.txt');
    assert.equal(rename.path, 'renamed name.txt');
    const renameContent = await loadCommitDiffContents(gitService, repo, changed, rename.path);
    assert.equal(renameContent.oldContent, 'before\n');
    assert.equal(renameContent.newContent, 'before\n');
    assert.equal(await readCommitContent(gitService, repo, { ref: renameContent.parent, file: rename.oldPath }), 'before\n');
    assert.equal(await readCommitContent(gitService, repo, { ref: '', file: 'before name.txt', empty: true }), '');
    await assert.rejects(readCommitContent(gitService, repo, { ref: renameContent.parent, file: 'missing.txt' }), /Git show failed/);
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'added.txt')).oldContent, '');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'added.txt')).newContent, 'brand new\n');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'deleted.txt')).oldContent, 'remove me\n');
    assert.equal((await loadCommitDiffContents(gitService, repo, changed, 'deleted.txt')).newContent, '');
    await assert.rejects(loadCommitDiffContents(gitService, repo, changed, 'missing.txt'), /not part of commit/);

    git(repoPath, 'checkout', '-b', 'side');
    writeFileSync(join(repoPath, 'side.txt'), 'side\n', 'utf8');
    git(repoPath, 'add', 'side.txt');
    git(repoPath, 'commit', '-m', 'side change');
    git(repoPath, 'checkout', 'main');
    writeFileSync(join(repoPath, 'main.txt'), 'main\n', 'utf8');
    git(repoPath, 'add', 'main.txt');
    git(repoPath, 'commit', '-m', 'main change');
    git(repoPath, 'merge', '--no-ff', 'side', '-m', 'merge change');
    const mergeHash = git(repoPath, 'rev-parse', 'HEAD');
    const merge = await loadCommitDetail(gitService, repo, mergeHash);
    assert.deepEqual(merge.files.map((file) => file.path), ['side.txt']);
    assert.equal((await loadCommitDiffContents(gitService, repo, merge, 'side.txt')).newContent, 'side\n');
    console.log('Commit detail integration passed (root, binary, added, deleted, rename, merge first-parent, invalid path).');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
