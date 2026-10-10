import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseNameStatus, parseNumStat } from '../git/GitParser';
import type { GitService } from '../git/GitService';
import type { CommitTarget, FileChange, Repository } from '../git/types';
import { isBinaryNumstat, readCommitContent, resolveWorkspacePaths, type CommitContentRef } from './gitContent';
import { samePath } from './smartCommit';
import { previewStash, type StashEntry } from './stashList';
import { validFile } from './fileRevisions';

export async function resolveCommit(git: GitService, repo: Repository, ref: string, signal?: AbortSignal): Promise<string> {
  const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal })).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error('提交引用无效。');
  return hash;
}

export async function compareRevisions(git: GitService, repo: Repository, from: string, to: string, signal?: AbortSignal) {
  const [left, right] = await Promise.all([resolveCommit(git, repo, from, signal), resolveCommit(git, repo, to, signal)]);
  const [names, stats] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', left, right, '--'], { signal }),
    git.run(repo, ['diff', '--numstat', '-z', '-M', left, right, '--'], { signal }),
  ]);
  const counts = parseNumStat(stats);
  const files = parseNameStatus(names).map(file => ({ ...file, ...counts.get(file.path), binary: isBinaryNumstat(stats, file.path) }));
  return { repo, left, right, files };
}

export async function revisionContents(git: GitService, repo: Repository, left: string, right: string, file: FileChange & { binary: boolean }, signal?: AbortSignal) {
  const oldPath = file.oldPath ?? file.path;
  const before = await readCommitContent(git, repo, { ref: left, file: oldPath, side: 'before', empty: file.status === 'A', binary: file.binary }, signal);
  const after = await readCommitContent(git, repo, { ref: right, file: file.path, side: 'after', empty: file.status === 'D', binary: file.binary }, signal);
  return { before, after };
}

export async function workingContents(git: GitService, target: CommitTarget, signal?: AbortSignal) {
  if (!target.file) throw new Error('请选择一个历史文件。');
  const file = target.workspacePath ?? target.file;
  if (!validFile(target.file) || !validFile(file)) throw new Error('文件路径不在仓库中。');
  const diskPath = resolve(target.repo.root, file);
  const rel = relative(target.repo.root, diskPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件路径不在仓库中。');
  const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && samePath(doc.uri.fsPath, diskPath));
  const editor = document ? { text: document.getText(), dirty: document.isDirty } : undefined;
  const source = editor ? `编辑器快照（${editor.dirty ? '未保存' : '已保存'}）` : '工作区磁盘快照';
  const head = await resolveCommit(git, target.repo, 'HEAD', signal);
  const hash = await resolveCommit(git, target.repo, target.hash, signal);
  const workspacePaths = await resolveWorkspacePaths(git, target.repo, hash, [{ path: target.file, status: 'M' }], signal);
  if (target.workspacePathKnown === false || workspacePaths.get(target.file) !== file) throw new Error('无法确认此历史文件对应的当前工作区路径，请重新打开文件历史。');
  const exists = await git.run(target.repo, ['ls-tree', '-z', hash, '--', `:(literal)${target.file}`], { signal });
  const before = exists ? await git.run(target.repo, ['show', `${hash}:${target.file}`], { signal }) : '';
  let bytes: Buffer;
  try { bytes = editor ? Buffer.from(editor.text, 'utf8') : await readFile(diskPath, { signal }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
  if (await resolveCommit(git, target.repo, 'HEAD', signal) !== head) throw new Error('HEAD 已变化，请重新发起工作区比较。');
  const binary = before.includes('\0') || bytes.includes(0);
  return { hash, file, source, binary, before: binary && exists ? `[二进制文件（提交 ${hash.slice(0, 7)}）：${target.file}]\n` : before,
    after: binary && bytes.length ? `[二进制文件（${source}）：${file}]\n` : bytes.toString('utf8') };
}

export function registerRevisionCompare(context: vscode.ExtensionContext, git: GitService): void {
  let selected: (CommitTarget & { subject: string }) | undefined;
  let generation = 0;
  let diffGeneration = 0;
  let query: AbortController | undefined;
  let diffQuery: AbortController | undefined;
  const cancelReads = () => { query?.abort(); diffQuery?.abort(); query = undefined; diffQuery = undefined; };
  let activeComparison: (Awaited<ReturnType<typeof compareRevisions>> & { generation: number }) | undefined;
  let serial = 0;
  let rows: vscode.TreeItem[] = [new vscode.TreeItem('右键提交，选择两个提交进行比较。')];
  const changed = new vscode.EventEmitter<void>();
  const contents = new Map<string, string>();
  const repositories = new Map<string, Repository>();
  const enabled = () => vscode.workspace.getConfiguration('gitpeek').get('enabled', true);
  const targetOf = (item?: { commitTarget?: CommitTarget }) => item?.commitTarget;
  const commitRow = (side: string, target: CommitTarget & { subject: string }) => Object.assign(new vscode.TreeItem(`${side}：${target.subject}`), {
    description: target.hash.slice(0, 7), tooltip: `${side}：${target.subject}\n${target.hash}\n仓库：${target.repo.root}`,
  });
  const view = vscode.window.createTreeView('gitpeek.comparison', { treeDataProvider: { onDidChangeTreeData: changed.event, getTreeItem: (item: vscode.TreeItem) => item, getChildren: () => rows } });
  void vscode.commands.executeCommand('setContext', 'gitpeek.hasComparison', false);
  const showContents = async (repo: Repository, before: string, after: string, file: string, title: string, refs?: { before: CommitContentRef; after: CommitContentRef }) => {
    if (!enabled()) return;
    const id = ++serial;
    repositories.set(`${repo.id}\0${repo.root}`, repo);
    const uri = (side: 'before' | 'after') => vscode.Uri.from({ scheme: 'gitpeek-compare', path: `/${file}`, query: JSON.stringify({ repoId: repo.id, root: repo.root, id, side, content: refs?.[side] }) });
    const left = uri('before'), right = uri('after');
    contents.set(left.toString(), before); contents.set(right.toString(), after);
    const open = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
    // ponytail: retain open snapshots; immutable commit contents can be reloaded after cache eviction.
    for (const key of contents.keys()) if (contents.size > 64 && !open.has(key)) contents.delete(key);
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  };
  const guarded = (action: (item?: { commitTarget?: CommitTarget }) => Promise<void>) => async (item?: { commitTarget?: CommitTarget }) => {
    if (!enabled()) return;
    try { await action(item); } catch (error) { if ((error as Error).name !== 'AbortError' && enabled()) await vscode.window.showErrorMessage(`GitPeek：比较失败：${String(error)}`); }
  };
  context.subscriptions.push(changed, view,
    { dispose: () => { generation++; diffGeneration++; cancelReads(); } },
    vscode.workspace.registerTextDocumentContentProvider('gitpeek-compare', { provideTextDocumentContent: async uri => {
      const text = contents.get(uri.toString());
      if (text !== undefined) return text;
      let value: { repoId?: string; root?: string; content?: CommitContentRef };
      try { value = JSON.parse(uri.query); } catch { throw new Error('GitPeek 比较内容 URI 无效。'); }
      if (!value || typeof value !== 'object') throw new Error('GitPeek 比较内容 URI 无效。');
      const repo = repositories.get(`${value.repoId}\0${value.root}`);
      if (!repo || !value.content || !/^[0-9a-f]{40,64}$/i.test(value.content.ref) || typeof value.content.file !== 'string') throw new Error('比较内容已过期，请重新打开。');
      return readCommitContent(git, repo, value.content);
    } }),
    vscode.commands.registerCommand('gitpeek.internal.compare.selectCompare', guarded(async item => {
      const target = targetOf(item); if (!target) return;
      cancelReads();
      const controller = query = new AbortController();
      const request = ++generation;
      diffGeneration++; activeComparison = undefined;
      try {
        const hash = await resolveCommit(git, target.repo, target.hash, controller.signal);
        const subject = (await git.run(target.repo, ['show', '-s', '--format=%s', hash, '--'], { signal: controller.signal })).trim() || '（无提交说明）';
        if (request !== generation || !enabled()) return;
        selected = { ...target, hash, subject };
        view.description = basename(target.repo.root);
        rows = [commitRow('起点', selected), new vscode.TreeItem('右键另一提交，选择“与所选提交比较”。')]; changed.fire();
        await vscode.commands.executeCommand('setContext', 'gitpeek.hasComparison', true);
        if (request === generation && enabled()) await vscode.commands.executeCommand('gitpeek.comparison.focus');
      } finally { if (query === controller) query = undefined; }
    })),
    vscode.commands.registerCommand('gitpeek.internal.compare.compareSelected', guarded(async item => {
      const target = targetOf(item); if (!target) return;
      if (!selected) { await vscode.window.showInformationMessage('请先右键一个提交并选择“选择此提交进行比较”。'); return; }
      if (selected.repo.id !== target.repo.id || selected.repo.root !== target.repo.root) throw new Error('不能比较不同仓库的提交，请重新选择起点。');
      const origin = selected;
      cancelReads();
      const controller = query = new AbortController();
      const request = ++generation;
      diffGeneration++; activeComparison = undefined;
      rows = [commitRow('起点', origin), new vscode.TreeItem('正在加载终点及变更…')]; changed.fire();
      try {
        const result = { ...await compareRevisions(git, target.repo, origin.hash, target.hash, controller.signal), generation: request };
        const [workspacePaths, subject] = await Promise.all([
          resolveWorkspacePaths(git, target.repo, result.right, result.files, controller.signal),
          git.run(target.repo, ['show', '-s', '--format=%s', result.right, '--'], { signal: controller.signal }),
        ]);
        if (request !== generation || !enabled()) return;
        activeComparison = result;
        rows = [commitRow('起点', origin), commitRow('终点', { repo: target.repo, hash: result.right, subject: subject.trim() || '（无提交说明）' }),
          Object.assign(new vscode.TreeItem(`${result.files.length} 个变更文件`), {
            description: `+${result.files.reduce((n, f) => n + (f.additions ?? 0), 0)} −${result.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}`,
          }),
          ...(!result.files.length ? [new vscode.TreeItem('两个提交的文件内容相同。')] : []),
          ...result.files.map(file => Object.assign(new vscode.TreeItem(`${file.status} ${file.path}`), {
            description: file.binary ? '二进制文件' : `+${file.additions ?? 0} −${file.deletions ?? 0}`,
            tooltip: `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}\n${result.left} → ${result.right}\n仓库：${target.repo.root}`,
            contextValue: 'gitpeek.comparisonFile', fileTarget: { repo: target.repo, path: workspacePaths.get(file.path) ?? file.path, workspacePathKnown: workspacePaths.has(file.path) },
            command: { command: 'gitpeek.internal.compare.openDiff', title: '打开差异', arguments: [result, file] },
          }))]; changed.fire();
        await vscode.commands.executeCommand('gitpeek.comparison.focus');
      } catch (error) {
        if (request !== generation || controller.signal.aborted) return;
        rows = [new vscode.TreeItem(`比较失败：${String(error)}`)]; changed.fire(); throw error;
      } finally { if (query === controller) query = undefined; }
    })),
    vscode.commands.registerCommand('gitpeek.internal.compare.clear', async () => {
      cancelReads();
      generation++; diffGeneration++; activeComparison = undefined; selected = undefined; view.description = undefined;
      rows = [new vscode.TreeItem('比较选择已清除。')]; changed.fire();
      await vscode.commands.executeCommand('setContext', 'gitpeek.hasComparison', false);
    }),
    vscode.commands.registerCommand('gitpeek.internal.compare.openDiff', async (result: typeof activeComparison, file: FileChange & { binary: boolean }) => {
      if (!enabled() || !result || result.generation !== activeComparison?.generation || result.repo.id !== activeComparison.repo.id || result.repo.root !== activeComparison.repo.root) return;
      const snapshot = activeComparison;
      const actual = snapshot.files.find(entry => entry.path === file?.path);
      if (!actual) return;
      diffQuery?.abort();
      const controller = diffQuery = new AbortController();
      const request = ++diffGeneration;
      try {
        const data = await revisionContents(git, snapshot.repo, snapshot.left, snapshot.right, actual, controller.signal);
        if (request !== diffGeneration || !enabled()) return;
        await showContents(snapshot.repo, data.before, data.after, actual.path, `${actual.path} (${snapshot.left.slice(0, 7)} → ${snapshot.right.slice(0, 7)})`, {
          before: { ref: snapshot.left, file: actual.oldPath ?? actual.path, side: 'before', empty: actual.status === 'A', binary: actual.binary },
          after: { ref: snapshot.right, file: actual.path, side: 'after', empty: actual.status === 'D', binary: actual.binary },
        });
      } catch (error) { if (!controller.signal.aborted && request === diffGeneration && enabled()) await vscode.window.showErrorMessage(`GitPeek：无法打开比较差异：${String(error)}`); }
      finally { if (diffQuery === controller) diffQuery = undefined; }
    }),
    vscode.commands.registerCommand('gitpeek.internal.compare.working', guarded(async item => {
      const target = targetOf(item); if (!target?.file) return;
      if ('workspacePathKnown' in target && target.workspacePathKnown === false) {
        await vscode.window.showInformationMessage('无法确认此历史文件对应的当前工作区路径，请从当前文件的历史列表发起比较。'); return;
      }
      diffQuery?.abort();
      const controller = diffQuery = new AbortController();
      const request = ++diffGeneration;
      try {
        const data = await workingContents(git, target, controller.signal);
        if (request !== diffGeneration || !enabled()) return;
        await showContents(target.repo, data.before, data.after, data.file, `${data.file} (${data.hash.slice(0, 7)} → ${data.source})${data.binary ? ' · 二进制文件' : ''}`);
      } finally { if (diffQuery === controller) diffQuery = undefined; }
    })),
    vscode.commands.registerCommand('gitpeek.internal.compare.stash', async (repo: Repository, entry: StashEntry, path: string, untracked = false) => {
      if (!enabled()) return;
      diffQuery?.abort();
      const controller = diffQuery = new AbortController();
      const request = ++diffGeneration;
      try {
        const preview = await previewStash({ run: (repository, args) => git.run(repository, args, { signal: controller.signal }) }, repo, entry);
        const file = preview.files.find(file => file.path === path && file.untracked === untracked);
        if (!file || request !== diffGeneration || !enabled()) return;
        const left = file.parent ?? file.ref;
        const data = await revisionContents(git, repo, left, file.ref, file, controller.signal);
        if (request !== diffGeneration || !enabled()) return;
        await showContents(repo, data.before, data.after, file.path,
          `${basename(repo.root)} · ${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} (${file.untracked ? '空文件' : left.slice(0, 7)} → ${entry.ref} ${entry.oid.slice(0, 7)}${file.untracked ? ' · 未跟踪快照' : ''})${file.binary ? ' · 二进制文件' : ''}`, {
            before: { ref: left, file: file.oldPath ?? file.path, side: 'before', empty: file.status === 'A', binary: file.binary },
            after: { ref: file.ref, file: file.path, side: 'after', empty: file.status === 'D', binary: file.binary },
          });
      } catch (error) { if (!controller.signal.aborted && request === diffGeneration && enabled()) await vscode.window.showErrorMessage(`GitPeek：无法预览 Stash 差异：${String(error)}`); }
      finally { if (diffQuery === controller) diffQuery = undefined; }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitpeek.enabled') && !enabled()) {
        cancelReads();
        generation++; diffGeneration++; activeComparison = undefined; selected = undefined; view.description = undefined;
        rows = []; changed.fire();
        void vscode.commands.executeCommand('setContext', 'gitpeek.hasComparison', false);
      }
    }),
  );
  if (view.onDidChangeVisibility) context.subscriptions.push(view.onDidChangeVisibility(event => {
    if (event.visible) return;
    generation++; diffGeneration++;
    const loading = Boolean(query);
    cancelReads();
    if (loading) { rows = [new vscode.TreeItem('比较加载已取消，请重新选择提交进行比较。')]; changed.fire(); }
  }));
}
