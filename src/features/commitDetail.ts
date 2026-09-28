import * as vscode from 'vscode';
import { loadCommitDetail, loadCommitDiffContents, readCommitContent, type CommitContentRef } from './gitContent';
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
    return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${encodeURIComponent(repo.id)}/${encodeURIComponent(file)}`, query: JSON.stringify(contentRef) });
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
    const repo = this.repositories.get(`${ref.repoId}\0${ref.root}`);
    if (!repo) throw new Error('此 GitPeek 差异的仓库上下文不可用');
    return readCommitContent(this.git, repo, ref);
  }
}

class CommitFeatures {
  private readonly content: GitContentProvider;

  constructor(private readonly git: GitService) { this.content = new GitContentProvider(git); }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, this.content));
  }

  async showCommit(repo: Repository, hash: string): Promise<void> {
    try {
      const detail = await loadCommitDetail(this.git, repo, hash);
      this.content.register(repo);
      const message = (await this.git.run(repo, ['show', '-s', '--format=%B', detail.hash])).replace(/\n+$/, '');
      if (!detail.files.length) {
        await vscode.window.showInformationMessage(`${detail.shortHash} ${detail.author} · ${formatDate(detail.date)} · 空提交\n\n${message}`);
        return;
      }
      const items: Array<vscode.QuickPickItem & { file?: (typeof detail.files)[number] }> = [
        { label: '提交信息', kind: vscode.QuickPickItemKind.Separator },
        ...message.split(/\r?\n/).map((line) => ({ label: line || ' ', kind: vscode.QuickPickItemKind.Separator })),
        { label: '已更改文件', kind: vscode.QuickPickItemKind.Separator },
        ...detail.files.map((file) => ({
          label: `${statusLabel(file.status)} ${file.path}`,
          description: `+${file.additions ?? 0} −${file.deletions ?? 0}${file.oldPath ? ` · 来源于 ${file.oldPath}` : ''}`,
          file,
        })),
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: `${detail.shortHash} ${detail.subject}`,
        placeHolder: `${detail.author} · ${formatDate(detail.date)} · +${detail.additions} −${detail.deletions} · 选择一个文件以打开差异`,
        matchOnDescription: true,
      });
      if (selected?.file) await this.showDiffForCommit(repo, detail, selected.file.path);
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：无法显示提交：${errorMessage(error)}`);
    }
  }

  async showDiff(repo: Repository, hash: string, filePath?: string): Promise<void> {
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
      await vscode.window.showErrorMessage(`GitPeek：无法打开差异：${errorMessage(error)}`);
    }
  }

  private async showDiffForCommit(repo: Repository, detail: CommitDetail, filePath: string): Promise<void> {
    const loaded = await loadCommitDiffContents(this.git, repo, detail, filePath);
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

