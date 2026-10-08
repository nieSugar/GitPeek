import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseNameStatus, parseNumStat } from '../git/GitParser';
import type { GitService } from '../git/GitService';
import type { CommitTarget, FileChange, Repository } from '../git/types';
import { isBinaryNumstat, readCommitContent, resolveWorkspacePaths, type CommitContentRef } from './gitContent';
import { samePath } from './smartCommit';

export async function resolveCommit(git: GitService, repo: Repository, ref: string): Promise<string> {
  const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error('提交引用无效。');
  return hash;
}

export async function compareRevisions(git: GitService, repo: Repository, from: string, to: string) {
  const [left, right] = await Promise.all([resolveCommit(git, repo, from), resolveCommit(git, repo, to)]);
  const [names, stats] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', left, right, '--']),
    git.run(repo, ['diff', '--numstat', '-z', '-M', left, right, '--']),
  ]);
  const counts = parseNumStat(stats);
  const files = parseNameStatus(names).map(file => ({ ...file, ...counts.get(file.path), binary: isBinaryNumstat(stats, file.path) }));
  return { repo, left, right, files };
}

export async function revisionContents(git: GitService, repo: Repository, left: string, right: string, file: FileChange & { binary: boolean }) {
  const oldPath = file.oldPath ?? file.path;
  const before = await readCommitContent(git, repo, { ref: left, file: oldPath, side: 'before', empty: file.status === 'A', binary: file.binary });
  const after = await readCommitContent(git, repo, { ref: right, file: file.path, side: 'after', empty: file.status === 'D', binary: file.binary });
  return { before, after };
}

export async function workingContents(git: GitService, target: CommitTarget) {
  if (!target.file) throw new Error('请选择一个历史文件。');
  const file = target.workspacePath ?? target.file;
  const diskPath = resolve(target.repo.root, file);
  const rel = relative(target.repo.root, diskPath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件路径不在仓库中。');
  const hash = await resolveCommit(git, target.repo, target.hash);
  const exists = await git.run(target.repo, ['ls-tree', '-z', hash, '--', `:(literal)${target.file}`]);
  const before = exists ? await git.run(target.repo, ['show', `${hash}:${target.file}`]) : '';
  let bytes: Buffer;
  try { bytes = await readFile(diskPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
  const binary = before.includes('\0') || bytes.includes(0);
  return { hash, file, before: binary && exists ? `[二进制文件（提交 ${hash.slice(0, 7)}）：${target.file}]\n` : before,
    after: binary && bytes.length ? `[二进制文件（工作区磁盘）：${file}]\n` : bytes.toString('utf8') };
}

export function registerRevisionCompare(context: vscode.ExtensionContext, git: GitService): void {
  let selected: CommitTarget | undefined;
  let generation = 0;
  let diffGeneration = 0;
  let activeComparison: (Awaited<ReturnType<typeof compareRevisions>> & { generation: number }) | undefined;
  let serial = 0;
  let rows: vscode.TreeItem[] = [new vscode.TreeItem('右键提交，选择两个提交进行比较。')];
  const changed = new vscode.EventEmitter<void>();
  const contents = new Map<string, string>();
  const repositories = new Map<string, Repository>();
  const enabled = () => vscode.workspace.getConfiguration('gitpeek').get('enabled', true);
  const targetOf = (item?: { commitTarget?: CommitTarget }) => item?.commitTarget;
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
    try { await action(item); } catch (error) { if (enabled()) await vscode.window.showErrorMessage(`GitPeek：比较失败：${String(error)}`); }
  };
  context.subscriptions.push(changed,
    vscode.window.createTreeView('gitpeek.comparison', { treeDataProvider: { onDidChangeTreeData: changed.event, getTreeItem: (item: vscode.TreeItem) => item, getChildren: () => rows } }),
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
      const request = ++generation;
      diffGeneration++; activeComparison = undefined;
      const hash = await resolveCommit(git, target.repo, target.hash);
      if (request !== generation || !enabled()) return;
      selected = { ...target, hash };
      rows = [new vscode.TreeItem(`${target.repo.root} · 已选择 ${hash.slice(0, 7)}，请右键另一提交进行比较。`)]; changed.fire();
      await vscode.commands.executeCommand('gitpeek.comparison.focus');
    })),
    vscode.commands.registerCommand('gitpeek.internal.compare.compareSelected', guarded(async item => {
      const target = targetOf(item); if (!target) return;
      if (!selected) { await vscode.window.showInformationMessage('请先右键一个提交并选择“选择此提交进行比较”。'); return; }
      if (selected.repo.id !== target.repo.id) throw new Error('不能比较不同仓库的提交，请重新选择起点。');
      const request = ++generation;
      diffGeneration++; activeComparison = undefined;
      rows = [new vscode.TreeItem('正在比较两个提交…')]; changed.fire();
      try {
        const result = { ...await compareRevisions(git, target.repo, selected.hash, target.hash), generation: request };
        const workspacePaths = await resolveWorkspacePaths(git, target.repo, result.right, result.files);
        if (request !== generation || !enabled()) return;
        activeComparison = result;
        const title = `${result.left.slice(0, 7)} → ${result.right.slice(0, 7)}`;
        rows = [new vscode.TreeItem(`${target.repo.root} · ${title}`),
          new vscode.TreeItem(`${result.files.length} 个文件 · +${result.files.reduce((n, f) => n + (f.additions ?? 0), 0)} −${result.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}`),
          ...result.files.map(file => Object.assign(new vscode.TreeItem(`${file.status} ${file.path}`), {
            description: file.binary ? '二进制文件' : `+${file.additions ?? 0} −${file.deletions ?? 0}`,
            contextValue: 'gitpeek.comparisonFile', fileTarget: { repo: target.repo, path: workspacePaths.get(file.path) ?? file.path, workspacePathKnown: workspacePaths.has(file.path) },
            command: { command: 'gitpeek.internal.compare.openDiff', title: '打开差异', arguments: [result, file] },
          }))]; changed.fire();
        await vscode.commands.executeCommand('gitpeek.comparison.focus');
      } catch (error) {
        if (request !== generation) return;
        rows = [new vscode.TreeItem(`比较失败：${String(error)}`)]; changed.fire(); throw error;
      }
    })),
    vscode.commands.registerCommand('gitpeek.internal.compare.clear', () => {
      generation++; diffGeneration++; activeComparison = undefined; selected = undefined; rows = [new vscode.TreeItem('比较选择已清除。')]; changed.fire();
    }),
    vscode.commands.registerCommand('gitpeek.internal.compare.openDiff', async (result: typeof activeComparison, file: FileChange & { binary: boolean }) => {
      if (!enabled() || !result || result.generation !== activeComparison?.generation || result.repo.id !== activeComparison.repo.id || result.repo.root !== activeComparison.repo.root) return;
      const snapshot = activeComparison;
      const actual = snapshot.files.find(entry => entry.path === file?.path);
      if (!actual) return;
      const request = ++diffGeneration;
      try {
        const data = await revisionContents(git, snapshot.repo, snapshot.left, snapshot.right, actual);
        if (request !== diffGeneration || !enabled()) return;
        await showContents(snapshot.repo, data.before, data.after, actual.path, `${actual.path} (${snapshot.left.slice(0, 7)} → ${snapshot.right.slice(0, 7)})`, {
          before: { ref: snapshot.left, file: actual.oldPath ?? actual.path, side: 'before', empty: actual.status === 'A', binary: actual.binary },
          after: { ref: snapshot.right, file: actual.path, side: 'after', empty: actual.status === 'D', binary: actual.binary },
        });
      } catch (error) { if (request === diffGeneration && enabled()) await vscode.window.showErrorMessage(`GitPeek：无法打开比较差异：${String(error)}`); }
    }),
    vscode.commands.registerCommand('gitpeek.internal.compare.working', guarded(async item => {
      const target = targetOf(item); if (!target?.file) return;
      if ('workspacePathKnown' in target && target.workspacePathKnown === false) {
        await vscode.window.showInformationMessage('无法确认此历史文件对应的当前工作区路径，请从当前文件的历史列表发起比较。'); return;
      }
      const request = ++diffGeneration;
      const path = resolve(target.repo.root, target.workspacePath ?? target.file);
      const hasUnsaved = () => vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && doc.isDirty && samePath(doc.uri.fsPath, path));
      if (hasUnsaved()) {
        await vscode.window.showWarningMessage('工作区文件有未保存修改，请先保存；此比较使用磁盘内容。'); return;
      }
      const data = await workingContents(git, target);
      if (request !== diffGeneration || !enabled()) return;
      if (hasUnsaved()) { await vscode.window.showWarningMessage('工作区文件有未保存修改，请先保存；此比较使用磁盘内容。'); return; }
      await showContents(target.repo, data.before, data.after, data.file, `${data.file} (${data.hash.slice(0, 7)} → 工作区磁盘)`);
    })),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitpeek.enabled') && !enabled()) { generation++; diffGeneration++; activeComparison = undefined; selected = undefined; rows = []; changed.fire(); }
    }),
  );
}
