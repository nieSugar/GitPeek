import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { FileHistoryCommit, Repository } from '../git/types';
import { isGitPeekEditor } from './virtualEditor';

const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 20;
const CACHE_TTL = 60_000;

type ShowDiff = (repo: Repository, hash: string, file: string) => void | Promise<void>;
type HistoryItem = vscode.TreeItem;
export interface HistoryPage {
  commits: FileHistoryCommit[];
  hasMore: boolean;
}

export class FileHistoryService {
  private readonly cache = new Map<string, { head: string; expires: number; limit: number; commits: FileHistoryCommit[]; hasMore: boolean }>();
  private readonly heads = new Map<string, string>();
  private readonly git: GitService;

  constructor(git: GitService) {
    this.git = git;
  }

  async load(repo: Repository, file: string, limit = DEFAULT_LIMIT): Promise<HistoryPage> {
    const count = Math.max(1, Math.floor(limit));
    let head = '';
    try {
      head = (await this.git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      return { commits: [], hasMore: false };
    }
    const previousHead = this.heads.get(repo.id);
    if (previousHead !== undefined && previousHead !== head) this.invalidate(repo.id);
    this.heads.set(repo.id, head);

    const key = `${repo.id}\0${file}`;
    const cached = this.cache.get(key);
    if (cached && cached.head === head && cached.expires > Date.now() && cached.limit >= count) {
      return {
        commits: cached.commits.slice(0, count),
        hasMore: cached.commits.length > count || cached.hasMore,
      };
    }

    const all = await this.git.history(repo, file, count + 1);
    const commits = all.slice(0, count);
    const hasMore = all.length > count;
    this.cache.set(key, { head, expires: Date.now() + CACHE_TTL, limit: count, commits, hasMore });
    return { commits, hasMore };
  }

  invalidate(repoId?: string): void {
    if (repoId === undefined) {
      this.cache.clear();
      this.heads.clear();
      return;
    }
    for (const key of this.cache.keys()) if (key.startsWith(`${repoId}\0`)) this.cache.delete(key);
    this.heads.delete(repoId);
  }
}

export function relativeHistoryPath(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).replace(/\\/g, '/');
}

export interface HistoryFeature {
  readonly provider: vscode.TreeDataProvider<vscode.TreeItem>;
  show(uri: vscode.Uri): Promise<void>;
  refresh(): void;
}

export async function registerHistory(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showDiff?: ShowDiff,
): Promise<HistoryFeature> {
  const vscode = await import('vscode');
  const service = new FileHistoryService(git);
  const changed = new vscode.EventEmitter<HistoryItem | undefined>();
  const onDidChangeTreeData = changed.event;
  let activeUri = vscode.window.activeTextEditor?.document.uri;
  const initialLimit = (uri?: vscode.Uri) => Math.max(1, vscode.workspace.getConfiguration('gitpeek.history', uri).get<number>('limit', DEFAULT_LIMIT));
  let limit = initialLimit(activeUri);
  let generation = 0;
  const watchers = new Set<string>();

  const watchRepository = async (repo: Repository): Promise<void> => {
    if (watchers.has(repo.id)) return;
    watchers.add(repo.id);
    let paths: string[];
    try {
      paths = await Promise.all(['HEAD', 'packed-refs', 'refs/heads', 'logs/HEAD'].map(async (gitPath) =>
        path.resolve(repo.root, (await git.run(repo, ['rev-parse', '--git-path', gitPath])).trim())));
    } catch {
      watchers.delete(repo.id);
      return;
    }
    for (const watchedPath of paths) {
      const headsDirectory = watchedPath.endsWith(path.join('refs', 'heads'));
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(headsDirectory ? watchedPath : path.dirname(watchedPath)),
        headsDirectory ? '**/*' : path.basename(watchedPath),
      ));
      const invalidate = () => {
        service.invalidate(repo.id);
        generation++;
        changed.fire(undefined);
      };
      watcher.onDidChange(invalidate);
      watcher.onDidCreate(invalidate);
      watcher.onDidDelete(invalidate);
      context.subscriptions.push(watcher);
    }
  };

  const provider: vscode.TreeDataProvider<HistoryItem> = {
    onDidChangeTreeData,
    getTreeItem: (item) => item,
    getChildren: async () => {
      const uri = activeUri;
      if (!vscode.workspace.getConfiguration('gitpeek', uri).get<boolean>('enabled', true)) {
        return [message(vscode, 'GitPeek 已在设置中禁用。')];
      }
      if (!uri || uri.scheme !== 'file') return [message(vscode, '打开一个文件以查看其历史。')];
      const currentGeneration = generation;
      const repo = await repositories.forUri(uri);
      if (currentGeneration !== generation) return [];
      if (!repo) return [message(vscode, '此文件不属于任何 Git 仓库。')];
      await watchRepository(repo);
      if (currentGeneration !== generation) return [];

      const file = relativeHistoryPath(repo.root, uri.fsPath);
      try {
        const page = await service.load(repo, file, limit);
        if (currentGeneration !== generation || uri !== activeUri) return [];
        const fileTarget = { repo, path: file };
        const rows: HistoryItem[] = [Object.assign(message(vscode, vscode.workspace.asRelativePath(uri, false)), {
          contextValue: 'gitpeek.historyFile', fileTarget,
        })];
        rows.push(...page.commits.map((commit) => Object.assign(commitItem(vscode, repo, commit, !!showDiff), { fileTarget })));
        if (!page.commits.length) rows.push(message(vscode, '此文件没有提交记录。'));
        else if (page.hasMore) rows.push(moreItem(vscode));
        return rows;
      } catch (error) {
        if (currentGeneration !== generation) return [];
        return [message(vscode, `无法加载文件历史：${String(error)}`)];
      }
    },
  };

  const show = async (uri: vscode.Uri): Promise<void> => {
    if (!vscode.workspace.getConfiguration('gitpeek', uri).get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek：请在设置中启用扩展后再查看文件历史。');
      return;
    }
    activeUri = uri;
    limit = initialLimit(uri);
    generation++;
    changed.fire(undefined);
    await vscode.commands.executeCommand('gitpeek.fileHistory.focus');
  };
  const refresh = (): void => {
    service.invalidate();
    generation++;
    changed.fire(undefined);
  };

  context.subscriptions.push(
    changed,
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (isGitPeekEditor(editor)) return;
      activeUri = editor?.document.uri;
      limit = initialLimit(activeUri);
      generation++;
      changed.fire(undefined);
    }),
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) {
        generation++;
        changed.fire(undefined);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.toString() !== activeUri?.toString()) return;
      generation++;
      changed.fire(undefined);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('gitpeek.enabled')) {
        generation++;
        changed.fire(undefined);
      }
      if (event.affectsConfiguration('gitpeek.history.limit')) {
        limit = initialLimit(activeUri);
        refresh();
      }
    }),
    vscode.commands.registerCommand('gitpeek.fileHistory', async (target?: vscode.Uri) => {
      const uri = target ?? vscode.window.activeTextEditor?.document.uri;
      if (!vscode.workspace.getConfiguration('gitpeek', uri).get<boolean>('enabled', true)) {
        await vscode.window.showInformationMessage('GitPeek：请在设置中启用扩展后再查看文件历史。');
        return;
      }
      if (!uri) {
        void vscode.window.showInformationMessage('GitPeek：请先打开一个文件以查看其历史。');
        return;
      }
      await show(uri);
    }),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.loadMore', () => {
      if (!activeUri || !vscode.workspace.getConfiguration('gitpeek', activeUri).get<boolean>('enabled', true)) return;
      limit += PAGE_SIZE;
      generation++;
      changed.fire(undefined);
    }),
  );
  if (showDiff) context.subscriptions.push(
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.showDiff', (repo: Repository, hash: string, file: string) => showDiff(repo, hash, file)),
  );

  return { provider, show, refresh };
}

function message(vscode: typeof import('vscode'), label: string): HistoryItem {
  const item = new vscode.TreeItem(label);
  return item;
}

function commitItem(vscode: typeof import('vscode'), repo: Repository, commit: FileHistoryCommit, canOpen: boolean): HistoryItem {
  const date = new Date(commit.date).toLocaleDateString('zh-CN');
  const item = new vscode.TreeItem(`${commit.subject}`, vscode.TreeItemCollapsibleState.None);
  item.description = `${commit.author} · ${date} · ${commit.shortHash}`;
  item.tooltip = `${commit.subject}\n${commit.author} · ${date}\n${commit.hash}`;
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.contextValue = 'gitpeek.historyCommit';
  if (canOpen) item.command = {
    command: 'gitpeek.internal.fileHistory.showDiff',
    title: '查看文件差异',
    arguments: [repo, commit.hash, commit.filePath],
  };
  return item;
}

function moreItem(vscode: typeof import('vscode')): HistoryItem {
  const item = new vscode.TreeItem('加载更多…', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.command = { command: 'gitpeek.internal.fileHistory.loadMore', title: '加载更多' };
  return item;
}
