import * as vscode from 'vscode';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { loadCommitDetail, loadCommitDiffContents, readCommitContent, resolveWorkspacePaths, type CommitContentRef } from './gitContent';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { CommitDetail, Repository } from '../git/types';
import { adjacentFileRevision, validFile, validRevisionContext, type FileRevisionContext } from './fileRevisions';

const CONTENT_SCHEME = 'gitpeek-commit';
export interface DiffLocation { side: 'left' | 'right'; line: number; text?: string }
type ContentRef = CommitContentRef & Partial<FileRevisionContext> & { repoId: string; root: string; workspacePath?: string };

class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly repositories = new Map<string, Repository>();

  constructor(private readonly git: GitService) {}

  register(repo: Repository): void {
    this.repositories.set(`${repo.id}\0${repo.root}`, repo);
  }

  uri(repo: Repository, ref: string, file: string, side: 'before' | 'after', empty: boolean, binary: boolean, workspacePath: string | undefined, revision: FileRevisionContext): vscode.Uri {
    const contentRef: ContentRef = { repoId: repo.id, root: repo.root, ref, file, side, workspacePath, ...revision, ...(empty ? { empty: true } : {}), ...(binary ? { binary: true } : {}) };
    return vscode.Uri.from({ scheme: CONTENT_SCHEME, path: `/${file}`, query: JSON.stringify(contentRef) });
  }

  navigation(uri: vscode.Uri): { repo: Repository; ref: ContentRef & FileRevisionContext } {
    let ref: ContentRef;
    try { ref = JSON.parse(uri.query) as ContentRef; } catch { throw new Error('GitPeek 文件历史 URI 无效。'); }
    if (uri.scheme !== CONTENT_SCHEME || !validRevisionContext(ref) || !validFile(ref.file)
      || (ref.workspacePath !== undefined && !validFile(ref.workspacePath))
      || (ref.side !== 'before' && ref.side !== 'after')
      || (ref.ref !== '' && !/^[0-9a-f]{40,64}$/i.test(ref.ref))
      || (ref.side === 'after' && ref.ref !== ref.currentCommit)) throw new Error('GitPeek 文件历史 URI 无效。');
    const repo = this.repositories.get(`${ref.repoId}\0${ref.root}`);
    if (!repo) throw new Error('此 GitPeek 差异的仓库上下文不可用。');
    return { repo, ref };
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
  private diffGeneration = 0;
  private detailsQuery?: AbortController;
  private diffQuery?: AbortController;
  private context?: vscode.ExtensionContext;

  constructor(private readonly git: GitService) { this.content = new GitContentProvider(git); }

  register(context: vscode.ExtensionContext, repositories?: RepositoryService): void {
    this.context = context;
    context.subscriptions.push(
      this.changed,
      vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, this.content),
      vscode.window.createTreeView('gitpeek.commitDetails', { treeDataProvider: {
        onDidChangeTreeData: this.changed.event, getTreeItem: (item: vscode.TreeItem) => item,
        getChildren: (item?: vscode.TreeItem & { children?: vscode.TreeItem[] }) => item ? item.children ?? [] : this.rows,
      } }),
      vscode.commands.registerCommand('gitpeek.internal.details.openDiff', (repo: Repository, hash: string, file: string, workspacePath?: string) => this.showDiff(repo, hash, file, workspacePath)),
      vscode.commands.registerCommand('gitpeek.previousFileRevision', (uri?: vscode.Uri) => this.navigateRevision(1, uri)),
      vscode.commands.registerCommand('gitpeek.nextFileRevision', (uri?: vscode.Uri) => this.navigateRevision(-1, uri)),
      vscode.window.onDidChangeActiveTextEditor(() => { this.diffGeneration++; this.diffQuery?.abort(); }),
      vscode.commands.registerCommand('gitpeek.internal.details.pin', () => {
        if (!this.current) return;
        this.pinned = true;
        this.generation++;
        this.detailsQuery?.abort();
        this.persistPin();
        void vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', true);
      }),
      vscode.commands.registerCommand('gitpeek.internal.details.unpin', async () => {
        this.pinned = false;
        this.persistPin();
        await vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', false);
        if (this.pending) await this.showCommit(this.pending.repo, this.pending.hash);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('gitpeek.enabled') || vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
        this.generation++; this.diffGeneration++; this.current = undefined; this.pending = undefined; this.pinned = false;
        this.detailsQuery?.abort(); this.diffQuery?.abort(); this.persistPin();
        this.rows = [new vscode.TreeItem('GitPeek 已禁用。')]; this.changed.fire();
        void vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', false);
        void vscode.commands.executeCommand('setContext', 'gitpeek.hasCommitDetails', false);
      }),
    );
    context.subscriptions.push({ dispose: () => { this.generation++; this.diffGeneration++; this.detailsQuery?.abort(); this.diffQuery?.abort(); } });
    if (repositories) void this.restorePin(repositories);
  }

  private persistPin(): void {
    const value = this.pinned && this.current ? { root: this.current.repo.root, id: this.current.repo.id, hash: this.current.detail.hash } : undefined;
    void this.context?.workspaceState?.update('gitpeek.investigation.commit.v1', value);
  }

  private async restorePin(repositories: RepositoryService): Promise<void> {
    const saved = this.context?.workspaceState?.get<{ root: string; id: string; hash: string }>('gitpeek.investigation.commit.v1');
    if (!saved || !vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    const request = this.generation;
    const signal = (this.detailsQuery = new AbortController()).signal;
    try {
      if (typeof saved.root !== 'string' || !isAbsolute(saved.root) || saved.root.includes('\0') || typeof saved.id !== 'string'
        || typeof saved.hash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(saved.hash)) throw new Error();
      const within = (value: string) => !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
      if (!(vscode.workspace.workspaceFolders ?? []).some(folder => within(relative(folder.uri.fsPath, saved.root)) || within(relative(saved.root, folder.uri.fsPath)))) throw new Error();
      const repo = await repositories.forUri(vscode.Uri.file(saved.root));
      if (!repo || repo.id !== saved.id || relative(repo.root, saved.root) !== '') throw new Error();
      const hash = (await this.git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${saved.hash}^{commit}`], { signal })).trim();
      if (hash !== saved.hash) throw new Error();
      if (request !== this.generation) return;
      await this.showCommit(repo, hash, false);
      if (this.generation === request + 1 && this.current?.detail.hash === hash && this.current.repo.id === repo.id) {
        this.pinned = true;
        await vscode.commands.executeCommand('setContext', 'gitpeek.detailsPinned', true);
      }
    } catch {
      if (request !== this.generation) return;
      this.persistPin();
      await vscode.window.showInformationMessage('GitPeek：固定的提交详情已失效，未恢复；请重新选择仓库或提交。');
    }
  }

  async showCommit(repo: Repository, hash: string, focus = true): Promise<void> {
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    this.pending = { repo, hash };
    if (this.pinned && this.current) {
      await vscode.commands.executeCommand('setContext', 'gitpeek.hasCommitDetails', true);
      if (!this.current) return;
      await vscode.window.showInformationMessage('GitPeek：提交详情已固定，取消固定后可查看所选提交。');
      await vscode.commands.executeCommand('gitpeek.commitDetails.focus');
      return;
    }
    const request = ++this.generation;
    this.detailsQuery?.abort();
    const signal = (this.detailsQuery = new AbortController()).signal;
    this.current = undefined;
    this.rows = [new vscode.TreeItem('正在加载提交详情…')]; this.changed.fire();
    await vscode.commands.executeCommand('setContext', 'gitpeek.hasCommitDetails', true);
    if (request !== this.generation) return;
    if (focus) await vscode.commands.executeCommand('gitpeek.commitDetails.focus');
    try {
      const detail = await loadCommitDetail(this.git, repo, hash, signal);
      const message = (await this.git.run(repo, ['show', '-s', '--format=%B', detail.hash], { signal })).replace(/\n+$/, '');
      const workspacePaths = await resolveWorkspacePaths(this.git, repo, detail.hash, detail.files, signal);
      if (request !== this.generation) return;
      this.current = { repo, detail };
      this.content.register(repo);
      const commitTarget = { repo, hash: detail.hash };
      const heading = Object.assign(new vscode.TreeItem(detail.subject || detail.shortHash), {
        description: detail.shortHash, contextValue: 'gitpeek.detailCommit', commitTarget,
        tooltip: `${repo.root}\n${detail.hash}\n\n${message}`,
      });
      this.rows = [
        heading,
        Object.assign(new vscode.TreeItem(detail.author), {
          description: `${formatDate(detail.date)} · ${basename(repo.root)}`,
          tooltip: `${detail.author}\n${formatDate(detail.date)}\n${repo.root}`,
        }),
        Object.assign(new vscode.TreeItem(`变更文件 · ${detail.files.length} 个`), { description: `+${detail.additions} −${detail.deletions}` }),
        ...detail.files.map((file) => {
          const workspacePath = workspacePaths.get(file.path);
          return {
            ...new vscode.TreeItem(`${statusLabel(file.status)} ${file.path}`),
            description: `+${file.additions ?? 0} −${file.deletions ?? 0}${file.oldPath ? ` · 来源于 ${file.oldPath}` : ''}`,
            contextValue: 'gitpeek.detailFile', fileTarget: { repo, path: workspacePath ?? file.path, workspacePathKnown: Boolean(workspacePath) },
            commitTarget: { ...commitTarget, file: file.path, workspacePath, workspacePathKnown: Boolean(workspacePath) },
            command: { command: 'gitpeek.internal.details.openDiff', title: '打开差异', arguments: [repo, detail.hash, file.path, workspacePath] },
          };
        }),
        ...(message.includes('\n') ? [Object.assign(new vscode.TreeItem('完整提交说明', vscode.TreeItemCollapsibleState.Collapsed), {
          tooltip: message,
          children: message.split(/\r?\n/).map(line => Object.assign(new vscode.TreeItem(line || ' '), { tooltip: message })),
        })] : []),
      ];
      this.changed.fire();
    } catch (error) {
      if (request !== this.generation) return;
      this.rows = [new vscode.TreeItem(`无法加载提交：${errorMessage(error)}`)]; this.changed.fire();
      await vscode.window.showErrorMessage(`GitPeek：无法显示提交：${errorMessage(error)}`);
    }
  }

  async showDiff(repo: Repository, hash: string, filePath?: string, workspacePath?: string, history?: Pick<FileRevisionContext, 'historyHead' | 'historyFile'>, location?: DiffLocation): Promise<void> {
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    const request = ++this.diffGeneration;
    this.diffQuery?.abort();
    const signal = (this.diffQuery = new AbortController()).signal;
    const current = () => request === this.diffGeneration && vscode.workspace.getConfiguration('gitpeek').get('enabled', true);
    try {
      const historyHead = history?.historyHead ?? (workspacePath ? (await this.git.run(repo, ['rev-parse', '--verify', 'HEAD'], { signal }).catch(error => { if (signal.aborted) throw error; return ''; })).trim() : '');
      if (history && (!/^[0-9a-f]{40,64}$/i.test(historyHead) || !validFile(history.historyFile))) throw new Error('文件历史快照无效。');
      const detail = await loadCommitDetail(this.git, repo, hash, signal);
      if (!current()) return;
      this.content.register(repo);
      if (!filePath && detail.files.length > 1) {
        const selected = await vscode.window.showQuickPick(detail.files.map((file) => ({ label: `${statusLabel(file.status)} ${file.path}`, description: `${file.oldPath ? `${file.oldPath} → ` : ''}+${file.additions ?? 0} −${file.deletions ?? 0}`, file })), { title: `${detail.shortHash} ${detail.subject}`, placeHolder: '选择一个文件以打开差异' });
        if (!selected || !current()) return;
        filePath = selected.file.path;
      }
      filePath ??= detail.files[0]?.path;
      if (!filePath) {
        await vscode.window.showInformationMessage('GitPeek：此提交没有文件更改。');
        return;
      }
      await this.showDiffForCommit(repo, detail, filePath, workspacePath, {
        historyHead: /^[0-9a-f]{40,64}$/i.test(historyHead) ? historyHead : detail.hash,
        historyFile: history?.historyFile ?? (historyHead && workspacePath ? workspacePath : filePath),
        currentCommit: detail.hash, currentFile: filePath,
      }, current, location, signal);
    } catch (error) {
      if (current()) await vscode.window.showErrorMessage(`GitPeek：无法打开差异：${errorMessage(error)}`);
    }
  }

  private async navigateRevision(direction: -1 | 1, target?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    const source = this.activeRevisionUri();
    const uri = target ?? source;
    if (!uri || uri.scheme !== CONTENT_SCHEME) {
      await vscode.window.showInformationMessage('GitPeek：请先打开一个提交文件差异。'); return;
    }
    const request = ++this.diffGeneration;
    this.diffQuery?.abort();
    const signal = (this.diffQuery = new AbortController()).signal;
    const current = () => request === this.diffGeneration && vscode.workspace.getConfiguration('gitpeek').get('enabled', true)
      && this.activeRevisionUri()?.toString() === source?.toString();
    try {
      const { repo, ref } = this.content.navigation(uri);
      const { context, commit } = await adjacentFileRevision(this.git, repo, ref, direction, signal);
      if (!current()) return;
      if (!commit) {
        await vscode.window.showInformationMessage(direction === 1 ? 'GitPeek：已到此文件的最早修改。' : 'GitPeek：已到本次历史快照的最新修改。'); return;
      }
      const detail = await loadCommitDetail(this.git, repo, commit.hash, signal);
      if (!current()) return;
      await this.showDiffForCommit(repo, detail, commit.filePath, ref.workspacePath, {
        ...context, currentCommit: commit.hash, currentFile: commit.filePath,
      }, current, undefined, signal);
    } catch (error) {
      if (current()) await vscode.window.showErrorMessage(`GitPeek：无法切换文件版本：${errorMessage(error)}`);
    }
  }

  private activeRevisionUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return input.modified;
    if (input instanceof vscode.TabInputText) return input.uri;
    return undefined;
  }

  private async showDiffForCommit(repo: Repository, detail: CommitDetail, filePath: string, workspacePath: string | undefined, revision: FileRevisionContext, current: () => boolean, location?: DiffLocation, signal?: AbortSignal): Promise<void> {
    const loaded = await loadCommitDiffContents(this.git, repo, detail, filePath, signal);
    if (!current()) return;
    revision = { ...revision, currentFile: loaded.file.path };
    const oldPath = loaded.file.status === 'R' ? loaded.file.oldPath! : loaded.file.path;
    const oldUri = this.content.uri(repo, loaded.parent ?? '', oldPath, 'before', loaded.file.status === 'A' || !loaded.parent, loaded.binary, workspacePath, revision);
    const newUri = this.content.uri(repo, detail.hash, loaded.file.path, 'after', loaded.file.status === 'D', loaded.binary, workspacePath, revision);
    this.content.cache(oldUri, loaded.oldContent);
    this.content.cache(newUri, loaded.newContent);
    const before = loaded.parent ? loaded.parent.slice(0, detail.shortHash.length) : '空文件';
    const title = `${basename(repo.root)} · ${loaded.file.oldPath ? `${loaded.file.oldPath} → ` : ''}${loaded.file.path} (${before} → ${detail.shortHash})${loaded.binary ? ' · 二进制文件' : ''}`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
    if (location) {
      const line = location.line - 1;
      const text = (location.side === 'left' ? loaded.oldContent : loaded.newContent).split(/\r?\n/)[line];
      const uri = location.side === 'left' ? oldUri : newUri;
      const editor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
      if (!loaded.binary && Number.isInteger(line) && line >= 0 && text !== undefined
        && (!location.text || text.includes(location.text)) && editor) {
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      } else await vscode.window.showInformationMessage('GitPeek：已打开文件差异，但无法确认或显示命中行的位置。');
    }
  }
}

export function registerCommitFeatures(context: vscode.ExtensionContext, git: GitService, repositories?: RepositoryService): {
  showCommit(repo: Repository, hash: string): Promise<void>;
  showDiff(repo: Repository, hash: string, file?: string, workspacePath?: string, history?: Pick<FileRevisionContext, 'historyHead' | 'historyFile'>, location?: DiffLocation): Promise<void>;
} {
  const features = new CommitFeatures(git);
  features.register(context, repositories);
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

