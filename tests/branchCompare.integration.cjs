// Run with installed dev dependencies: node tests/branchCompare.integration.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'gitpeek-branch-'))
  try {
    const repoRoot = join(root, 'repo')
    require('node:fs').mkdirSync(repoRoot)
    git(repoRoot, 'init', '-b', 'main')
    git(repoRoot, 'config', 'user.name', 'GitPeek Test')
    git(repoRoot, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repoRoot, 'common.txt'), 'common\n', 'utf8')
    git(repoRoot, 'add', '--', 'common.txt')
    git(repoRoot, 'commit', '-m', 'common base')
    const common = git(repoRoot, 'rev-parse', 'HEAD')

    git(repoRoot, 'checkout', '-b', 'feature')
    writeFileSync(join(repoRoot, 'feature.txt'), 'feature side\n', 'utf8')
    git(repoRoot, 'add', '--', 'feature.txt')
    git(repoRoot, 'commit', '-m', 'feature change')

    git(repoRoot, 'checkout', 'main')
    writeFileSync(join(repoRoot, 'base-only.txt'), 'base side\n', 'utf8')
    git(repoRoot, 'add', '--', 'base-only.txt')
    git(repoRoot, 'commit', '-m', 'base change')
    const baseTip = git(repoRoot, 'rev-parse', 'HEAD')
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', baseTip)
    git(repoRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(repoRoot, 'checkout', 'feature')

    const bundle = join(root, 'branch-compare.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'branchCompare.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle })
    const gitBundle = join(root, 'git-service.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle })
    const originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return {}
      return originalLoad.call(this, request, parent, isMain)
    }
    const { resolveBaseBranch, loadBranchCompare } = require(bundle)
    Module._load = originalLoad
    const { GitService } = require(gitBundle)
    const gitService = new GitService()
    const repo = { root: repoRoot, id: 'test-repo' }

    assert.equal(await resolveBaseBranch(gitService, repo), 'origin/main')
    const comparison = await loadBranchCompare(gitService, repo, 'main')
    assert.equal(comparison.branch, 'feature')
    assert.equal(comparison.mergeBase, common)
    assert.equal(comparison.ahead, 1)
    assert.equal(comparison.behind, 1)
    assert.deepEqual(comparison.files.map((file) => file.path), ['feature.txt'])
    assert.deepEqual(comparison.commits.map((commit) => commit.subject), ['feature change'])
    assert.notEqual(git(repoRoot, 'merge-base', 'main', 'HEAD'), baseTip)
    assert.match(git(repoRoot, 'diff', '--name-only', 'main', 'HEAD'), /base-only\.txt/)
    await assert.rejects(resolveBaseBranch(gitService, repo, 'missing-base'), /does not exist/)

    git(repoRoot, 'checkout', '--orphan', 'unrelated')
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'no shared history\n', 'utf8')
    git(repoRoot, 'add', '-A')
    git(repoRoot, 'commit', '-m', 'unrelated root')
    await assert.rejects(loadBranchCompare(gitService, repo, 'main'), /没有共同祖先/)
    console.log('Branch compare integration check passed (diverged tips, merge-base file set, auto/manual base, unrelated history).')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
