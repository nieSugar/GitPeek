import * as vscode from 'vscode';
import { relative } from 'node:path';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { parseFileHistory, parseLog } from '../git/GitParser';
import { toBlameLineRange, type BlameLineRange } from './selectionOrigins';
import { resolveCommit } from './revisionCompare';

async function verifySelectionSnapshot(git: GitService, repo: Repository, file: string, head: string): Promise<void> {
  const [currentHead, status, diskBlob, headBlob] = await Promise.all([
    resolveCommit(git, repo, 'HEAD'),
    git.run(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', `:(literal)${file}`]),
    git.run(repo, ['hash-object', `--path=${file}`, '--', file]),
    git.run(repo, ['rev-parse', '--verify', `${head}:${file}`]),
  ]);
  if (currentHead !== head) throw new Error('HEAD 已变化，请重新选择代码范围。');
  if (status || diskBlob.trim() !== headBlob.trim()) throw new Error('此文件存在未提交修改，请先提交或还原后再追踪选区历史。');
}

export async function loadSelectionHistory(git: GitService, repo: Repository, file: string, range: BlameLineRange, limit = 50) {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) throw new Error('选区行号无效。');
  const head = await resolveCommit(git, repo, 'HEAD');
  await verifySelectionSnapshot(git, repo, file, head);
  const format = '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x00';
  // ponytail: Git first-parent line tracking; cross-parent/copy tracking needs a separate mapping model.
  const [log, paths] = await Promise.all([
    git.run(repo, ['log', '--first-parent', '--no-patch', '-z', `--max-count=${limit + 1}`, format, '-L', `${range.startLine},${range.endLine}:${file}`, head], { timeoutMs: 10_000 }),
    git.run(repo, ['log', '--first-parent', '--follow', '--name-only', '-z', format, head, '--', `:(literal)${file}`], { timeoutMs: 10_000 }),
  ]);
  await verifySelectionSnapshot(git, repo, file, head);
  const historyPaths = new Map(parseFileHistory(paths).map(commit => [commit.hash, commit.filePath]));
  const all = parseLog(log);
  return { head, hasMore: all.length > limit, commits: all.slice(0, limit).map(commit => ({ ...commit, filePath: historyPaths.get(commit.hash) })) };
}

export function registerSelectionHistory(context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => Promise<void>): void {
  let generation = 0;
  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.selectionHistory', async () => {
    const request = ++generation;
    const editor = vscode.window.activeTextEditor;
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') {
      await vscode.window.showInformationMessage('请在仓库文件中选中代码以追踪历史。'); return;
    }
    const document = editor.document, selection = editor.selection, version = document.version;
    if (document.isDirty) { await vscode.window.showWarningMessage('请先保存文件再追踪选区历史。'); return; }
    const range = toBlameLineRange(selection.start, selection.end);
    const current = () => request === generation && vscode.workspace.getConfiguration('gitpeek').get('enabled', true)
      && vscode.window.activeTextEditor === editor && document.version === version && !document.isDirty
      && editor.selection.start.line === selection.start.line && editor.selection.start.character === selection.start.character
      && editor.selection.end.line === selection.end.line && editor.selection.end.character === selection.end.character;
    try {
      const repo = await repositories.forUri(document.uri); if (!current()) return;
      if (!repo) { await vscode.window.showInformationMessage('此文件不属于 Git 仓库。'); return; }
      const file = relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
      let limit = 50;
      let initialHead: string | undefined;
      while (current()) {
        const result = await loadSelectionHistory(git, repo, file, range, limit); if (!current()) return;
        if (initialHead && result.head !== initialHead) throw new Error('HEAD 已变化，请重新选择代码范围。');
        initialHead = result.head;
        if (!result.commits.length) { await vscode.window.showInformationMessage('未找到可追踪的选区历史。'); return; }
        const items = result.commits.map(commit => ({ label: `${commit.shortHash} ${commit.subject}`, description: `${commit.author} · ${new Date(commit.date).toLocaleDateString('zh-CN')}`, detail: commit.filePath ?? '历史路径由提交详情确认', hash: commit.hash }));
        if (result.hasMore) items.push({ label: '加载更多…', description: '', detail: '', hash: '' });
        const selected = await vscode.window.showQuickPick(items, { title: `选区历史 · ${range.startLine}–${range.endLine} 行 · 首父提交链`, placeHolder: '沿 Git 首父历史追踪；复制／复杂重命名可能中断，选择提交查看详情' });
        if (!selected || !current()) return;
        await verifySelectionSnapshot(git, repo, file, result.head); if (!current()) return;
        if (!selected.hash) { limit += 50; continue; }
        await showCommit(repo, selected.hash); return;
      }
    } catch (error) { if (current()) await vscode.window.showErrorMessage(`GitPeek：无法追踪选区历史：${String(error)}`); }
  }));
}
