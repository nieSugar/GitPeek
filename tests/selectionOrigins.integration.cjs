// Run with installed dev dependencies: node tests/selectionOrigins.integration.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const esbuild = require('esbuild')

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-selection-'))
  try {
    const featureBundle = join(temp, 'selection-origins.cjs')
    const gitBundle = join(temp, 'git-service.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'selectionOrigins.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: featureBundle })
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle })
    const { aggregateOrigins, loadSelectionOrigins, toBlameLineRange } = require(featureBundle)
    const { GitService } = require(gitBundle)

    assert.deepEqual(toBlameLineRange({ line: 0, character: 0 }, { line: 3, character: 0 }), { startLine: 1, endLine: 3 })
    assert.deepEqual(toBlameLineRange({ line: 0, character: 0 }, { line: 3, character: 2 }), { startLine: 1, endLine: 4 })
    assert.deepEqual(toBlameLineRange({ line: 2, character: 1 }, { line: 2, character: 6 }), { startLine: 3, endLine: 3 })

    const repoRoot = join(temp, '仓库')
    const relativeFile = '中文 目录/源 & [文件].ts'
    const absoluteFile = join(repoRoot, relativeFile)
    mkdirSync(join(repoRoot, '中文 目录'), { recursive: true })
    gitInit(repoRoot)
    git(repoRoot, 'config', 'user.name', 'GitPeek Test')
    git(repoRoot, 'config', 'user.email', 'test@example.invalid')

    writeFileSync(absoluteFile, 'line one\nline two\nline three\nline four\n', 'utf8')
    git(repoRoot, 'add', '--', relativeFile)
    git(repoRoot, 'commit', '-m', 'initial lines')
    const initialHash = git(repoRoot, 'rev-parse', 'HEAD')

    writeFileSync(absoluteFile, 'line one\nline two changed\nline three\nline four\n', 'utf8')
    git(repoRoot, 'add', '--', relativeFile)
    git(repoRoot, 'commit', '-m', 'change second line')
    const secondHash = git(repoRoot, 'rev-parse', 'HEAD')

    writeFileSync(absoluteFile, 'line one\nline two changed\nline three\nline four changed\n', 'utf8')
    git(repoRoot, 'add', '--', relativeFile)
    git(repoRoot, 'commit', '-m', 'change fourth line')
    const fourthHash = git(repoRoot, 'rev-parse', 'HEAD')

    writeFileSync(absoluteFile, 'line one\nline two changed\nlocal line three\nline four changed\n', 'utf8')
    const service = new GitService()
    const repo = { root: repoRoot, id: repoRoot }
    const range = toBlameLineRange({ line: 0, character: 0 }, { line: 3, character: 0 })
    const blame = await service.blame(repo, relativeFile, range.startLine, range.endLine)
    const origins = aggregateOrigins(blame)

    assert.equal(blame.length, 3, 'a next-line column-zero endpoint is exclusive')
    assert.equal(origins.find((origin) => origin.hash === initialHash).lineCount, 1)
    assert.equal(origins.find((origin) => origin.hash === secondHash).lineCount, 1)
    assert.equal(origins.find((origin) => origin.hash === fourthHash), undefined)
    const local = origins.find((origin) => origin.uncommitted)
    assert.equal(local.lineCount, 1)
    assert.equal(local.hash, undefined, 'uncommitted origins cannot target commit history')

    const allLines = await service.blame(repo, relativeFile, 1, 4)
    assert.equal(aggregateOrigins(allLines).find((origin) => origin.hash === fourthHash).lineCount, 1)

    writeFileSync(join(repoRoot, 'new untracked.ts'), 'new one\nnew two\n', 'utf8')
    const untracked = await loadSelectionOrigins(service, repo, 'new untracked.ts', { startLine: 1, endLine: 2 })
    assert.equal(untracked.origins.length, 1)
    assert.equal(untracked.origins[0].summary, '未提交的更改')
    assert.equal(untracked.origins[0].lineCount, 2)
    assert.equal(untracked.origins[0].hash, undefined, 'untracked origins cannot target a commit')

    const emptyRoot = join(temp, 'empty-repo')
    mkdirSync(emptyRoot)
    gitInit(emptyRoot)
    writeFileSync(join(emptyRoot, 'empty-repo.ts'), 'line one\nline two\n', 'utf8')
    const emptyResult = await loadSelectionOrigins(service, { root: emptyRoot, id: emptyRoot }, 'empty-repo.ts', { startLine: 1, endLine: 2 })
    assert.equal(emptyResult.head, undefined)
    assert.equal(emptyResult.origins[0].lineCount, 2)

    const failingGit = {
      async run() { return 'a'.repeat(40) },
      async blame() { throw new Error('Git blame failed: permission denied') },
    }
    await assert.rejects(loadSelectionOrigins(failingGit, repo, relativeFile, { startLine: 1, endLine: 1 }), /permission denied/)
    console.log('Selection origins integration check passed (multi-commit, uncommitted, exclusive endpoint, Unicode path).')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function gitInit(repo) {
  try { git(repo, 'init', '-b', 'main') }
  catch { git(repo, 'init'); git(repo, 'checkout', '-b', 'main') }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
