// Run with: node tests/reviewChanges.integration.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const esbuild = require('esbuild');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-review-'));
  try {
    const repoRoot = join(temp, 'review repo');
    mkdirSync(repoRoot);
    try { git(repoRoot, 'init', '-b', 'main'); } catch { git(repoRoot, 'init'); git(repoRoot, 'checkout', '-b', 'main'); }
    git(repoRoot, 'config', 'user.name', 'GitPeek Test');
    git(repoRoot, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repoRoot, 'mixed.ts'), 'TODO remove me\nkeep\n', 'utf8');
    git(repoRoot, 'add', '--all');
    git(repoRoot, 'commit', '-m', 'initial');

    writeFileSync(join(repoRoot, 'mixed.ts'), 'cleaned\nkeep\nconsole.log("staged")\n', 'utf8');
    git(repoRoot, 'add', '--', 'mixed.ts');
    appendFileSync(join(repoRoot, 'mixed.ts'), 'debugger; // worktree\n', 'utf8');
    mkdirSync(join(repoRoot, 'nested'), { recursive: true });
    writeFileSync(join(repoRoot, 'nested', 'new.ts'), 'FIXME fix later\nconsole.log("new")\n', 'utf8');
    writeFileSync(join(repoRoot, 'nested', '.env.local'), 'TOKEN=secret\n', 'utf8');
    mkdirSync(join(repoRoot, 'certs'));
    writeFileSync(join(repoRoot, 'certs', 'private.pem'), 'private key\n', 'utf8');

    const compiled = join(temp, 'review-data.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'reviewChangesData.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled });
    const { loadReviewSnapshot, loadReviewDiff } = require(compiled);
    const serviceFile = join(temp, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: serviceFile });
    const { GitService } = require(serviceFile);
    const service = new GitService();
    const repo = { root: repoRoot, id: 'review-test' };
    const snapshot = await loadReviewSnapshot(service, repo);
    const staged = snapshot.groups.find((group) => group.section === 'staged');
    const unstaged = snapshot.groups.find((group) => group.section === 'unstaged');
    const untracked = snapshot.groups.find((group) => group.section === 'untracked');
    assert.equal(staged.files.length, 1);
    assert.equal(unstaged.files.length, 1);
    assert.equal(staged.files[0].path, unstaged.files[0].path);
    assert.deepEqual([staged.additions, staged.deletions], [2, 1]);
    assert.deepEqual([unstaged.additions, unstaged.deletions], [1, 0]);
    assert.deepEqual(untracked.files.map((file) => file.path).sort(), ['certs/private.pem', 'nested/.env.local', 'nested/new.ts']);
    assert.ok(staged.files[0].warnings.some((warning) => warning === '发现 console.log 调用（第 3 行）'));
    assert.ok(!staged.files[0].warnings.some((warning) => warning.startsWith('待办标记：TODO')));
    assert.ok(unstaged.files[0].warnings.some((warning) => warning === '发现 debugger 语句（第 4 行）'));
    assert.ok(untracked.files.find((file) => file.path === 'nested/new.ts').warnings.includes('待修复标记：FIXME（第 1 行）'));
    assert.ok(untracked.files.find((file) => file.path === 'nested/.env.local').warnings.some((warning) => warning.startsWith('敏感文件：')));
    assert.ok(untracked.files.find((file) => file.path === 'certs/private.pem').warnings.some((warning) => warning.startsWith('敏感文件：')));

    const stagedDiff = await loadReviewDiff(service, repo, 'staged', 'mixed.ts');
    const workDiff = await loadReviewDiff(service, repo, 'unstaged', 'mixed.ts');
    assert.equal(stagedDiff.oldContent, 'TODO remove me\nkeep\n');
    assert.equal(stagedDiff.newContent, 'cleaned\nkeep\nconsole.log("staged")\n');
    assert.equal(workDiff.oldContent, stagedDiff.newContent);
    assert.match(workDiff.newContent, /debugger/);
    const untrackedDiff = await loadReviewDiff(service, repo, 'untracked', 'nested/new.ts');
    assert.equal(untrackedDiff.oldContent, '');
    assert.equal(untrackedDiff.newContent, 'FIXME fix later\nconsole.log("new")\n');
    writeFileSync(join(repoRoot, 'mixed.ts'), 'latest disk value\n', 'utf8');
    const refreshedDiff = await loadReviewDiff(service, repo, 'unstaged', 'mixed.ts');
    assert.equal(refreshedDiff.newContent, 'latest disk value\n');
    await assert.rejects(loadReviewDiff(service, repo, 'untracked', 'gone.txt'), /已不存在/);
    console.log('Review Changes integration passed (split status, numstat, nested untracked, warnings, fresh diffs).');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
