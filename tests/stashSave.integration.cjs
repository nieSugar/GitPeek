// Run with: node tests/stashSave.integration.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const esbuild = require('esbuild');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-stash-'));
  try {
    const first = join(temp, 'first repo');
    const second = join(temp, 'second repo');
    for (const repo of [first, second]) {
      mkdirSync(repo);
      try { git(repo, 'init', '-b', 'main'); } catch { git(repo, 'init'); git(repo, 'checkout', '-b', 'main'); }
      git(repo, 'config', 'user.name', 'GitPeek Test');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'core.autocrlf', 'false');
      writeFileSync(join(repo, 'tracked.txt'), 'base\n', 'utf8');
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n', 'utf8');
      git(repo, 'add', '--', 'tracked.txt', '.gitignore');
      git(repo, 'commit', '-m', 'initial');
    }

    const compiled = join(temp, 'stash-save.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'stashSave.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled });
    const { saveStash } = require(compiled);
    const serviceFile = join(temp, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: serviceFile });
    const { GitService } = require(serviceFile);
    const service = new GitService();
    const repoA = { root: first, id: 'first' };
    const repoB = { root: second, id: 'second' };

    writeFileSync(join(first, 'tracked.txt'), 'staged\n', 'utf8');
    git(first, 'add', '--', 'tracked.txt');
    appendFileSync(join(first, 'tracked.txt'), 'unstaged\n', 'utf8');
    writeFileSync(join(first, 'new.txt'), 'untracked\n', 'utf8');
    writeFileSync(join(first, 'ignored.txt'), 'ignored\n', 'utf8');

    await saveStash(service, repoA, 'tracked only', false);
    assert.equal(readFileSync(join(first, 'tracked.txt'), 'utf8'), 'base\n');
    assert.equal(git(first, 'status', '--porcelain=v1', '-z').includes('new.txt'), true);
    assert.equal(git(first, 'stash', 'show', '--format=', '--name-only', 'stash@{0}'), 'tracked.txt');
    assert.match(git(first, 'stash', 'show', '-p', 'stash@{0}'), /staged/);
    assert.match(git(first, 'stash', 'show', '-p', 'stash@{0}'), /unstaged/);
    assert.equal(git(second, 'stash', 'list'), '');

    await saveStash(service, repoA, 'with untracked', true);
    assert.equal(git(first, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), '');
    assert.deepEqual(git(first, 'stash', 'show', '--include-untracked', '--format=', '--name-only', 'stash@{0}').split(/\r?\n/).sort(), ['new.txt']);
    assert.equal(git(first, 'check-ignore', 'ignored.txt'), 'ignored.txt');
    assert.equal(git(second, 'stash', 'list'), '');

    const beforeEmpty = git(first, 'stash', 'list');
    await assert.rejects(saveStash(service, repoA, 'empty', false), /没有可保存的更改/);
    assert.equal(git(first, 'stash', 'list'), beforeEmpty);

    writeFileSync(join(second, 'tracked.txt'), 'other repo change\n', 'utf8');
    await saveStash(service, repoB, 'second repo', false);
    assert.match(git(second, 'stash', 'list'), /second repo/);
    assert.match(git(first, 'stash', 'list'), /with untracked/);
    console.log('Stash Save integration passed (staged, unstaged, optional untracked, ignored, empty, repo isolation).');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
