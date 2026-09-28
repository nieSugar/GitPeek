import * as vscode from 'vscode';
import type { HistoryFeature } from './history';

type Section = 'repository' | 'changes' | 'branchChanges';

export interface SidebarFeature {
  refresh(): void;
  setRepositoryItems(items: readonly vscode.TreeItem[]): void;
  setChangesItems(items: readonly vscode.TreeItem[]): void;
  setBranchChangesItems(items: readonly vscode.TreeItem[]): void;
}

export function registerSidebar(
  context: vscode.ExtensionContext,
  history: HistoryFeature,
): SidebarFeature {
  const sections: Record<Section, PlaceholderProvider> = {
    repository: new PlaceholderProvider('Open a Git repository to view details.', 'No repository details.'),
    changes: new PlaceholderProvider('Open a Git repository to view changes.', 'No changes to show.'),
    branchChanges: new PlaceholderProvider('Open a Git repository to compare branches.', 'No branch changes to show.'),
  };
  const views = [
    vscode.window.createTreeView('gitpeek.repository', { treeDataProvider: sections.repository }),
    vscode.window.createTreeView('gitpeek.changes', { treeDataProvider: sections.changes }),
    vscode.window.createTreeView('gitpeek.branchChanges', { treeDataProvider: sections.branchChanges }),
    vscode.window.createTreeView('gitpeek.fileHistory', { treeDataProvider: history.provider }),
  ];
  context.subscriptions.push(...views, ...Object.values(sections));

  return {
    refresh() {
      history.refresh();
      for (const provider of Object.values(sections)) provider.refresh();
    },
    setRepositoryItems: (items) => sections.repository.setItems(items),
    setChangesItems: (items) => sections.changes.setItems(items),
    setBranchChangesItems: (items) => sections.branchChanges.setItems(items),
  };
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
