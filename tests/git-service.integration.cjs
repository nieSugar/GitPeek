// Run with installed dev dependencies: node tests/git-service.integration.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'gitpeek-check-'))
  try {
    const compiled = join(root, 'git-service.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: compiled })
    const { GitService } = require(compiled)
    const logMessages = []
    const service = new GitService((message) => logMessages.push(message))
    const repositoryBundle = join(root, 'repository-service.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'RepositoryService.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: repositoryBundle })
    const originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return { Uri: { file: (fsPath) => ({ fsPath, scheme: 'file' }) } }
      return originalLoad.call(this, request, parent, isMain)
    }
    const { RepositoryService } = require(repositoryBundle)
    Module._load = originalLoad
    const first = join(root, '仓库 one')
    const second = join(root, 'repo-two')
    const nested = join(first, 'nested')
    mkdirSync(first)
    mkdirSync(second)
    mkdirSync(nested)
    for (const repo of [first, second]) {
      gitInit(repo)
      git(repo, 'config', 'user.name', 'GitPeek Test')
      git(repo, 'config', 'user.email', 'test@example.invalid')
    }
    gitInit(nested)
    git(nested, 'config', 'user.name', 'Nested Repo')
    git(nested, 'config', 'user.email', 'nested@example.invalid')
    writeFileSync(join(first, 'outer.txt'), 'outer\n', 'utf8')
    writeFileSync(join(nested, 'inner.txt'), 'inner\n', 'utf8')
    appendFileSync(join(first, '.git', 'info', 'exclude'), 'nested/\nouter.txt\n', 'utf8')
    const repositories = new RepositoryService(service)
    assert.equal((await repositories.forUri({ fsPath: join(first, 'outer.txt'), scheme: 'file' })).root, git(first, 'rev-parse', '--show-toplevel'))
    assert.equal((await repositories.forUri({ fsPath: join(nested, 'inner.txt'), scheme: 'file' })).root, git(nested, 'rev-parse', '--show-toplevel'))

    const source = join(first, "目录 & 'quote'", '空 格.txt')
    mkdirSync(join(first, "目录 & 'quote'"))
    writeFileSync(source, 'one\ntwo\nthree\n', 'utf8')
    git(first, 'add', '--', "目录 & 'quote'/空 格.txt")
    git(first, 'commit', '-m', 'initial')
    renameSync(source, join(first, "目录 & 'quote'", '改名.txt'))
    writeFileSync(join(first, "目录 & 'quote'", '改名.txt'), 'one\ntwo\nfour\n', 'utf8')
    git(first, 'add', '-A', '--', "目录 & 'quote'/空 格.txt", "目录 & 'quote'/改名.txt")
    git(first, 'config', 'status.renames', 'true')
    const stagedRename = await service.status({ root: first, id: 'first' })
    const renameStatus = stagedRename.files.find((file) => file.oldPath)
    assert.deepEqual(renameStatus, { index: 'R', worktree: '.', oldPath: "目录 & 'quote'/空 格.txt", path: "目录 & 'quote'/改名.txt" })
    git(first, 'commit', '-m', 'rename')

    const repoA = { root: first, id: 'first' }
    const repoB = { root: second, id: 'second' }
    const status = await service.status(repoA)
    assert.equal(status.branch, 'master')
    assert.deepEqual(status.files, [])

    const history = await service.history(repoA, "目录 & 'quote'/改名.txt")
    assert.deepEqual(history.map((item) => item.subject), ['rename', 'initial'])
    const detail = await service.commit(repoA, 'HEAD')
    assert.equal(detail.files[0].status, 'R')
    assert.equal(detail.files[0].oldPath, "目录 & 'quote'/空 格.txt")
    assert.equal(detail.files[0].path, "目录 & 'quote'/改名.txt")
    assert.equal(detail.files[0].additions, 1)
    assert.equal(detail.files[0].deletions, 1)
    const blame = await service.blame(repoA, "目录 & 'quote'/改名.txt", 2)
    assert.equal(blame[0].summary, 'initial')
    assert.equal(blame[0].filename, "目录 & 'quote'/空 格.txt")

    writeFileSync(join(first, '--特殊 & 文档.md'), 'pending\n', 'utf8')
    const dirty = await service.status(repoA)
    assert.deepEqual(dirty.files.map((file) => file.path), ['--特殊 & 文档.md'])
    assert.equal((await service.status(repoB)).files.length, 0)
    assert.notEqual(git(first, 'rev-parse', '--show-toplevel'), git(second, 'rev-parse', '--show-toplevel'))
    assert(logMessages.some((message) => /^\[GitPeek\] git status \(.+\) \d+ms$/.test(message)))
    console.log('GitService integration check passed (two repos, empty repo, NUL paths, rename, blame).')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function gitInit(repo) {
  try { git(repo, 'init', '-b', 'master') }
  catch { git(repo, 'init'); git(repo, 'checkout', '-b', 'master') }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
