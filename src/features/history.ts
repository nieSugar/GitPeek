import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { FileHistoryCommit, Repository } from '../git/types';
import { isGitPeekEditor } from './virtualEditor';
import { validFile, validRevisionContext, type FileRevisionContext } from './fileRevisions';
import { resolveWorkspacePaths } from './gitContent';
import { listHistoryFiles, listHistoryReferences, resolveHistoryReference } from './historyReferences';

const DEFAULT_LIMIT = 20;
const PAGE_SIZE = 20;
const CACHE_TTL = 60_000;
const STATE_KEY = 'gitpeek.investigation.history.v1';
const SAVED_TRAIL_LIMIT = 20;
type HistorySnapshot = Pick<FileRevisionContext, 'historyHead' | 'historyFile'>;
type ShowDiff = (repo: Repository, hash: string, file: string, workspacePath?: string, history?: HistorySnapshot) => void | Promise<void>;
type HistoryItem = vscode.TreeItem;
interface Investigation {
  repo: Repository;
  file: string;
  ref: string;
  head?: string;
  workspacePath?: string;
  limit: number;
  selectedHash?: string;
}
export interface HistoryPage {
  commits: FileHistoryCommit[];
  hasMore: boolean;
  head?: string;
}

export class FileHistoryService {
  private readonly cache = new Map<string, { expires: number; limit: number; commits: FileHistoryCommit[]; hasMore: boolean }>();
  constructor(private readonly git: GitService) {}

  async load(repo: Repository, file: string, limit = DEFAULT_LIMIT, ref = 'HEAD', signal?: AbortSignal): Promise<HistoryPage> {
    const count = Math.max(1, Math.floor(limit));
    let head: string;
    try { head = await resolveHistoryReference(this.git, repo, ref, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (ref === 'HEAD') return { commits: [], hasMore: false };
      throw error;
    }
    const key = `${repo.id}\0${repo.root}\0${file}\0${head}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now() && cached.limit >= count) {
      return { head, commits: cached.commits.slice(0, count), hasMore: cached.commits.length > count || cached.hasMore };
    }
    const all = await this.git.history(repo, file, count + 1, head, signal);
    signal?.throwIfAborted();
    const commits = all.slice(0, count), hasMore = all.length > count;
    this.cache.set(key, { expires: Date.now() + CACHE_TTL, limit: count, commits, hasMore });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return { head, commits, hasMore };
  }

  invalidate(repoId?: string): void {
    if (repoId === undefined) this.cache.clear();
    else for (const key of this.cache.keys()) if (key.startsWith(`${repoId}\0`)) this.cache.delete(key);
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

export async function registerHistory(context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService, showDiff?: ShowDiff): Promise<HistoryFeature> {
  const vscode = await import('vscode');
  const service = new FileHistoryService(git);
  const changed = new vscode.EventEmitter<HistoryItem | undefined>();
  const trail: Investigation[] = [];
  let cursor = -1, generation = 0, editorGeneration = 0, pinned = false;
  let active: Investigation | undefined;
  let query: { request: number; controller: AbortController; result: Promise<HistoryItem[]> } | undefined;
  let scopeQuery: AbortController | undefined;
  let restoring = true;
  const watchers = new Set<string>();
  const enabled = () => vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true);
  const initialLimit = () => Math.max(1, vscode.workspace.getConfiguration('gitpeek.history').get<number>('limit', DEFAULT_LIMIT));
  const sameRepo = (a: Repository, b: Repository) => a.id === b.id && path.relative(a.root, b.root) === '';
  const sameTarget = (a: Investigation, b: Investigation) => sameRepo(a.repo, b.repo) && a.file === b.file && a.ref === b.ref;
  const persist = () => {
    if (restoring || !context.workspaceState) return;
    const objects = trail.filter(item => item.head), index = objects.indexOf(active!);
    const start = Math.max(0, Math.min(index < 0 ? objects.length : index, objects.length - SAVED_TRAIL_LIMIT));
    const saved = objects.slice(start, start + SAVED_TRAIL_LIMIT);
    void context.workspaceState.update(STATE_KEY, { version: 1, pinned, cursor: saved.indexOf(active!), trail: saved.map(item => ({
      ...item, repo: { root: item.repo.root, id: item.repo.id }, ref: item.head, limit: Math.min(item.limit, 2000),
    })) });
  };
  const invalidate = () => {
    generation++;
    query?.controller.abort(); query = undefined;
    scopeQuery?.abort(); scopeQuery = undefined;
  };
  const referenceLabel = (ref: string) => ref === 'HEAD' ? '当前分支' : /^[0-9a-f]{40,64}$/i.test(ref) ? ref.slice(0, 8)
    : ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '远程：').replace(/^refs\/tags\//, '标签：');
  const updateContext = () => {
    void vscode.commands.executeCommand('setContext', 'gitpeek.historyPinned', pinned);
    void vscode.commands.executeCommand('setContext', 'gitpeek.historyHasTarget', Boolean(active));
    void vscode.commands.executeCommand('setContext', 'gitpeek.historyCanGoBack', cursor > 0);
    void vscode.commands.executeCommand('setContext', 'gitpeek.historyCanGoForward', cursor >= 0 && cursor < trail.length - 1);
  };
  const announce = () => {
    invalidate();
    view.description = active ? `${referenceLabel(active.ref)}${pinned ? ' · 已固定' : ''}` : undefined;
    updateContext(); changed.fire(undefined); persist();
  };
  const visit = (target: Investigation) => {
    if (active && sameTarget(active, target) && (!target.head || target.head === active.head)) return;
    const previous = [...trail].reverse().find(item => sameTarget(item, target) && (!target.head || target.head === item.head));
    active = previous ? { ...previous } : target;
    trail.splice(cursor + 1); trail.push(active);
    if (trail.length > 50) trail.shift();
    cursor = trail.length - 1; announce();
  };
  const targetFromUri = async (uri?: vscode.Uri): Promise<Investigation | undefined> => {
    if (uri?.scheme === 'file') {
      const repo = await repositories.forUri(uri);
      if (!repo) return undefined;
      const file = relativeHistoryPath(repo.root, uri.fsPath);
      return validFile(file) ? { repo, file, workspacePath: file, ref: 'HEAD', limit: initialLimit() } : undefined;
    }
    if (uri?.scheme !== 'gitpeek-commit') return undefined;
    try {
      const value = JSON.parse(uri.query) as FileRevisionContext & { repoId?: unknown; root?: unknown; workspacePath?: unknown };
      if (!validRevisionContext(value) || typeof value.repoId !== 'string' || typeof value.root !== 'string'
        || !path.isAbsolute(value.root) || (value.workspacePath !== undefined && !validFile(value.workspacePath))) return undefined;
      const repo = await repositories.forUri(vscode.Uri.file(value.root));
      if (!repo || repo.id !== value.repoId || path.relative(repo.root, value.root) !== '') return undefined;
      const previous = [...trail].reverse().find(item => sameRepo(item.repo, repo) && item.head === value.historyHead && item.file === value.historyFile);
      return previous ? { ...previous, ref: previous.ref === 'HEAD' ? value.historyHead : previous.ref } : { repo, file: value.historyFile, ref: value.historyHead, head: value.historyHead,
        workspacePath: value.workspacePath as string | undefined, limit: initialLimit() };
    } catch { return undefined; }
  };
  const watchRepository = async (repo: Repository, signal: AbortSignal): Promise<void> => {
    const key = `${repo.id}\0${repo.root}`;
    if (watchers.has(key)) return;
    watchers.add(key);
    let paths: string[];
    try {
      paths = await Promise.all(['HEAD', 'packed-refs', 'refs', 'logs/HEAD'].map(async gitPath =>
        path.resolve(repo.root, (await git.run(repo, ['rev-parse', '--git-path', gitPath], { signal })).trim())));
      signal.throwIfAborted();
    } catch (error) { watchers.delete(key); if (signal.aborted) throw error; return; }
    for (const watchedPath of paths) {
      const refsDirectory = path.basename(watchedPath) === 'refs';
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(refsDirectory ? watchedPath : path.dirname(watchedPath)), refsDirectory ? '**/*' : path.basename(watchedPath),
      ));
      const changedRefs = () => {
        service.invalidate(repo.id);
        if (active && sameRepo(active.repo, repo)) { invalidate(); changed.fire(undefined); }
      };
      watcher.onDidChange(changedRefs); watcher.onDidCreate(changedRefs); watcher.onDidDelete(changedRefs);
      context.subscriptions.push(watcher);
    }
  };
  const buildRows = async (signal: AbortSignal): Promise<HistoryItem[]> => {
    const target = active, request = generation;
    if (!enabled()) return [message(vscode, 'GitPeek 已在设置中禁用。')];
    if (!target) return [message(vscode, '打开一个文件以查看其历史。')];
    try {
      await watchRepository(target.repo, signal);
      if (request !== generation) return [];
      const snapshot = pinned || target.ref !== 'HEAD';
      const page = await service.load(target.repo, target.file, target.limit, snapshot ? target.head ?? target.ref : 'HEAD', signal);
      const workspacePath = snapshot && page.head
        ? (await resolveWorkspacePaths(git, target.repo, page.head, [{ path: target.file, status: 'M' }], signal)).get(target.file)
        : target.workspacePath;
      if (request !== generation || target !== active || !enabled()) return [];
      target.head = page.head;
      persist();
      const fileTarget = { repo: target.repo, path: workspacePath ?? target.file, workspacePathKnown: Boolean(workspacePath) };
      const scope = `${referenceLabel(target.ref)}${page.head ? ` · ${page.head.slice(0, 8)}` : ''}${pinned ? ' · 已固定' : ''}`;
      const rows: HistoryItem[] = [Object.assign(message(vscode, target.file), {
        id: `file:${JSON.stringify([target.repo.id, target.repo.root, target.file, target.ref])}`,
        description: path.basename(target.repo.root),
        tooltip: `仓库：${target.repo.root}\n历史文件：${target.file}\n调查范围：${scope}\n引用：${target.ref}${workspacePath ? `\n当前文件：${workspacePath}` : '\n未确认工作区对应文件'}`,
        contextValue: 'gitpeek.historyFile', fileTarget,
      })];
      rows.push(...page.commits.map(commit => Object.assign(commitItem(vscode, target.repo, commit, workspacePath), {
        id: `commit:${JSON.stringify([target.repo.id, target.repo.root, target.file, page.head, commit.hash])}`,
        fileTarget, commitTarget: { repo: target.repo, hash: commit.hash, file: commit.filePath, workspacePath, workspacePathKnown: Boolean(workspacePath) },
        ...(showDiff ? { command: { command: 'gitpeek.internal.fileHistory.showDiff', title: '查看文件差异',
          arguments: [target.repo, commit.hash, commit.filePath, workspacePath, { historyHead: page.head, historyFile: target.file }] } } : {}),
      })));
      if (!page.commits.length) rows.push(message(vscode, '此文件在所选版本没有提交记录。'));
      else if (page.hasMore) rows.push(moreItem(vscode, target, generation));
      return rows;
    } catch (error) { return !signal.aborted && request === generation ? [message(vscode, `无法加载文件历史：${String(error)}`)] : []; }
  };
  const loadRows = (): Promise<HistoryItem[]> => {
    if (query?.request === generation) return query.result;
    query?.controller.abort();
    const controller = new AbortController();
    const result = buildRows(controller.signal);
    query = { request: generation, controller, result };
    return result;
  };
  const provider: vscode.TreeDataProvider<HistoryItem> = {
    onDidChangeTreeData: changed.event, getTreeItem: item => item, getParent: () => undefined,
    getChildren: item => item ? [] : loadRows(),
  };
  const view = vscode.window.createTreeView('gitpeek.fileHistory', { treeDataProvider: provider });
  const restoreSelection = async () => {
    const request = generation, selectedHash = active?.selectedHash;
    if (!selectedHash) return;
    const row = (await loadRows()).find(item => (item as { commitTarget?: { hash: string } }).commitTarget?.hash === selectedHash);
    if (row && request === generation) await view.reveal(row, { select: true, focus: false });
  };
  const show = async (uri: vscode.Uri): Promise<void> => {
    if (!enabled()) { await vscode.window.showInformationMessage('GitPeek：请先启用扩展。'); return; }
    const request = ++editorGeneration;
    const target = await targetFromUri(uri) ?? (uri.scheme.startsWith('gitpeek-') ? active : undefined);
    if (request !== editorGeneration || !enabled()) return;
    if (!target) { await vscode.window.showInformationMessage('GitPeek：请先打开一个 Git 工作区文件以查看其历史。'); return; }
    visit(target);
    await vscode.commands.executeCommand('gitpeek.fileHistory.focus');
    await restoreSelection();
  };
  const refresh = (): void => {
    service.invalidate();
    if (active && !pinned && active.ref === 'HEAD') active.head = undefined;
    announce();
  };
  const chooseScope = async (chooseFile = false) => {
    if (!enabled() || !active) return;
    const origin = active, request = generation, editorRequest = ++editorGeneration;
    scopeQuery?.abort();
    const controller = scopeQuery = new AbortController();
    const signal = controller.signal;
    const current = () => enabled() && request === generation && editorRequest === editorGeneration && active === origin;
    try {
      let ref = origin.ref;
      if (!chooseFile) {
        const references = await listHistoryReferences(git, origin.repo, signal);
        if (!current()) return;
        const choice = await vscode.window.showQuickPick([
          { ref: 'HEAD', label: '跟随当前分支', description: 'HEAD' }, ...references,
          { ref: '', label: '输入引用…', description: '分支、标签或提交 Hash' },
        ], { title: `文件历史 · ${path.basename(origin.repo.root)}`, placeHolder: '选择调查范围，不切换工作区分支', matchOnDescription: true });
        if (!choice || !current()) return;
        const entered = choice.ref || await vscode.window.showInputBox({ title: '文件历史引用', prompt: '输入分支、标签或提交 Hash', value: origin.ref });
        if (!entered || !current()) return;
        ref = entered;
      }
      const head = chooseFile && origin.head ? origin.head : await resolveHistoryReference(git, origin.repo, ref, signal);
      const files = await listHistoryFiles(git, origin.repo, head, signal);
      if (!current()) return;
      let file = origin.file;
      if (chooseFile || !files.includes(file)) {
        const choices = files.map(file => ({ label: file, file, description: '' }));
        if (!chooseFile && (await git.history(origin.repo, file, 1, head, signal)).length) {
          choices.unshift({ label: file, file, description: '原路径已不存在，查看删除或重命名前的历史' });
        }
        if (!current()) return;
        const choice = await vscode.window.showQuickPick(choices, {
          title: `选择历史文件 · ${referenceLabel(ref)}`,
          placeHolder: chooseFile ? '选择该版本中的文件' : '该版本中没有原路径，请明确选择历史文件',
        });
        if (!choice || !current()) return;
        file = choice.file;
      }
      const target: Investigation = { repo: origin.repo, file, ref, head, limit: initialLimit(),
        workspacePath: ref === 'HEAD' && file === origin.file ? origin.workspacePath : undefined };
      pinned = chooseFile || ref !== 'HEAD' || pinned;
      editorGeneration++; visit(target); announce();
      await vscode.commands.executeCommand('gitpeek.fileHistory.focus');
      await restoreSelection();
    } catch (error) { if (!signal.aborted && current()) await vscode.window.showErrorMessage(`GitPeek：无法切换调查范围：${String(error)}`); }
  };
  const move = async (direction: number) => {
    const next = cursor + direction;
    if (!enabled() || next < 0 || next >= trail.length) return;
    editorGeneration++; pinned = true; cursor = next; active = trail[cursor]; announce();
    await vscode.commands.executeCommand('gitpeek.fileHistory.focus');
    await restoreSelection();
  };
  const followEditor = async (editor?: vscode.TextEditor) => {
    if (pinned || !enabled()) return;
    const request = ++editorGeneration;
    const target = await targetFromUri(editor?.document.uri);
    if (request !== editorGeneration || pinned || !enabled()) return;
    if (isGitPeekEditor(editor) && (!target || (active && sameTarget(active, target) && target.head === active.head))) return;
    if (target) visit(target);
  };
  context.subscriptions.push(changed, view,
    view.onDidChangeSelection(event => {
      const [repo, hash, , , snapshot] = event.selection[0]?.command?.arguments ?? [];
      if (active && repo && sameRepo(active.repo, repo) && snapshot?.historyHead === active.head && snapshot.historyFile === active.file) { active.selectedHash = hash; persist(); }
    }),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    vscode.window.onDidChangeWindowState(event => { if (event.focused) { invalidate(); changed.fire(undefined); } }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (active?.workspacePath && document.uri.fsPath === path.resolve(active.repo.root, active.workspacePath)) { invalidate(); changed.fire(undefined); }
    }),
    vscode.workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('gitpeek.enabled')) {
        editorGeneration++;
        announce();
        if (enabled() && !pinned) await followEditor(vscode.window.activeTextEditor);
      }
      if (event.affectsConfiguration('gitpeek.history.limit')) { if (active) active.limit = initialLimit(); refresh(); }
    }),
    vscode.commands.registerCommand('gitpeek.fileHistory', async (target?: vscode.Uri) => {
      const uri = target ?? vscode.window.activeTextEditor?.document.uri;
      if (uri) await show(uri);
      else if (active && enabled()) await vscode.commands.executeCommand('gitpeek.fileHistory.focus');
      else await vscode.window.showInformationMessage('GitPeek：请先打开一个文件以查看其历史。');
    }),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.loadMore', (target?: Investigation, request?: number) => {
      if (!active || !enabled() || (target && (target !== active || request !== generation))) return;
      active.limit += PAGE_SIZE; announce();
    }),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.pin', () => { if (active && enabled()) { editorGeneration++; pinned = true; announce(); } }),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.unpin', async () => {
      if (!enabled()) return;
      pinned = false; announce();
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) await show(uri);
    }),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.chooseRef', () => chooseScope()),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.chooseFile', () => chooseScope(true)),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.back', () => move(-1)),
    vscode.commands.registerCommand('gitpeek.internal.fileHistory.forward', () => move(1)),
  );
  context.subscriptions.push({ dispose: invalidate });
  if (view.onDidChangeVisibility) context.subscriptions.push(view.onDidChangeVisibility(() => { invalidate(); changed.fire(undefined); }));
  if (showDiff) context.subscriptions.push(vscode.commands.registerCommand('gitpeek.internal.fileHistory.showDiff',
    async (repo: Repository, hash: string, file: string, workspacePath?: string, history?: HistorySnapshot) => {
      if (!enabled()) return;
      if (active && sameRepo(active.repo, repo) && history?.historyFile === active.file && history.historyHead === active.head) { active.selectedHash = hash; persist(); }
      await showDiff(repo, hash, file, workspacePath, history);
    }));
  const startup = editorGeneration;
  const stored = context.workspaceState?.get<{ version: number; pinned: boolean; cursor: number; trail: Investigation[] }>(STATE_KEY);
  let invalid = 0;
  if (stored) {
    if (stored.version !== 1 || !Array.isArray(stored.trail) || stored.trail.length > SAVED_TRAIL_LIMIT
      || typeof stored.pinned !== 'boolean' || !Number.isInteger(stored.cursor) || stored.cursor < -1 || stored.cursor >= stored.trail.length) invalid++;
    else {
      const restored: Array<Investigation | undefined> = [];
      for (const saved of stored.trail) {
        try {
          if (!saved || !saved.repo || typeof saved.repo.id !== 'string' || typeof saved.repo.root !== 'string'
            || !path.isAbsolute(saved.repo.root) || saved.repo.root.includes('\0') || !validFile(saved.file)
            || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(saved.head ?? '') || saved.ref !== saved.head
            || !Number.isInteger(saved.limit) || saved.limit < 1 || saved.limit > 2000
            || (saved.workspacePath !== undefined && !validFile(saved.workspacePath))
            || (saved.selectedHash !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(saved.selectedHash))) throw new Error();
          const belongsToWorkspace = (vscode.workspace.workspaceFolders ?? []).some(folder => {
            const relative = path.relative(folder.uri.fsPath, saved.repo.root), reverse = path.relative(saved.repo.root, folder.uri.fsPath);
            const within = (value: string) => !path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`);
            return within(relative) || within(reverse);
          });
          if (!belongsToWorkspace) throw new Error();
          const repo = await repositories.forUri(vscode.Uri.file(saved.repo.root));
          if (!repo || !sameRepo(repo, saved.repo)) throw new Error();
          const page = await service.load(repo, saved.file, saved.limit, saved.head);
          if (!page.commits.length) throw new Error();
          const target = { ...saved, repo };
          if (target.selectedHash && !page.commits.some(commit => commit.hash === target.selectedHash)) { target.selectedHash = undefined; invalid++; }
          restored.push(target);
        } catch { restored.push(undefined); invalid++; }
        if (startup !== editorGeneration) break;
      }
      if (startup === editorGeneration) {
        trail.push(...restored.filter((item): item is Investigation => Boolean(item)));
        const selected = restored[stored.cursor];
        cursor = selected ? trail.indexOf(selected) : trail.length - 1;
        if (stored.pinned && selected) { active = selected; pinned = true; announce(); }
      }
    }
  }
  restoring = false;
  if (invalid) await vscode.window.showInformationMessage(`GitPeek：${invalid} 个已保存的调查对象已失效，未恢复；请重新选择仓库、提交或文件。`);
  if (startup === editorGeneration) await followEditor(vscode.window.activeTextEditor);
  updateContext();
  if (pinned && active?.selectedHash) await restoreSelection();
  return { provider, show, refresh };
}

function message(vscode: typeof import('vscode'), label: string): HistoryItem { return new vscode.TreeItem(label); }
function commitItem(vscode: typeof import('vscode'), repo: Repository, commit: FileHistoryCommit, workspacePath?: string): HistoryItem {
  const date = new Date(commit.date).toLocaleDateString('zh-CN');
  const item = new vscode.TreeItem(commit.subject, vscode.TreeItemCollapsibleState.None);
  item.description = `${commit.author} · ${date} · ${commit.shortHash}`;
  item.tooltip = `${commit.subject}\n${commit.author} · ${date}\n${commit.hash}\n仓库：${repo.root}\n历史文件：${commit.filePath}${workspacePath ? `\n当前文件：${workspacePath}` : ''}`;
  item.iconPath = new vscode.ThemeIcon('git-commit'); item.contextValue = 'gitpeek.historyCommit';
  return item;
}
function moreItem(vscode: typeof import('vscode'), target: Investigation, generation: number): HistoryItem {
  const item = new vscode.TreeItem('加载更多…', vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon('ellipsis');
  item.command = { command: 'gitpeek.internal.fileHistory.loadMore', title: '加载更多', arguments: [target, generation] };
  return item;
}
