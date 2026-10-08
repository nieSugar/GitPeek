import * as vscode from 'vscode';
import { loadCommitDetail, loadCommitDiffContents, readCommitContent, resolveWorkspacePaths, type CommitContentRef } from './gitContent';
import type { GitService } from '../git/GitService';
import type { CommitDetail, Repository } from '../git/types';

const CONTENT_SCHEME = 'gitpeek-commit';
type ContentRef = CommitContentRef & { repoId: string; root: string };

class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly repositories = new Map<string, Repository>();

  constructor(private readonly git: GitService) {}

  register(repo: Repository): void {
    this.repositories.set(`${repo.id}\0${repo.root}`, repo);
  }

  uri(repo: Repository, ref: string, file: string, side: 'before' | 'after', empty: boolean, binary: boolean): vscode.Uri {
    const contentRef: ContentRef = { repoId: repo.id, root: repo.root, ref, file, side, ...(empty ? { empty: true } : {}), ...(binary ? { binary: true } : {}) };
    return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${file}`, query: JSON.stringify(contentRef) });
  }

  cache(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    if (this.contents.size > 16) this.contents.delete(this.contents.keys().next().value!);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cached = this.contents.get(uri.toString());
    if (cached !== undefined) return cached;
    let ref: ContentRef;
    try { ref = JSON.parse(uri.query) as ContentRef; } catch { throw new Error('GitPeek 提交内容 URI 无效'); }
    if (!ref || typeof ref.file !== 'string' || typeof ref.ref !== 'string' || (!ref.empty && !/^[0-9a-f]{40,64}$/i.test(ref.ref))) throw new Error('GitPeek 提交内容 URI 无效');
    const repo = this.repositories.get(`${ref.repoId}\0${ref.root}`);
    if (!repo) throw new Error('此 GitPeek 差异的仓库上下文不可用');
    return readCommitContent(this.git, repo, ref);
  }
}

class CommitFeatures {
  private readonly content: GitContentProvider;
  private readonly changed = new vscode.EventEmitter<void>();
  private rows: vscode.TreeItem[] = [new vscode.TreeItem('选择一个提交以查看详情。')];
  private current?: { repo: Repository; detail: CommitDetail };
  private pending?: { repo: Repository; hash: string };
  private pinned = false;
  private generation = 0;

  constructor(private readonly git: GitService) { this.content = new GitContentProvider(git); }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, this.content),
      vscode.window.createTreeView('gitpeek.commitDetails', { treeDataProvider: {
        onDidChangeTreeData: this.changed.event, getTreeItem: (item: vscode.TreeItem) => item,
        getChildren: () => this.rows,
      } }),
      vscode.commands.registerCommand('gitpeek.internal.details.openDiff', (repo: Repository, hash: string, file: string) => this.showDiff(repo, hash, file)),
      vscode.commands.registerCommand('gitpeek.internal.details.pin', () => {
        if (!this.current) return;
        this.pinned = true;
        this.generation++;
        void vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', true);
      }),
      vscode.commands.registerCommand('gitpeek.internal.details.unpin', async () => {
        this.pinned = false;
        await vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', false);
        if (this.pending) await this.showCommit(this.pending.repo, this.pending.hash);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('gitpeek.enabled') || vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
        this.generation++; this.current = undefined; this.pending = undefined; this.pinned = false;
        this.rows = [new vscode.TreeItem('GitPeek 已禁用。')]; this.changed.fire();
        void vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', false);
      }),
    );
  }

  async showCommit(repo: Repository, hash: string): Promise<void> {
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    this.pending = { repo, hash };
    if (this.pinned && this.current) {
      await vscode.window.showInformationMessage('GitPeek：提交详情已固定，取消固定后可查看所选提交。');
      await vscode.commands.executeCommand('gitpeek.commitDetails.focus');
      return;
    }
    const request = ++this.generation;
    this.current = undefined;
    this.rows = [new vscode.TreeItem('正在加载提交详情…')]; this.changed.fire();
    await vscode.commands.executeCommand('gitpeek.commitDetails.focus');
    try {
      const detail = await loadCommitDetail(this.git, repo, hash);
      const message = (await this.git.run(repo, ['show', '-s', '--format=%B', detail.hash])).replace(/\n+$/, '');
      const workspacePaths = await resolveWorkspacePaths(this.git, repo, detail.hash, detail.files);
      if (request !== this.generation) return;
      this.current = { repo, detail };
      this.content.register(repo);
      const commitTarget = { repo, hash: detail.hash };
      const heading = Object.assign(new vscode.TreeItem(detail.hash), { contextValue: 'gitpeek.detailCommit', commitTarget });
      heading.tooltip = message;
      this.rows = [
        new vscode.TreeItem(repo.root), heading,
        new vscode.TreeItem(`${detail.author} · ${formatDate(detail.date)}`),
        ...message.split(/\r?\n/).map(line => Object.assign(new vscode.TreeItem(line || ' '), { tooltip: message })),
        new vscode.TreeItem(`${detail.files.length} 个文件 · +${detail.additions} −${detail.deletions}`),
        ...detail.files.map((file) => {
          const workspacePath = workspacePaths.get(file.path);
          return {
            ...new vscode.TreeItem(`${statusLabel(file.status)} ${file.path}`),
            description: `+${file.additions ?? 0} −${file.deletions ?? 0}${file.oldPath ? ` · 来源于 ${file.oldPath}` : ''}`,
            contextValue: 'gitpeek.detailFile', fileTarget: { repo, path: workspacePath ?? file.path, workspacePathKnown: Boolean(workspacePath) },
            commitTarget: { ...commitTarget, file: file.path, workspacePath, workspacePathKnown: Boolean(workspacePath) },
            command: { command: 'gitpeek.internal.details.openDiff', title: '打开差异', arguments: [repo, detail.hash, file.path] },
          };
        }),
      ];
      this.changed.fire();
    } catch (error) {
      if (request !== this.generation) return;
      this.rows = [new vscode.TreeItem(`无法加载提交：${errorMessage(error)}`)]; this.changed.fire();
      await vscode.window.showErrorMessage(`GitPeek：无法显示提交：${errorMessage(error)}`);
    }
  }

  async showDiff(repo: Repository, hash: string, filePath?: string): Promise<void> {
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    try {
      const detail = await loadCommitDetail(this.git, repo, hash);
      this.content.register(repo);
      if (!filePath && detail.files.length > 1) {
        const selected = await vscode.window.showQuickPick(detail.files.map((file) => ({ label: `${statusLabel(file.status)} ${file.path}`, description: `${file.oldPath ? `${file.oldPath} → ` : ''}+${file.additions ?? 0} −${file.deletions ?? 0}`, file })), { title: `${detail.shortHash} ${detail.subject}`, placeHolder: '选择一个文件以打开差异' });
        if (!selected) return;
        filePath = selected.file.path;
      }
      filePath ??= detail.files[0]?.path;
      if (!filePath) {
        await vscode.window.showInformationMessage('GitPeek：此提交没有文件更改。');
        return;
      }
      await this.showDiffForCommit(repo, detail, filePath);
    } catch (error) {
      if (vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) await vscode.window.showErrorMessage(`GitPeek：无法打开差异：${errorMessage(error)}`);
    }
  }

  private async showDiffForCommit(repo: Repository, detail: CommitDetail, filePath: string): Promise<void> {
    const loaded = await loadCommitDiffContents(this.git, repo, detail, filePath);
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    const oldPath = loaded.file.status === 'R' ? loaded.file.oldPath! : loaded.file.path;
    const oldUri = this.content.uri(repo, loaded.parent ?? '', oldPath, 'before', loaded.file.status === 'A' || !loaded.parent, loaded.binary);
    const newUri = this.content.uri(repo, detail.hash, loaded.file.path, 'after', loaded.file.status === 'D', loaded.binary);
    this.content.cache(oldUri, loaded.oldContent);
    this.content.cache(newUri, loaded.newContent);
    const title = `${loaded.file.oldPath ? `${loaded.file.oldPath} → ` : ''}${loaded.file.path} (${detail.shortHash})${loaded.binary ? ' · 二进制文件' : ''}`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
  }
}

export function registerCommitFeatures(context: vscode.ExtensionContext, git: GitService): {
  showCommit(repo: Repository, hash: string): Promise<void>;
  showDiff(repo: Repository, hash: string, file?: string): Promise<void>;
} {
  const features = new CommitFeatures(git);
  features.register(context);
  return { showCommit: features.showCommit.bind(features), showDiff: features.showDiff.bind(features) };
}

function formatDate(milliseconds: number): string {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString('zh-CN') : '未知日期';
}

function statusLabel(status: string): string {
  return ({ A: '新增', M: '已修改', D: '已删除', R: '已重命名', C: '已复制', T: '类型已更改' } as Record<string, string>)[status] ?? status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

