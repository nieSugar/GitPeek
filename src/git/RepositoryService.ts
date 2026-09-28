import * as vscode from 'vscode'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { GitService } from './GitService'
import { Repository } from './types'

export class RepositoryService {
  // Cache only the exact queried directory; inferring descendants from a cached root breaks nested repositories.
  private readonly cache = new Map<string, Repository>()

  constructor(private readonly git: GitService) {}

  async forUri(uri: vscode.Uri): Promise<Repository | undefined> {
    if (uri.scheme !== 'file') return undefined
    let directory = uri.fsPath
    try { if (!(await stat(directory)).isDirectory()) directory = dirname(directory) } catch { return undefined }
    const queryPath = resolve(directory)
    const cached = this.cache.get(process.platform === 'win32' ? queryPath.toLowerCase() : queryPath)
    if (cached) return cached
    try {
      const root = (await this.git.run(directory, ['rev-parse', '--show-toplevel'])).trim()
      if (!root) return undefined
      const normalizedRoot = resolve(vscode.Uri.file(root).fsPath)
      const normalized = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
      const repository = { root, id: normalized }
      this.cache.set(process.platform === 'win32' ? queryPath.toLowerCase() : queryPath, repository)
      return repository
    } catch {
      return undefined
    }
  }

  async pickRepository(): Promise<Repository | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? []
    const found = await Promise.all(folders.map((folder) => this.forUri(folder.uri)))
    const unique = [...new Map(found.filter((repo): repo is Repository => !!repo).map((repo) => [repo.id, repo])).values()]
    if (unique.length === 1) return unique[0]
    if (!unique.length) return undefined
    const selected = await vscode.window.showQuickPick(unique.map((repo) => ({ label: vscode.workspace.asRelativePath(vscode.Uri.file(repo.root), false), description: repo.root, repo })), { placeHolder: '选择一个 Git 仓库' })
    return selected?.repo
  }

  clearCache(): void {
    this.cache.clear()
  }
}
