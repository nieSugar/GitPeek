const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, sep } = require('node:path')
const esbuild = require('esbuild')

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(root, label) {
  mkdirSync(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'GitPeek Stash Test')
  git(root, 'config', 'user.email', 'stash@example.invalid')
  writeFileSync(join(root, 'tracked.txt'), `${label} base\n`, 'utf8')
  git(root, 'add', '--', 'tracked.txt')
  git(root, 'commit', '-m', 'base')
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-stash-list-'))
  try {
    const bundle = join(tempRoot, 'stash-list.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'stashList.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle })
    const gitBundle = join(tempRoot, 'git-service.cjs')
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle })
    const api = require(bundle)
    const { GitService } = require(gitBundle)
    const service = new GitService()
    const repo = (root) => ({ root, id: root })

    const firstRoot = join(tempRoot, 'first')
    initRepo(firstRoot, 'first')
    assert.deepEqual(await api.listStashes(service, repo(firstRoot)), [])

    writeFileSync(join(firstRoot, 'untracked 中文.txt'), 'one\ntwo\n', 'utf8')
    git(firstRoot, 'stash', 'push', '--include-untracked', '-m', '包含未跟踪文件')
    writeFileSync(join(firstRoot, 'tracked.txt'), 'first base\nchanged\n', 'utf8')
    git(firstRoot, 'stash', 'push', '-m', '跟踪文件更改')

    const entries = await api.listStashes(service, repo(firstRoot))
    assert.equal(entries.length, 2)
    assert.match(entries[0].ref, /^stash@\{0\}$/)
    assert.match(entries[0].oid, /^[0-9a-f]{40,64}$/i)
    assert.equal(entries[0].subject, 'On main: 跟踪文件更改')
    assert.ok(entries[0].time > 0)
    assert.equal(entries[1].subject, 'On main: 包含未跟踪文件')

    const trackedPreview = await api.previewStash(service, repo(firstRoot), entries[0])
    assert.deepEqual(trackedPreview.files.map((file) => [file.path, file.status, file.additions, file.deletions]), [['tracked.txt', 'M', 1, 0]])
    const untrackedPreview = await api.previewStash(service, repo(firstRoot), entries[1])
    assert.deepEqual(untrackedPreview.files.map((file) => [file.path, file.status, file.additions, file.deletions]), [['untracked 中文.txt', 'A', 2, 0]])
    assert.equal(untrackedPreview.additions, 2)
    assert.equal(untrackedPreview.deletions, 0)

    const staleByShift = entries[0]
    writeFileSync(join(firstRoot, 'tracked.txt'), 'first base\nnewer\n', 'utf8')
    git(firstRoot, 'stash', 'push', '-m', '外部新增')
    await assert.rejects(api.assertStashIdentity(service, repo(firstRoot), staleByShift), /列表已变化/)
    assert.equal((await api.listStashes(service, repo(firstRoot)))[1].oid, staleByShift.oid)
    git(firstRoot, 'stash', 'clear')
    await assert.rejects(api.assertStashIdentity(service, repo(firstRoot), staleByShift), /列表已变化/)

    const secondRoot = join(tempRoot, 'second')
    initRepo(secondRoot, 'second')
    assert.deepEqual(await api.listStashes(service, repo(secondRoot)), [])
    writeFileSync(join(secondRoot, 'other.txt'), 'other\n', 'utf8')
    git(secondRoot, 'stash', 'push', '--include-untracked', '-m', 'second repo')
    assert.equal((await api.listStashes(service, repo(firstRoot))).length, 0)
    assert.equal((await api.listStashes(service, repo(secondRoot))).length, 1)

    console.log('Stash list integration check passed (empty list, Unicode subjects, tracked and untracked preview, stale refs, and repository isolation).')
  } finally {
    if (!tempRoot.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory')
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
