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
  git(root, 'config', 'user.name', 'GitPeek Checkout Test');
  git(root, 'config', 'user.email', 'checkout@example.invalid');
  writeFileSync(join(root, 'file.txt'), 'first\n', 'utf8');
  git(root, 'add', '--', 'file.txt');
  git(root, 'commit', '-m', 'first');
  const first = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'file.txt'), 'second\n', 'utf8');
  git(root, 'commit', '-am', 'second');
  return { first, second: git(root, 'rev-parse', 'HEAD') };
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-checkout-'));
  try {
    const bundle = join(tempRoot, 'checkout-commit.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'checkoutCommit.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    const api = require(bundle);
    const gitBundle = join(tempRoot, 'git-service.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle });
    const { GitService } = require(gitBundle);
    const service = new GitService();
    const repo = (root) => ({ root, id: root });

    const successRoot = join(tempRoot, 'success');
    const hashes = initRepo(successRoot);
    await api.checkoutCommit(service, repo(successRoot), hashes.first);
    assert.equal(git(successRoot, 'rev-parse', 'HEAD'), hashes.first);
    assert.equal(git(successRoot, 'rev-parse', '--symbolic-full-name', 'HEAD'), 'HEAD');
    assert.equal(git(successRoot, 'status', '--porcelain'), '');
    assert.equal(git(successRoot, 'show', 'HEAD:file.txt'), 'first');

    for (const kind of ['staged', 'unstaged', 'untracked']) {
      const root = join(tempRoot, kind);
      const { second } = initRepo(root);
      if (kind === 'staged') {
        writeFileSync(join(root, 'file.txt'), 'staged\n', 'utf8');
        git(root, 'add', '--', 'file.txt');
      } else if (kind === 'unstaged') {
        writeFileSync(join(root, 'file.txt'), 'unstaged\n', 'utf8');
      } else {
        writeFileSync(join(root, 'new.txt'), 'untracked\n', 'utf8');
      }
      await assert.rejects(api.checkoutCommit(service, repo(root), git(root, 'rev-parse', 'HEAD')), /工作区不干净/);
      assert.equal(git(root, 'rev-parse', 'HEAD'), second);
    }

    const invalidRoot = join(tempRoot, 'invalid');
    const { second } = initRepo(invalidRoot);
    await assert.rejects(api.checkoutCommit(service, repo(invalidRoot), second.slice(0, 8)), /完整的十六进制/);
    await assert.rejects(api.checkoutCommit(service, repo(invalidRoot), '0'.repeat(second.length)), /fatal: Needed a single revision/);
    assert.equal(git(invalidRoot, 'rev-parse', 'HEAD'), second);

    const errorRoot = join(tempRoot, 'git-error');
    const { first } = initRepo(errorRoot);
    const errorRootHead = git(errorRoot, 'rev-parse', 'HEAD');
    const failingGit = { run: async (_repo, args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return `${first}\n`;
      if (args[0] === 'switch') throw new Error('original Git failure');
      throw new Error('unexpected Git command');
    } };
    await assert.rejects(api.checkoutCommit(failingGit, repo(errorRoot), first), /original Git failure/);
    assert.equal(git(errorRoot, 'rev-parse', 'HEAD'), errorRootHead);
    console.log('Checkout integration check passed (detached HEAD, dirty states, invalid targets, and Git error propagation).');
  } finally {
    if (!tempRoot.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory');
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
