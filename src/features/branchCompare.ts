import * as vscode from 'vscode'
import { basename, dirname, resolve } from 'node:path'
import type { GitService } from '../git/GitService'
import type { RepositoryService } from '../git/RepositoryService'
import type { BranchComparison, FileChange, Repository } from '../git/types'
import { isGitPeekEditor } from './virtualEditor'

const CONTENT_SCHEME = 'gitpeek-branch'
const FALLBACK_BASES = ['main', 'master', 'develop']
type ShowCommit = (repo: Repository, hash: string) => void | Promise<void>

export interface BranchCompareSummary {
  repo: Repository
  branch: string
  base: string
  head: string
  mergeBase: string
  ahead: number
  behind: number
  commits: BranchComparison['commits']
  files: FileChange[]
  additions: number
  deletions: number
}

export interface BranchCompareFeature {
  show(repo?: Repository): Promise<void>
  refresh(): Promise<void>
  readonly onDidChange: vscode.Event<void>
  readonly items: readonly vscode.TreeItem[]
  readonly summary?: BranchCompareSummary
}

export async function resolveBaseBranch(git: GitService, repo: Repository, configured = 'auto', signal?: AbortSignal): Promise<string> {
  const exists = async (ref: string): Promise<boolean> => {
    try {
      await git.run(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { signal })
      return true
    } catch { signal?.throwIfAborted(); return false }
  }

  if (configured !== 'auto') {
    if (await exists(configured)) return configured
    throw new Error(`配置的基准分支“${configured}”不存在或没有提交。`)
  }

  try {
    const target = (await git.run(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { signal })).trim()
    const originHead = target.replace(/^refs\/remotes\//, '')
    if (originHead !== target && await exists(originHead)) return originHead
  } catch { signal?.throwIfAborted() }

  for (const candidate of FALLBACK_BASES) if (await exists(candidate)) return candidate
  throw new Error('未找到基准分支。请将 gitpeek.baseBranch 设置为已有分支。')
}

export async function loadBranchCompare(git: GitService, repo: Repository, base: string, signal?: AbortSignal): Promise<BranchCompareSummary> {
  const readRefs = () => Promise.all([
    git.status(repo, signal),
    git.run(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], { signal }).then((value) => value.trim()),
    git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { signal }).then((value) => value.trim()),
  ] as const)
  const [status, head, baseHead] = await readRefs()
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('当前分支尚无提交。')
  if (!/^[0-9a-f]{40,64}$/i.test(baseHead)) throw new Error(`基准分支“${base}”没有有效提交。`)

  let mergeBase: string
  try {
    mergeBase = (await git.run(repo, ['merge-base', baseHead, head], { signal })).trim()
  } catch {
    signal?.throwIfAborted()
    throw new Error(`基准分支“${base}”与当前分支没有共同祖先。`)
  }
  if (!mergeBase) throw new Error(`基准分支“${base}”与当前分支没有共同祖先。`)

  // GitService.compare uses base...HEAD for the file set and counts; that diff is merge-base(base, HEAD) → HEAD.
  const comparison = await git.compare(repo, baseHead, head, signal)
  const [latestStatus, latestHead, latestBase] = await readRefs()
  if (latestHead !== head || latestBase !== baseHead || latestStatus.branch !== status.branch) {
    throw new Error('分支或基准已变化，请重新运行“与基准分支比较”。')
  }
  const additions = comparison.files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const deletions = comparison.files.reduce((total, file) => total + (file.deletions ?? 0), 0)
  return {
    repo, branch: status.branch ?? 'HEAD', base, head, mergeBase,
    ahead: comparison.ahead, behind: comparison.behind, commits: comparison.commits,
    files: comparison.files, additions, deletions,
  }
}

interface ContentRef {
  repoId: string
  root: string
  ref: string
  file: string
  empty?: boolean
  binary?: boolean
}

class BranchContentProvider implements vscode.TextDocumentContentProvider {
  private readonly repos = new Map<string, Repository>()
  private readonly contents = new Map<string, string>()

  constructor(private readonly git: GitService) {}

  register(repo: Repository): void { this.repos.set(`${repo.id}\0${repo.root}`, repo) }

  uri(repo: Repository, ref: string, file: string, empty = false, binary = false): vscode.Uri {
    const query: ContentRef = { repoId: repo.id, root: repo.root, ref, file, ...(empty ? { empty: true } : {}), ...(binary ? { binary: true } : {}) }
    return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${file}`, query: JSON.stringify(query) })
  }

  cache(uri: vscode.Uri, contents: string): void {
    this.contents.set(uri.toString(), contents)
    if (this.contents.size > 32) this.contents.delete(this.contents.keys().next().value!)
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cached = this.contents.get(uri.toString())
    if (cached !== undefined) return cached
    const ref = JSON.parse(uri.query) as ContentRef
    const repo = this.repos.get(`${ref.repoId}\0${ref.root}`)
    if (!repo) throw new Error('此分支差异的仓库上下文不可用。')
    if (ref.empty) return ''
    if (ref.binary) return `[二进制文件：${ref.file}]\n`
    return this.git.run(repo, ['show', `${ref.ref}:${ref.file}`])
  }
}

export function registerBranchCompare(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: ShowCommit,
): BranchCompareFeature {
  const content = new BranchContentProvider(git)
  const changed = new vscode.EventEmitter<void>()
  let activeRepo: Repository | undefined
  let currentSummary: BranchCompareSummary | undefined
  let currentItems: vscode.TreeItem[] = []
  let generation = 0
  let editorGeneration = 0
  let watchedRepoId: string | undefined
  let watcherRequest = 0
  let repoWatchers: vscode.Disposable[] = []
  let query: AbortController | undefined
  let diffQuery: AbortController | undefined
  let baseQuery: AbortController | undefined
  let watcherQuery: AbortController | undefined
  let disposed = false
  const baseKey = (repo: Repository): string => `gitpeek.branchBase:${repo.id}\0${repo.root}`
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  statusBar.text = '$(git-branch) GitPeek：与基准分支比较'
  statusBar.tooltip = 'GitPeek：比较当前分支与基准分支'
  statusBar.command = 'gitpeek.showBranchChanges'
  statusBar.hide()

  const provider = vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content)
  context.subscriptions.push(changed, statusBar, provider)

  const updateView = (error?: string): void => {
    currentItems = currentSummary ? createItems(currentSummary) : error ? [new vscode.TreeItem(error)] : []
    changed.fire()
  }

  const enabled = (): boolean => vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)
  const clearWatchers = (): void => {
    watcherRequest++
    watcherQuery?.abort()
    for (const watcher of repoWatchers) watcher.dispose()
    repoWatchers = []
    watchedRepoId = undefined
  }
  const clearState = (message: string): void => {
    generation++
    query?.abort()
    diffQuery?.abort()
    baseQuery?.abort()
    currentSummary = undefined
    statusBar.hide()
    updateView(message)
  }

  const installWatchers = async (repo: Repository): Promise<void> => {
    if (disposed || !enabled() || activeRepo?.id !== repo.id || activeRepo?.root !== repo.root || watchedRepoId === baseKey(repo)) return
    clearWatchers()
    const controller = watcherQuery = new AbortController()
    const request = watcherRequest
    watchedRepoId = baseKey(repo)
    let paths: string[]
    try {
      paths = await Promise.all(['HEAD', 'packed-refs', 'refs', 'logs/HEAD'].map(async (path) =>
        resolve(repo.root, (await git.run(repo, ['rev-parse', '--git-path', path], { signal: controller.signal })).trim())))
    } catch {
      if (request === watcherRequest) watchedRepoId = undefined
      return
    }
    if (request !== watcherRequest || !enabled() || activeRepo?.id !== repo.id || activeRepo?.root !== repo.root) return
    const watchers: vscode.FileSystemWatcher[] = []
    for (const path of paths) {
      const isRefsDir = basename(path) === 'refs'
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(isRefsDir ? path : dirname(path)), isRefsDir ? '**/*' : basename(path)))
      watcher.onDidChange(() => { if (enabled() && activeRepo?.id === repo.id && activeRepo?.root === repo.root) void refresh() })
      watcher.onDidCreate(() => { if (enabled() && activeRepo?.id === repo.id && activeRepo?.root === repo.root) void refresh() })
      watcher.onDidDelete(() => { if (enabled() && activeRepo?.id === repo.id && activeRepo?.root === repo.root) void refresh() })
      watchers.push(watcher)
    }
    repoWatchers = watchers
    context.subscriptions.push(...watchers)
  }

  const refresh = async (): Promise<void> => {
    query?.abort()
    diffQuery?.abort()
    if (disposed) return
    if (!enabled()) { clearState('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。'); return }
    const repo = activeRepo
    if (!repo) { statusBar.hide(); currentSummary = undefined; updateView('打开 Git 文件以比较其所在分支。'); return }
    const request = ++generation
    const controller = query = new AbortController()
    currentSummary = undefined
    statusBar.show()
    try {
      const configured = vscode.workspace.getConfiguration('gitpeek').get<string>('baseBranch', 'auto')
      const remembered = context.workspaceState?.get<string>(baseKey(repo))
      const base = await resolveBaseBranch(git, repo, remembered ?? configured, controller.signal)
      const summary = await loadBranchCompare(git, repo, base, controller.signal)
      if (request !== generation) return
      currentSummary = summary
      content.register(repo)
      statusBar.text = `$(git-branch) ${summary.branch} ↑${summary.ahead} ↓${summary.behind}`
      statusBar.tooltip = `${summary.base} · ${summary.files.length} 个文件已更改 · +${summary.additions} −${summary.deletions}`
      updateView()
    } catch (error) {
      if (request !== generation) return
      currentSummary = undefined
      statusBar.text = '$(git-branch) GitPeek：与基准分支比较'
      statusBar.tooltip = errorMessage(error)
      updateView(errorMessage(error))
    }
  }

  const openDiff = async (summary: BranchCompareSummary, file: FileChange): Promise<void> => {
    diffQuery?.abort()
    const controller = diffQuery = new AbortController()
    try {
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
        return
      }
      const request = generation
      const oldPath = file.status === 'R' ? file.oldPath ?? file.path : file.path
      const oldEmpty = file.status === 'A'
      const newEmpty = file.status === 'D'
      const pathspecs = (file.oldPath ? [file.oldPath, file.path] : [file.path]).map((path) => `:(literal)${path}`)
      const stats = await git.run(summary.repo, ['diff', '--numstat', '-z', summary.mergeBase, summary.head, '--', ...pathspecs], { signal: controller.signal })
      const binary = stats.split('\0').some((record) => record.startsWith('-\t-\t'))
      const oldContent = oldEmpty ? '' : binary ? binaryLabel(oldPath, 'before') : await git.run(summary.repo, ['show', `${summary.mergeBase}:${oldPath}`], { signal: controller.signal })
      const newContent = newEmpty ? '' : binary ? binaryLabel(file.path, 'after') : await git.run(summary.repo, ['show', `${summary.head}:${file.path}`], { signal: controller.signal })
      if (controller.signal.aborted) return
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
        return
      }
      if (request !== generation || currentSummary !== summary) {
        await vscode.window.showInformationMessage('GitPeek 分支数据已变化，请重新运行“与基准分支比较”。')
        return
      }
      const oldUri = content.uri(summary.repo, summary.mergeBase, oldPath, oldEmpty, binary)
      const newUri = content.uri(summary.repo, summary.head, file.path, newEmpty, binary)
      content.cache(oldUri, oldContent)
      content.cache(newUri, newContent)
      const title = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} (${summary.base} → ${summary.branch})`
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title)
    } catch (error) {
      if (controller.signal.aborted || disposed) return
      await vscode.window.showErrorMessage(`GitPeek：无法打开分支差异：${errorMessage(error)}`)
    }
  }

  const chooseBase = async (): Promise<void> => {
    if (!enabled() || disposed) return
    const editorRepo = vscode.window.activeTextEditor ? await repositories.forUri(vscode.window.activeTextEditor.document.uri) : undefined
    const repo = editorRepo ?? activeRepo ?? await repositories.pickRepository()
    if (!repo || !enabled() || disposed) return
    baseQuery?.abort()
    const controller = baseQuery = new AbortController()
    const request = generation
    try {
      const output = await git.run(repo, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/'], { signal: controller.signal })
      if (controller.signal.aborted || disposed) return
      const configured = vscode.workspace.getConfiguration('gitpeek').get<string>('baseBranch', 'auto')
      const remembered = context.workspaceState?.get<string>(baseKey(repo))
      const choices = [
        { label: `使用配置默认（${configured}）`, description: '清除本仓库记住的选择', ref: undefined as string | undefined },
        { label: '自动检测（auto）', description: '远程默认分支或 main / master / develop', ref: 'auto' },
        ...output.split('\n').flatMap(line => {
          const [ref, symbolic] = line.replace(/\r$/, '').split('\0')
          if (!ref || symbolic) return []
          return [{ label: ref.replace(/^refs\/(heads|remotes)\//, ''), description: `${ref.startsWith('refs/heads/') ? '本地分支' : '远程分支'}${ref === remembered ? ' · 最近选择' : ''}`, ref }]
        }),
      ]
      const selected = await vscode.window.showQuickPick(choices, { title: `GitPeek：选择比较基准 · ${basename(repo.root)}`, placeHolder: '只记住此仓库的选择；文件比较仍为共同祖先 → HEAD', matchOnDescription: true })
      if (!selected || controller.signal.aborted || request !== generation || !enabled() || disposed) return
      const application = ++generation
      query?.abort()
      diffQuery?.abort()
      currentSummary = undefined
      updateView('正在更新比较基准。')
      await context.workspaceState.update(baseKey(repo), selected.ref)
      if (application !== generation || disposed || !enabled()) return
      activeRepo = repo
      await installWatchers(repo)
      await refresh()
    } catch (error) {
      if (!controller.signal.aborted && !disposed) await vscode.window.showErrorMessage(`GitPeek：无法选择基准：${errorMessage(error)}`)
    }
  }

  const show = async (repo?: Repository): Promise<void> => {
    if (!enabled()) {
      await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      return
    }
    const editorRepo = vscode.window.activeTextEditor
      ? await repositories.forUri(vscode.window.activeTextEditor.document.uri)
      : undefined
    if (!enabled()) {
      await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      return
    }
    const selectedRepo = repo ?? editorRepo ?? await repositories.pickRepository()
    if (!selectedRepo) {
      await vscode.window.showInformationMessage('GitPeek：请打开 Git 仓库中的文件，或选择一个仓库。')
      return
    }
    activeRepo = selectedRepo
    statusBar.show()
    await installWatchers(selectedRepo)
    await refresh()
    if (!enabled()) {
      await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      return
    }
    const summary = currentSummary
    if (!summary) {
      await vscode.window.showErrorMessage(`GitPeek：${currentItems[0]?.label ?? '当前无法进行分支比较。'}`)
      return
    }
    const choices: Array<vscode.QuickPickItem & { commit?: string; file?: FileChange }> = [
      { label: `$(git-branch) ${summary.branch} 对比 ${summary.base} · ↑${summary.ahead} ↓${summary.behind} · ${summary.files.length} 个文件 · +${summary.additions} −${summary.deletions}`, kind: vscode.QuickPickItemKind.Separator },
      { label: '分支提交', kind: vscode.QuickPickItemKind.Separator },
      ...summary.commits.map((commit) => ({ label: `${commit.shortHash} ${commit.subject}`, description: `${commit.author} · ${new Date(commit.date).toLocaleDateString('zh-CN')}`, commit: commit.hash })),
      { label: '变更文件 · 基准提交 → HEAD', kind: vscode.QuickPickItemKind.Separator },
      ...summary.files.map((file) => ({ label: `${statusLabel(file.status)} ${file.path}`, description: `+${file.additions ?? 0} −${file.deletions ?? 0}${file.oldPath ? ` · 来源于 ${file.oldPath}` : ''}`, file })),
    ]
    const selected = await vscode.window.showQuickPick(choices, { title: `${summary.branch} 对比 ${summary.base}`, matchOnDescription: true, placeHolder: '选择一个提交或文件' })
    if (!enabled()) {
      await vscode.window.showInformationMessage('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      return
    }
    if (selected?.commit) await showCommit(summary.repo, selected.commit)
    else if (selected?.file) await openDiff(summary, selected.file)
  }

  const handleActiveEditor = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    if (isGitPeekEditor(editor)) return
    baseQuery?.abort()
    if (!enabled()) {
      editorGeneration++
      activeRepo = undefined
      clearWatchers()
      clearState('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      return
    }
    if (!editor) {
      editorGeneration++
      activeRepo = undefined
      clearWatchers()
      clearState('打开 Git 文件以比较其所在分支。')
      return
    }
    const request = ++editorGeneration
    generation++
    query?.abort()
    diffQuery?.abort()
    activeRepo = undefined
    currentSummary = undefined
    clearWatchers()
    statusBar.hide()
    updateView('正在解析当前 Git 仓库。')
    const repo = await repositories.forUri(editor.document.uri)
    if (request !== editorGeneration || !enabled()) return
    activeRepo = repo
    if (!repo) {
      clearWatchers()
      clearState('此文件不属于任何 Git 仓库。')
      return
    }
    statusBar.show()
    await installWatchers(repo)
    if (request === editorGeneration && enabled()) await refresh()
  }
  const onActiveEditor = vscode.window.onDidChangeActiveTextEditor((editor) => { void handleActiveEditor(editor) })
  const onConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('gitpeek.enabled')) {
      if (enabled()) void handleActiveEditor(vscode.window.activeTextEditor)
      else {
        editorGeneration++
        activeRepo = undefined
        clearWatchers()
        clearState('GitPeek 分支比较已禁用。请启用 gitpeek.enabled 后使用。')
      }
    } else if (event.affectsConfiguration('gitpeek.baseBranch') && enabled()) void refresh()
  })
  context.subscriptions.push(onActiveEditor, onConfiguration,
    { dispose() { disposed = true; clearWatchers(); clearState(''); } },
    vscode.commands.registerCommand('gitpeek.chooseBaseBranch', chooseBase),
    vscode.commands.registerCommand('gitpeek.compareWithBase', async (uri?: vscode.Uri) => {
      if (!uri) return show()
      const repo = await repositories.forUri(uri)
      if (repo) await show(repo)
      else await vscode.window.showInformationMessage('GitPeek：此文件不属于任何 Git 仓库。')
    }),
    vscode.commands.registerCommand('gitpeek.showBranchChanges', () => show()),
    vscode.commands.registerCommand('gitpeek.internal.branch.showCommit', (repo: Repository, hash: string) => showCommit(repo, hash)),
    vscode.commands.registerCommand('gitpeek.internal.branch.openDiff', (summary: BranchCompareSummary, file: FileChange) => openDiff(summary, file)),
  )

  void handleActiveEditor(vscode.window.activeTextEditor)

  return {
    show,
    refresh,
    onDidChange: changed.event,
    get items() { return currentItems },
    get summary() { return currentSummary },
  }

  function createItems(summary: BranchCompareSummary): vscode.TreeItem[] {
    return [
      Object.assign(treeItem('选择比较基准…', summary.base), { command: { command: 'gitpeek.chooseBaseBranch', title: '选择比较基准' } }),
      treeItem(`${summary.branch} 对比 ${summary.base} · ↑${summary.ahead} ↓${summary.behind}`),
      treeItem(`提交 (${summary.commits.length})`),
      ...summary.commits.map((commit) => {
        const item = treeItem(`${commit.shortHash} ${commit.subject}`, `${commit.author} · ${new Date(commit.date).toLocaleDateString('zh-CN')}`)
        item.command = { command: 'gitpeek.internal.branch.showCommit', title: '查看提交', arguments: [summary.repo, commit.hash] }
        item.contextValue = 'gitpeek.branchCommit'
        return Object.assign(item, { commitTarget: { repo: summary.repo, hash: commit.hash } })
      }),
      treeItem(`文件 (${summary.files.length}) · +${summary.additions} −${summary.deletions}`),
      ...summary.files.map((file) => {
        const item = treeItem(`${statusLabel(file.status)} ${file.path}`, `+${file.additions ?? 0} −${file.deletions ?? 0}`)
        item.command = { command: 'gitpeek.internal.branch.openDiff', title: '打开差异', arguments: [summary, file] }
        item.contextValue = 'gitpeek.branchFile'
        return Object.assign(item, { fileTarget: { repo: summary.repo, path: file.path } })
      }),
    ]
  }

  function treeItem(label: string, description?: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label)
    item.description = description
    return item
  }
}

function statusLabel(status: string): string {
  return ({ A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', T: 'T' } as Record<string, string>)[status] ?? status
}

function binaryLabel(path: string, side: string): string {
  return `[二进制文件（${side === 'before' ? '比较前' : '比较后'}）：${path}；不显示文件内容。]\n`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
