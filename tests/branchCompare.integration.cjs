// Run with installed dev dependencies: node tests/branchCompare.integration.cjs
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, realpathSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
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
    const watchers = []
    const subscriptions = []
    const commands = new Map(), remembered = new Map()
    let chooseBase
    const workspaceState = { get: key => remembered.get(key), update: async (key, value) => { if (value === undefined) remembered.delete(key); else remembered.set(key, value) } }
    const disposable = { dispose() {} }
    const vscode = {
      EventEmitter: class {
        listeners = new Set()
        event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) } }
        fire() { for (const listener of this.listeners) listener() }
        dispose() { this.listeners.clear() }
      },
      TreeItem: class { constructor(label) { this.label = label } },
      RelativePattern: class { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern } },
      TabInputText: class {}, TabInputTextDiff: class {}, TabInputWebview: class {},
      StatusBarAlignment: { Left: 1 }, QuickPickItemKind: { Separator: -1 },
      Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
      window: {
        tabGroups: { activeTabGroup: {} },
        createStatusBarItem: () => ({ ...disposable, hide() {}, show() {} }),
        onDidChangeActiveTextEditor: () => disposable,
        showQuickPick: async (items, options) => options.title.startsWith('GitPeek：选择比较基准') ? chooseBase?.(items) : undefined,
        showErrorMessage: async message => { assert.fail(message) },
      },
      workspace: {
        getConfiguration: () => ({ get: (key, fallback) => key === 'baseBranch' ? 'origin/main' : fallback }),
        registerTextDocumentContentProvider: () => disposable,
        onDidChangeConfiguration: () => disposable,
        createFileSystemWatcher: pattern => {
          const watcher = {
            pattern, disposed: false,
            dispose() { this.disposed = true },
            onDidChange(callback) { this.change = callback },
            onDidCreate(callback) { this.create = callback },
            onDidDelete(callback) { this.delete = callback },
          }
          watchers.push(watcher)
          return watcher
        },
      },
      commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable } },
    }
    const originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return vscode
      return originalLoad.call(this, request, parent, isMain)
    }
    const { resolveBaseBranch, loadBranchCompare, registerBranchCompare } = require(bundle)
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
    await assert.rejects(resolveBaseBranch(gitService, repo, 'missing-base'), /不存在/)

    const head = git(repoRoot, 'rev-parse', 'HEAD')
    git(repoRoot, 'branch', 'same-head', head)
    const moveBase = () => git(repoRoot, 'update-ref', 'refs/heads/main', head)
    const restoreBase = () => git(repoRoot, 'update-ref', 'refs/heads/main', baseTip)
    const racingService = Object.create(gitService)
    racingService.compare = async (repository, baseHash, headHash) => {
      assert.equal(baseHash, baseTip, 'comparison pins the base hash before any diff query')
      assert.equal(headHash, head)
      moveBase()
      try { return await gitService.compare(repository, baseHash, headHash) }
      finally { restoreBase() }
    }
    assert.deepEqual(await loadBranchCompare(racingService, repo, 'main'), comparison,
      'a base ref that changes between Git calls cannot mix merge-base, file names and counts')

    for (const [label, change, restore] of [
      ['base', moveBase, restoreBase],
      ['HEAD', () => git(repoRoot, 'update-ref', 'refs/heads/feature', common), () => git(repoRoot, 'update-ref', 'refs/heads/feature', head)],
      ['branch with the same HEAD', () => git(repoRoot, 'symbolic-ref', 'HEAD', 'refs/heads/same-head'), () => git(repoRoot, 'symbolic-ref', 'HEAD', 'refs/heads/feature')],
    ]) {
      racingService.compare = async (...args) => {
        const result = await gitService.compare(...args)
        change()
        return result
      }
      try { await assert.rejects(loadBranchCompare(racingService, repo, 'main'), /分支或基准已变化/, label) }
      finally { restore() }
    }

    const feature = registerBranchCompare({ subscriptions, workspaceState }, gitService, { pickRepository: async () => repo }, async () => {})
    await feature.show(repo)
    const refsPath = realpathSync.native(resolve(repoRoot, git(repoRoot, 'rev-parse', '--git-path', 'refs')))
    const refsWatcher = watchers.find(watcher => realpathSync.native(watcher.pattern.baseUri.fsPath) === refsPath)
    assert.ok(refsWatcher, 'watch the Git refs directory on the native platform, including Windows')
    assert.equal(refsWatcher.pattern.pattern, '**/*', 'local, remote and nested refs are recursive')
    assert.equal(feature.summary.behind, 1)
    const refreshed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Remote ref watcher did not refresh the comparison')), 5000)
      const listener = feature.onDidChange(() => { clearTimeout(timeout); listener.dispose(); resolve() })
    })
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', common)
    refsWatcher.change()
    await refreshed
    assert.equal(feature.summary.behind, 0, 'remote base updates refresh the comparison')
    git(repoRoot, 'update-ref', 'refs/remotes/origin/main', baseTip)

    const worktreeRoot = join(root, 'linked-worktree')
    git(repoRoot, 'worktree', 'add', '--detach', worktreeRoot, head)
    await feature.show({ root: worktreeRoot, id: 'linked-worktree' })
    assert.ok(refsWatcher.disposed, 'changing repository clears old watchers')
    assert.ok(watchers.some(watcher => !watcher.disposed && realpathSync.native(watcher.pattern.baseUri.fsPath) === refsPath && watcher.pattern.pattern === '**/*'),
      'linked worktrees watch their shared refs directory')
    chooseBase = items => items.find(item => item.ref === 'refs/heads/feature')
    await commands.get('gitpeek.chooseBaseBranch')()
    assert.equal(feature.summary.base, 'refs/heads/feature')
    await feature.show(repo)
    assert.equal(feature.summary.base, 'origin/main', 'another repository retains its configured default')
    chooseBase = items => items.find(item => item.ref === 'refs/heads/main')
    await commands.get('gitpeek.chooseBaseBranch')()
    assert.equal(feature.summary.base, 'refs/heads/main')
    await feature.show({ root: worktreeRoot, id: 'linked-worktree' })
    assert.equal(feature.summary.base, 'refs/heads/feature', 'the linked worktree keeps its own last selection')
    chooseBase = items => items.find(item => item.ref === undefined)
    await commands.get('gitpeek.chooseBaseBranch')()
    assert.equal(feature.summary.base, 'origin/main', 'clearing remembered selection returns to configuration')
    const pendingPick = commands.get('gitpeek.chooseBaseBranch')()
    chooseBase = async items => { await feature.show(repo); return items.find(item => item.ref === 'refs/heads/feature') }
    await pendingPick
    assert.equal(feature.summary.repo.root, repoRoot, 'a stale base picker cannot replace a newer repository')
    assert.equal(feature.summary.base, 'refs/heads/main')
    const originalCompare = gitService.compare.bind(gitService)
    let release, capturedSignal, blockNext = true
    gitService.compare = async (...args) => {
      if (blockNext) {
        blockNext = false; capturedSignal = args[3]
        await new Promise(resolve => { release = resolve })
        capturedSignal.throwIfAborted()
      }
      return originalCompare(...args)
    }
    const abandoned = feature.refresh()
    while (!release) await new Promise(resolve => setTimeout(resolve, 10))
    const latest = feature.refresh()
    assert.equal(capturedSignal.aborted, true, 'starting a newer query aborts the old read-only query')
    release(); await Promise.all([abandoned, latest])
    assert.equal(feature.summary.base, 'refs/heads/main', 'the abandoned result cannot overwrite the current selection')
    blockNext = true; release = undefined
    const closing = feature.refresh()
    while (!release) await new Promise(resolve => setTimeout(resolve, 10))
    for (const subscription of subscriptions) subscription.dispose()
    assert.equal(capturedSignal.aborted, true, 'disposal aborts pending comparisons')
    release(); await closing
    assert.equal(feature.summary, undefined)

    git(repoRoot, 'checkout', '--orphan', 'unrelated')
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'no shared history\n', 'utf8')
    git(repoRoot, 'add', '-A')
    git(repoRoot, 'commit', '-m', 'unrelated root')
    await assert.rejects(loadBranchCompare(gitService, repo, 'main'), /没有共同祖先/)
    console.log('Branch compare integration check passed (immutable snapshots, ref races, recursive remote/worktree watchers, diverged tips, unrelated history).')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
