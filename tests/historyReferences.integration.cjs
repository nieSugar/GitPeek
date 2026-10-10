const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const esbuild = require('esbuild')

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), 'gitpeek-history-references-'))
  try {
    const root = join(temp, 'repo')
    mkdirSync(root)
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'GitPeek Test')
    git(root, 'config', 'user.email', 'test@example.invalid')
    const original = '原始 & [one].txt'
    const renamed = '中文目录/已改名 & [two]; name.txt'
    writeFileSync(join(root, original), 'original\nsecond line\n', 'utf8')
    writeFileSync(join(root, 'deleted.txt'), 'removed later\n', 'utf8')
    git(root, 'add', '--', original, 'deleted.txt')
    git(root, 'commit', '-m', 'original files')
    const base = git(root, 'rev-parse', 'HEAD')
    git(root, 'tag', 'investigation', base)
    git(root, 'checkout', '-b', 'investigation')
    mkdirSync(join(root, '中文目录'))
    git(root, 'mv', '--', original, renamed)
    git(root, 'commit', '-m', 'rename file')
    const renameCommit = git(root, 'rev-parse', 'HEAD')
    writeFileSync(join(root, renamed), 'original\nsecond line\nbranch change\n', 'utf8')
    git(root, 'rm', '--', 'deleted.txt')
    git(root, 'add', '--', renamed)
    git(root, 'commit', '-m', 'branch change')
    const branchHead = git(root, 'rev-parse', 'HEAD')
    git(root, 'update-ref', 'refs/remotes/origin/investigation', branchHead)
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/investigation')

    const serviceBundle = join(temp, 'git-service.cjs')
    const referencesBundle = join(temp, 'history-references.cjs')
    await Promise.all([
      esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: serviceBundle }),
      esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'historyReferences.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: referencesBundle }),
    ])
    const { GitService } = require(serviceBundle)
    const { resolveHistoryReference, listHistoryReferences, listHistoryFiles } = require(referencesBundle)
    const service = new GitService()
    const repo = { id: 'history-reference-test', root }
    const references = await listHistoryReferences(service, repo)
    assert.deepEqual(references.filter(ref => ref.label === 'investigation'), [
      { ref: 'refs/heads/investigation', label: 'investigation', description: '本地分支' },
      { ref: 'refs/tags/investigation', label: 'investigation', description: '标签' },
    ], 'a branch and tag sharing a short name retain distinct full refs')
    assert.ok(references.some(ref => ref.ref === 'refs/remotes/origin/investigation' && ref.description === '远程分支'))
    assert.ok(!references.some(ref => ref.ref === 'refs/remotes/origin/HEAD'), 'symbolic remote HEAD is not a duplicate reference')
    assert.equal(await resolveHistoryReference(service, repo, 'refs/heads/investigation'), branchHead)
    assert.equal(await resolveHistoryReference(service, repo, 'refs/tags/investigation'), base)
    assert.equal(await resolveHistoryReference(service, repo, 'refs/remotes/origin/investigation'), branchHead)
    const snapshot = await resolveHistoryReference(service, repo, 'HEAD')

    git(root, 'checkout', 'main')
    writeFileSync(join(root, original), 'main branch change\n', 'utf8')
    git(root, 'add', '--', original)
    git(root, 'commit', '-m', 'main branch change')
    writeFileSync(join(root, 'untracked.txt'), 'keep untracked\n', 'utf8')
    writeFileSync(join(root, 'staged.txt'), 'keep staged\n', 'utf8')
    git(root, 'add', '--', 'staged.txt')
    writeFileSync(join(root, original), 'keep unsaved worktree change\n', 'utf8')
    const before = {
      head: git(root, 'rev-parse', 'HEAD'),
      branch: git(root, 'symbolic-ref', 'HEAD'),
      status: git(root, 'status', '--porcelain=v2', '-z'),
      index: readFileSync(join(root, '.git', 'index')),
      contents: readFileSync(join(root, original), 'utf8'),
    }

    const history = await service.history(repo, renamed, 20, snapshot)
    assert.deepEqual(history.map(commit => [commit.hash, commit.filePath]), [
      [branchHead, renamed], [renameCommit, renamed], [base, original],
    ], 'snapshot history stays on its branch and follows the old path across a rename')
    assert.equal((await service.history(repo, original))[0].hash, before.head, 'legacy calls still follow current HEAD')
    assert.deepEqual(await listHistoryFiles(service, repo, snapshot), [renamed], 'tree paths preserve Chinese, spaces and pathspec metacharacters')
    assert.deepEqual((await service.history(repo, 'deleted.txt', 20, snapshot)).map(commit => commit.filePath), ['deleted.txt', 'deleted.txt'],
      'a known deleted path can still be investigated even though it is absent from the snapshot tree')
    await listHistoryReferences(service, repo)
    await resolveHistoryReference(service, repo, 'refs/tags/investigation')

    for (const bad of ['', 'HEAD', '--all', 'a'.repeat(41), 'a'.repeat(63), `${branchHead}\n`, 'g'.repeat(40)]) {
      await assert.rejects(service.history(repo, original, 20, bad), /提交快照无效/)
      await assert.rejects(listHistoryFiles(service, repo, bad), /提交快照无效/)
    }
    for (const bad of ['', '--all', '--output=unexpected-file', 'refs/heads/missing', 'HEAD\0', 'HEAD\n']) {
      await assert.rejects(resolveHistoryReference(service, repo, bad))
    }
    await assert.rejects(resolveHistoryReference({ run: async () => 'a'.repeat(41) }, repo, 'HEAD'), /没有有效提交/)
    const sha256 = 'a'.repeat(64)
    assert.equal(await resolveHistoryReference({ run: async () => sha256 }, repo, 'HEAD'), sha256)
    const argumentService = new GitService()
    argumentService.run = async (_repo, args) => {
      assert.equal(args[args.indexOf('--') - 1], sha256, 'SHA-256 snapshots are placed before the path separator')
      return ''
    }
    assert.deepEqual(await argumentService.history(repo, original, 20, sha256), [])

    assert.equal(git(root, 'rev-parse', 'HEAD'), before.head)
    assert.equal(git(root, 'symbolic-ref', 'HEAD'), before.branch)
    assert.equal(git(root, 'status', '--porcelain=v2', '-z'), before.status)
    assert.deepEqual(readFileSync(join(root, '.git', 'index')), before.index)
    assert.equal(readFileSync(join(root, original), 'utf8'), before.contents)
    console.log('History reference integration checks passed (snapshot isolation, refs, rename paths, Unicode, deleted paths and read-only state).')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
