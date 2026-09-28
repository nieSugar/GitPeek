import * as vscode from 'vscode';
import { isAbsolute, relative, sep } from 'node:path';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { loadReviewDiff, loadReviewSnapshot, type ReviewFile, type ReviewSection, type ReviewSnapshot } from './reviewChangesData';

const SHOW_DIFF = 'gitpeek.internal.reviewChanges.showDiff';
type SectionNode = { kind: 'section'; snapshot: ReviewSnapshot; section: ReviewSection };
type FileNode = { kind: 'file'; repo: Repository; file: ReviewFile };
type MessageNode = { kind: 'message'; message: string };
export type ReviewNode = SectionNode | FileNode | MessageNode;

export interface ReviewChangesFeature {
  show(repo?: Repository): Promise<void>;
  refresh(repo?: Repository): Promise<ReviewSnapshot | undefined>;
  readonly sidebar: vscode.TreeDataProvider<ReviewNode>;
  getSidebarData(): ReviewSnapshot | undefined;
}

class ReviewSidebar implements vscode.TreeDataProvider<ReviewNode> {
  private readonly changed = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private snapshot?: ReviewSnapshot;
  private error?: string;

  setSnapshot(snapshot?: ReviewSnapshot, error?: string): void {
    this.snapshot = snapshot;
    this.error = error;
    this.changed.fire(undefined);
  }

  getData(): ReviewSnapshot | undefined { return this.snapshot; }

  getChildren(element?: ReviewNode): ReviewNode[] {
    if (!element) {
      if (this.error) return [{ kind: 'message', message: this.error }];
      if (!this.snapshot) return [{ kind: 'message', message: '运行“GitPeek：审查更改”以加载此视图。' }];
      if (!this.snapshot.fileCount) return [{ kind: 'message', message: '没有已暂存、未暂存或未跟踪的更改。' }];
      return this.snapshot.groups.map((group) => ({ kind: 'section', snapshot: this.snapshot!, section: group.section }));
    }
    if (element.kind === 'message') return [];
    if (element.kind === 'section') {
      const group = element.snapshot.groups.find((item) => item.section === element.section);
      return group?.files.map((file) => ({ kind: 'file', repo: element.snapshot.repo, file })) ?? [];
    }
    return [];
  }

  getTreeItem(element: ReviewNode): vscode.TreeItem {
    if (element.kind === 'message') return new vscode.TreeItem(element.message);
    if (element.kind === 'section') {
      const group = element.snapshot.groups.find((item) => item.section === element.section)!;
      const item = new vscode.TreeItem(sectionTitle(element.section, group.files.length), vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${element.snapshot.repo.id}:${element.section}`;
      item.description = `+${group.additions} −${group.deletions}`;
      return item;
    }
    const { file, repo } = element;
    const item = new vscode.TreeItem(`${statusTitle(file.status)} ${file.path}`, vscode.TreeItemCollapsibleState.None);
    item.id = `${repo.id}:${file.section}:${file.path}`;
    item.description = file.binary ? '二进制文件' : `+${file.additions ?? 0} −${file.deletions ?? 0}`;
    item.tooltip = [file.oldPath ? `${file.oldPath} → ${file.path}` : file.path, ...file.warnings].join('\n');
    item.iconPath = new vscode.ThemeIcon(file.warnings.length ? 'warning' : file.binary ? 'file-binary' : 'diff');
    item.command = { command: SHOW_DIFF, title: '打开审查差异', arguments: [repo, file.section, file.path] };
    item.contextValue = `gitpeek.review.${file.section}`;
    return item;
  }

  dispose(): void { this.changed.dispose(); }
}

export async function registerReviewChanges(
  context: vscode.ExtensionContext,
  git: GitService,
  repos: RepositoryService,
): Promise<ReviewChangesFeature> {
  const sidebar = new ReviewSidebar();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = 'gitpeek.reviewChanges';
  statusBar.tooltip = '审查已暂存、未暂存和未跟踪的更改';
  statusBar.hide();
  let currentRepo: Repository | undefined;
  let refreshGeneration = 0;
  const content = new ReviewContentProvider();

  const resolveRepo = async (repo?: Repository): Promise<Repository | undefined> => {
    if (repo) return repo;
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === 'file') return repos.forUri(uri);
    return currentRepo;
  };

  const enabled = (): boolean => vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true);
  const clearDisabled = (): void => {
    refreshGeneration++;
    currentRepo = undefined;
    sidebar.setSnapshot(undefined, '更改审查已禁用。请启用 gitpeek.enabled 后使用。');
    statusBar.hide();
  };

  const refresh = async (repo?: Repository): Promise<ReviewSnapshot | undefined> => {
    if (!enabled()) { clearDisabled(); return undefined; }
    const target = await resolveRepo(repo);
    if (!enabled()) { clearDisabled(); return undefined; }
    const generation = ++refreshGeneration;
    currentRepo = target;
    if (!target) {
      sidebar.setSnapshot(undefined);
      statusBar.hide();
      return undefined;
    }
    try {
      const snapshot = await loadReviewSnapshot(git, target);
      if (generation !== refreshGeneration || currentRepo?.id !== target.id) return sidebar.getData();
      sidebar.setSnapshot(snapshot);
      statusBar.text = `$(git-compare) ${snapshot.fileCount} 个文件已更改`;
      statusBar.show();
      return snapshot;
    } catch (error) {
      if (generation === refreshGeneration && currentRepo?.id === target.id) {
        sidebar.setSnapshot(undefined, `无法加载更改：${errorText(error)}`);
        statusBar.hide();
      }
      throw error;
    }
  };

  const refreshActiveEditor = async (): Promise<void> => {
    if (!enabled()) { clearDisabled(); return; }
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      refreshGeneration++;
      currentRepo = undefined;
      sidebar.setSnapshot(undefined);
      statusBar.hide();
      return;
    }
    const repo = await repos.forUri(uri);
    if (!enabled()) { clearDisabled(); return; }
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) return;
    if (!repo) {
      refreshGeneration++;
      currentRepo = undefined;
      sidebar.setSnapshot(undefined);
      statusBar.hide();
      return;
    }
    await refresh(repo).catch(() => undefined);
  };

  const show = async (repo?: Repository): Promise<void> => {
    try {
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 更改审查已禁用。请启用 gitpeek.enabled 后使用。');
        return;
      }
      const target = await resolveRepo(repo) ?? await repos.pickRepository();
      if (!target) {
        await vscode.window.showInformationMessage('GitPeek：请打开一个 Git 仓库以审查更改。');
        return;
      }
      const snapshot = await refresh(target);
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 更改审查已禁用。请启用 gitpeek.enabled 后使用。');
        return;
      }
      if (!snapshot) return;
      const items: Array<vscode.QuickPickItem & { file?: ReviewFile }> = [];
      for (const group of snapshot.groups) {
        items.push({ label: sectionTitle(group.section, group.files.length), description: `+${group.additions} −${group.deletions}`, kind: vscode.QuickPickItemKind.Separator });
        for (const file of group.files) {
          items.push({
            label: `${statusTitle(file.status)} ${file.path}`,
            description: `${file.binary ? '二进制文件' : `+${file.additions ?? 0} −${file.deletions ?? 0}`}${file.warnings.length ? ` · ⚠ ${file.warnings.join(', ')}` : ''}`,
            detail: file.oldPath ? `重命名自 ${file.oldPath}` : undefined,
            file,
          });
        }
      }
      if (!snapshot.fileCount) {
        await vscode.window.showInformationMessage('GitPeek：没有已暂存、未暂存或未跟踪的更改。');
        return;
      }
      const selected = await vscode.window.showQuickPick(items, {
        title: 'GitPeek：审查更改',
        placeHolder: `${snapshot.fileCount} 个文件已更改 · +${snapshot.additions} −${snapshot.deletions}`,
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (selected?.file) await showDiff(target, selected.file.section, selected.file.path);
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：无法审查更改：${errorText(error)}`);
    }
  };

  const showDiff = async (repo: Repository, section: ReviewSection, filePath: string): Promise<void> => {
    try {
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 更改审查已禁用。请启用 gitpeek.enabled 后使用。');
        return;
      }
      const generation = refreshGeneration;
      const diff = await loadReviewDiff(git, repo, section, filePath);
      if (!enabled()) {
        await vscode.window.showInformationMessage('GitPeek 更改审查已禁用。请启用 gitpeek.enabled 后使用。');
        return;
      }
      if (generation !== refreshGeneration) {
        await vscode.window.showInformationMessage('GitPeek 更改已刷新，请重新运行“审查更改”。');
        return;
      }
      const revision = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const oldUri = reviewUri(repo, revision, section, diff.file.oldPath ?? diff.file.path, 'before');
      const newUri = reviewUri(repo, revision, section, diff.file.path, 'after');
      content.set(oldUri, diff.oldContent);
      content.set(newUri, diff.newContent);
      const title = `${sectionLabel(section)}：${diff.file.oldPath ? `${diff.file.oldPath} → ` : ''}${diff.file.path}${diff.binary ? ' · 二进制文件' : ''}`;
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：无法打开当前差异：${errorText(error)}`);
      await refresh(repo).catch(() => undefined);
    }
  };

  function reviewUri(repo: Repository, revision: string, section: ReviewSection, file: string, side: 'before' | 'after'): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'gitpeek-review',
      path: `/${encodeURIComponent(repo.id)}/${encodeURIComponent(file)}`,
      query: JSON.stringify({ repoId: repo.id, root: repo.root, revision, section, file, side }),
    });
  }

  context.subscriptions.push(
    statusBar,
    sidebar,
    content,
    vscode.workspace.registerTextDocumentContentProvider('gitpeek-review', content),
    vscode.commands.registerCommand('gitpeek.reviewChanges', (repo?: Repository) => show(repo)),
    vscode.commands.registerCommand(SHOW_DIFF, showDiff),
    vscode.window.onDidChangeActiveTextEditor(() => { void refreshActiveEditor(); }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('gitpeek.enabled')) return;
      if (enabled()) void refreshActiveEditor();
      else clearDisabled();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (currentRepo && isInside(currentRepo.root, document.uri.fsPath)) void refresh(currentRepo).catch(() => undefined);
    }),
  );

  void refreshActiveEditor();

  return { show, refresh, sidebar, getSidebarData: () => sidebar.getData() };
}

class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly change = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.change.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    if (this.contents.size > 64) this.contents.delete(this.contents.keys().next().value!);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const content = this.contents.get(uri.toString());
    if (content === undefined) throw new Error('审查差异已过期，请重新打开“审查更改”以刷新。');
    return content;
  }

  dispose(): void { this.change.dispose(); }
}

const SECTION_LABELS: Record<ReviewSection, string> = { staged: '已暂存', unstaged: '未暂存', untracked: '未跟踪' };

function sectionLabel(section: ReviewSection): string { return SECTION_LABELS[section]; }

function sectionTitle(section: ReviewSection, count: number): string {
  return `${sectionLabel(section)} (${count})`;
}

function statusTitle(status: string): string {
  return ({ A: '新增', M: '已修改', D: '已删除', R: '已重命名', C: '已复制', T: '类型已更改' } as Record<string, string>)[status] ?? status;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
