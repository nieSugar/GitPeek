import * as vscode from 'vscode'
import { basename, dirname, resolve } from 'node:path'
import type { GitService } from '../git/GitService'
import type { RepositoryService } from '../git/RepositoryService'
import type { BranchComparison, FileChange, Repository } from '../git/types'

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

export async function resolveBaseBranch(git: GitService, repo: Repository, configured = 'auto'): Promise<string> {
  const exists = async (ref: string): Promise<boolean> => {
    try {
      await git.run(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
      return true
    } catch { return false }
  }

  if (configured !== 'auto') {
    if (await exists(configured)) return configured
    throw new Error(`Configured base branch "${configured}" does not exist or has no commit.`)
  }

  try {
    const target = (await git.run(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim()
    const originHead = target.replace(/^refs\/remotes\//, '')
    if (originHead !== target && await exists(originHead)) return originHead
  } catch { /* Fall through to the local branch names. */ }

  for (const candidate of FALLBACK_BASES) if (await exists(candidate)) return candidate
  throw new Error('No base branch found. Set gitpeek.baseBranch to an existing branch.')
}

export async function loadBranchCompare(git: GitService, repo: Repository, base: string): Promise<BranchCompareSummary> {
  const [status, head] = await Promise.all([
    git.status(repo),
    git.run(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).then((value) => value.trim()),
  ])
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('The current branch has no commit yet.')

  let mergeBase: string
  try {
    mergeBase = (await git.run(repo, ['merge-base', base, head])).trim()
  } catch {
    throw new Error(`Base "${base}" and the current branch have no common ancestor.`)
  }
  if (!mergeBase) throw new Error(`Base "${base}" and the current branch have no common ancestor.`)

  // GitService.compare uses base...HEAD for the file set and counts; that diff is merge-base(base, HEAD) → HEAD.
  const comparison = await git.compare(repo, base, head)
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
    return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${encodeURIComponent(repo.id)}/${encodeURIComponent(file)}`, query: JSON.stringify(query) })
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
    if (!repo) throw new Error('Repository context is unavailable for this branch diff.')
    if (ref.empty) return ''
    if (ref.binary) return `[Binary file: ${ref.file}]\n`
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
  const watchers = new Set<string>()
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  statusBar.text = '$(git-branch) GitPeek: Compare with Base'
  statusBar.tooltip = 'GitPeek: Compare the current branch with its base'
  statusBar.command = 'gitpeek.showBranchChanges'
  statusBar.show()

  const provider = vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, content)
  context.subscriptions.push(changed, statusBar, provider)

  const updateView = (error?: string): void => {
    currentItems = currentSummary ? createItems(currentSummary) : error ? [new vscode.TreeItem(error)] : []
    changed.fire()
  }

  const installWatchers = async (repo: Repository): Promise<void> => {
    if (watchers.has(repo.id)) return
    watchers.add(repo.id)
    const paths = await Promise.all(['HEAD', 'packed-refs', 'refs/heads', 'logs/HEAD'].map(async (path) =>
      resolve(repo.root, (await git.run(repo, ['rev-parse', '--git-path', path])).trim())))
    for (const path of paths) {
      const isHeadsDir = path.endsWith('refs/heads')
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(isHeadsDir ? path : dirname(path)), isHeadsDir ? '**/*' : basename(path)))
      watcher.onDidChange(() => { if (activeRepo?.id === repo.id) void refresh() })
      watcher.onDidCreate(() => { if (activeRepo?.id === repo.id) void refresh() })
      watcher.onDidDelete(() => { if (activeRepo?.id === repo.id) void refresh() })
      context.subscriptions.push(watcher)
    }
  }

  const refresh = async (): Promise<void> => {
    const repo = activeRepo
    if (!repo) return
    const request = ++generation
    try {
      const configured = vscode.workspace.getConfiguration('gitpeek').get<string>('baseBranch', 'auto')
      const base = await resolveBaseBranch(git, repo, configured)
      const summary = await loadBranchCompare(git, repo, base)
      if (request !== generation) return
      currentSummary = summary
      content.register(repo)
      statusBar.text = `$(git-branch) ${summary.branch} ↑${summary.ahead} ↓${summary.behind}`
      statusBar.tooltip = `${summary.base} · ${summary.files.length} changed · +${summary.additions} −${summary.deletions}`
      updateView()
    } catch (error) {
      if (request !== generation) return
      currentSummary = undefined
      statusBar.text = '$(git-branch) GitPeek: Compare with Base'
      statusBar.tooltip = errorMessage(error)
      updateView(errorMessage(error))
    }
  }

  const openDiff = async (summary: BranchCompareSummary, file: FileChange): Promise<void> => {
    try {
      const oldPath = file.status === 'R' ? file.oldPath ?? file.path : file.path
      const oldEmpty = file.status === 'A'
      const newEmpty = file.status === 'D'
      const pathspecs = (file.oldPath ? [file.oldPath, file.path] : [file.path]).map((path) => `:(literal)${path}`)
      const stats = await git.run(summary.repo, ['diff', '--numstat', '-z', summary.mergeBase, summary.head, '--', ...pathspecs])
      const binary = stats.split('\0').some((record) => record.startsWith('-\t-\t'))
      const oldContent = oldEmpty ? '' : binary ? binaryLabel(oldPath, 'before') : await git.run(summary.repo, ['show', `${summary.mergeBase}:${oldPath}`])
      const newContent = newEmpty ? '' : binary ? binaryLabel(file.path, 'after') : await git.run(summary.repo, ['show', `${summary.head}:${file.path}`])
      const oldUri = content.uri(summary.repo, summary.mergeBase, oldPath, oldEmpty, binary)
      const newUri = content.uri(summary.repo, summary.head, file.path, newEmpty, binary)
      content.cache(oldUri, oldContent)
      content.cache(newUri, newContent)
      const title = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} (${summary.base} → ${summary.branch})`
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title)
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek: Could not open branch diff: ${errorMessage(error)}`)
    }
  }

  const show = async (repo?: Repository): Promise<void> => {
    const editorRepo = vscode.window.activeTextEditor
      ? await repositories.forUri(vscode.window.activeTextEditor.document.uri)
      : undefined
    const selectedRepo = repo ?? editorRepo ?? await repositories.pickRepository()
    if (!selectedRepo) {
      await vscode.window.showInformationMessage('GitPeek: Open a file in a Git repository or select a repository.')
      return
    }
    activeRepo = selectedRepo
    await installWatchers(selectedRepo)
    await refresh()
    const summary = currentSummary
    if (!summary) {
      await vscode.window.showErrorMessage(`GitPeek: ${currentItems[0]?.label ?? 'Branch comparison is unavailable.'}`)
      return
    }
    const choices: Array<vscode.QuickPickItem & { commit?: string; file?: FileChange }> = [
      { label: `$(git-branch) ${summary.branch} vs ${summary.base} · ↑${summary.ahead} ↓${summary.behind} · ${summary.files.length} files · +${summary.additions} −${summary.deletions}`, kind: vscode.QuickPickItemKind.Separator },
      { label: 'Branch commits', kind: vscode.QuickPickItemKind.Separator },
      ...summary.commits.map((commit) => ({ label: `${commit.shortHash} ${commit.subject}`, description: `${commit.author} · ${new Date(commit.date).toLocaleDateString()}`, commit: commit.hash })),
      { label: 'Changed files · merge-base → HEAD', kind: vscode.QuickPickItemKind.Separator },
      ...summary.files.map((file) => ({ label: `${statusLabel(file.status)} ${file.path}`, description: `+${file.additions ?? 0} −${file.deletions ?? 0}${file.oldPath ? ` · from ${file.oldPath}` : ''}`, file })),
    ]
    const selected = await vscode.window.showQuickPick(choices, { title: `${summary.branch} vs ${summary.base}`, matchOnDescription: true, placeHolder: 'Select a commit or file' })
    if (selected?.commit) await showCommit(summary.repo, selected.commit)
    else if (selected?.file) await openDiff(summary, selected.file)
  }

  const handleActiveEditor = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    if (!editor) {
      editorGeneration++
      generation++
      activeRepo = undefined
      currentSummary = undefined
      statusBar.hide()
      updateView()
      return
    }
    const request = ++editorGeneration
    generation++
    const repo = await repositories.forUri(editor.document.uri)
    if (request !== editorGeneration) return
    activeRepo = repo
    if (!repo) { generation++; statusBar.hide(); currentSummary = undefined; updateView(); return }
    statusBar.show()
    await installWatchers(repo)
    if (request === editorGeneration) await refresh()
  }
  const onActiveEditor = vscode.window.onDidChangeActiveTextEditor((editor) => { void handleActiveEditor(editor) })
  const onConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('gitpeek.baseBranch')) void refresh()
  })
  context.subscriptions.push(onActiveEditor, onConfiguration,
    vscode.commands.registerCommand('gitpeek.compareWithBase', () => show()),
    vscode.commands.registerCommand('gitpeek.showBranchChanges', () => show()),
    vscode.commands.registerCommand('gitpeek.internal.branch.showCommit', (repo: Repository, hash: string) => showCommit(repo, hash)),
    vscode.commands.registerCommand('gitpeek.internal.branch.openDiff', (summary: BranchCompareSummary, file: FileChange) => openDiff(summary, file)),
  )

  const initialEditor = vscode.window.activeTextEditor
  if (initialEditor) void handleActiveEditor(initialEditor)

  return {
    show,
    refresh,
    onDidChange: changed.event,
    get items() { return currentItems },
    get summary() { return currentSummary },
  }

  function createItems(summary: BranchCompareSummary): vscode.TreeItem[] {
    return [
      treeItem(`${summary.branch} vs ${summary.base} · ↑${summary.ahead} ↓${summary.behind}`),
      treeItem(`Commits (${summary.commits.length})`),
      ...summary.commits.map((commit) => {
        const item = treeItem(`${commit.shortHash} ${commit.subject}`, `${commit.author} · ${new Date(commit.date).toLocaleDateString()}`)
        item.command = { command: 'gitpeek.internal.branch.showCommit', title: 'Show Commit', arguments: [summary.repo, commit.hash] }
        return item
      }),
      treeItem(`Files (${summary.files.length}) · +${summary.additions} −${summary.deletions}`),
      ...summary.files.map((file) => {
        const item = treeItem(`${statusLabel(file.status)} ${file.path}`, `+${file.additions ?? 0} −${file.deletions ?? 0}`)
        item.command = { command: 'gitpeek.internal.branch.openDiff', title: 'Open Diff', arguments: [summary, file] }
        return item
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
  return `[Binary file ${side}: ${path}; content is not shown.]\n`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
