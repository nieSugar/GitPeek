import * as vscode from 'vscode';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { HistoryFeature } from './history';
import type { ReviewNode } from './reviewChanges';
import type { CommitTarget, Repository } from '../git/types';

type Section = 'repository' | 'branchChanges';
type FileItem = vscode.TreeItem & { fileTarget?: { repo: Repository; path: string; workspacePathKnown?: boolean }; commitTarget?: CommitTarget };

export interface SidebarFeature {
  refresh(): void;
  setRepositoryItems(items: readonly vscode.TreeItem[]): void;
  setBranchChangesItems(items: readonly vscode.TreeItem[]): void;
}

export function registerSidebar<T>(
  context: vscode.ExtensionContext,
  history: HistoryFeature,
  changes: vscode.TreeDataProvider<T>,
  showCommit: (repo: Repository, hash: string) => Promise<void>,
): SidebarFeature {
  const sections: Record<Section, PlaceholderProvider> = {
    repository: new PlaceholderProvider('打开 Git 仓库以查看详细信息。', '暂无仓库信息。'),
    branchChanges: new PlaceholderProvider('打开 Git 仓库以比较分支。', '暂无分支变更。'),
  };
  const views = [
    vscode.window.createTreeView('gitpeek.repository', { treeDataProvider: sections.repository }),
    vscode.window.createTreeView('gitpeek.changes', { treeDataProvider: changes, canSelectMany: true }),
    vscode.window.createTreeView('gitpeek.branchChanges', { treeDataProvider: sections.branchChanges }),
    vscode.window.createTreeView('gitpeek.fileHistory', { treeDataProvider: history.provider }),
  ];
  context.subscriptions.push(...views, ...Object.values(sections));
  context.subscriptions.push(
    vscode.commands.registerCommand('gitpeek.internal.tree.openDiff', (item?: vscode.TreeItem) => {
      if (!['gitpeek.historyCommit', 'gitpeek.branchFile', 'gitpeek.detailFile', 'gitpeek.comparisonFile'].includes(item?.contextValue ?? '')) return;
      const command = item?.command;
      if (command) return vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    }),
    vscode.commands.registerCommand('gitpeek.internal.tree.showCommit', (item?: vscode.TreeItem) => {
      if (!['gitpeek.historyCommit', 'gitpeek.branchCommit'].includes(item?.contextValue ?? '')) return;
      const [repo, hash] = item?.command?.arguments ?? [];
      if (repo && typeof hash === 'string') return showCommit(repo, hash);
    }),
    vscode.commands.registerCommand('gitpeek.internal.tree.copyHash', (item?: FileItem) => {
      if (!['gitpeek.historyCommit', 'gitpeek.branchCommit', 'gitpeek.detailCommit', 'gitpeek.detailFile'].includes(item?.contextValue ?? '')) return;
      const hash = item?.commitTarget?.hash ?? item?.command?.arguments?.[1];
      if (typeof hash === 'string') return vscode.env.clipboard.writeText(hash);
    }),
    vscode.commands.registerCommand('gitpeek.internal.file.open', async (item?: FileItem | ReviewNode) => {
      if (item && (('commitTarget' in item && item.commitTarget?.workspacePathKnown === false) || ('fileTarget' in item && item.fileTarget?.workspacePathKnown === false))) {
        await vscode.window.showInformationMessage('GitPeek：无法确认该历史文件的当前工作区路径，请通过“打开差异”查看历史内容。');
        return;
      }
      const target = fileTarget(item);
      if (!target) return;
      try {
        const fullPath = resolve(target.repo.root, target.path);
        const relativePath = relative(target.repo.root, fullPath);
        if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
          throw new Error('文件路径不在所选仓库中。');
        }
        const uri = vscode.Uri.file(fullPath);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
          await vscode.window.showInformationMessage(`GitPeek：此路径是目录，无法作为文件打开：${target.path}`);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
          await vscode.window.showInformationMessage(`GitPeek：工作区中不存在此文件：${target.path}。可通过“打开差异”查看历史内容。`);
        } else {
          await vscode.window.showErrorMessage(`GitPeek：无法打开工作区文件：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }),
    vscode.commands.registerCommand('gitpeek.internal.file.copyRelativePath', (item?: FileItem | ReviewNode) => {
      const target = fileTarget(item);
      if (target) return vscode.env.clipboard.writeText(target.path);
    }),
  );

  return {
    refresh() {
      history.refresh();
      for (const provider of Object.values(sections)) provider.refresh();
    },
    setRepositoryItems: (items) => sections.repository.setItems(items),
    setBranchChangesItems: (items) => sections.branchChanges.setItems(items),
  };
}

function fileTarget(item?: FileItem | ReviewNode): FileItem['fileTarget'] {
  if (!item || !vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) return undefined;
  if ('kind' in item) return item.kind === 'file' ? { repo: item.repo, path: item.file.path } : undefined;
  return item.fileTarget;
}

class PlaceholderProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private items?: readonly vscode.TreeItem[];

  constructor(private readonly loadingLabel: string, private readonly emptyLabel: string) {}

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.items?.length) return [...this.items];
    return [new vscode.TreeItem(this.items ? this.emptyLabel : this.loadingLabel)];
  }

  setItems(items: readonly vscode.TreeItem[]): void {
    this.items = items;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
