import * as vscode from 'vscode';
import { basename, relative } from 'node:path';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { parseFileHistory, parseLog } from '../git/GitParser';
import { toBlameLineRange, type BlameLineRange } from './selectionOrigins';
import { resolveCommit } from './revisionCompare';
import { mapSelectionSnapshot } from './selectionSnapshot';
import type { FileRevisionContext } from './fileRevisions';

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

export async function loadSelectionHistory(git: GitService, repo: Repository, file: string, range: BlameLineRange, limit = 50, snapshotHead?: string) {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) throw new Error('选区行号无效。');
  const head = snapshotHead ?? await resolveCommit(git, repo, 'HEAD');
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('提交引用无效。');
  const verify = async () => {
    if (!snapshotHead) return verifySelectionSnapshot(git, repo, file, head);
    if (await resolveCommit(git, repo, 'HEAD') !== head) throw new Error('HEAD 已变化，请重新选择代码范围。');
  };
  await verify();
  const format = '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x00';
  // ponytail: Git first-parent line tracking; cross-parent/copy tracking needs a separate mapping model.
  const [log, paths] = await Promise.all([
    git.run(repo, ['log', '--first-parent', '--no-patch', '-z', `--max-count=${limit + 1}`, format, '-L', `${range.startLine},${range.endLine}:${file}`, head], { timeoutMs: 10_000 }),
    git.run(repo, ['log', '--first-parent', '--follow', '--name-only', '-z', format, head, '--', `:(literal)${file}`], { timeoutMs: 10_000 }),
  ]);
  await verify();
  const historyPaths = new Map(parseFileHistory(paths).map(commit => [commit.hash, commit.filePath]));
  const all = parseLog(log);
  return { head, hasMore: all.length > limit, commits: all.slice(0, limit).map(commit => ({ ...commit, filePath: historyPaths.get(commit.hash) })) };
}

export function registerSelectionHistory(context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => Promise<void>,
  showDiff: (repo: Repository, hash: string, file: string, workspacePath?: string, history?: Pick<FileRevisionContext, 'historyHead' | 'historyFile'>) => Promise<void>): void {
  let generation = 0;
  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.selectionHistory', async () => {
    const request = ++generation;
    const editor = vscode.window.activeTextEditor;
    if (!vscode.workspace.getConfiguration('gitpeek').get('enabled', true)) return;
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') {
      await vscode.window.showInformationMessage('请在仓库文件中选中代码以追踪历史。'); return;
    }
    const document = editor.document, selection = editor.selection, version = document.version;
    const text = document.getText();
    const range = toBlameLineRange(selection.start, selection.end);
    const current = () => request === generation && vscode.workspace.getConfiguration('gitpeek').get('enabled', true)
      && vscode.window.activeTextEditor === editor && document.version === version && document.getText() === text
      && editor.selection.start.line === selection.start.line && editor.selection.start.character === selection.start.character
      && editor.selection.end.line === selection.end.line && editor.selection.end.character === selection.end.character;
    try {
      const repo = await repositories.forUri(document.uri); if (!current()) return;
      if (!repo) { await vscode.window.showInformationMessage('此文件不属于 Git 仓库。'); return; }
      const file = relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
      const snapshot = await mapSelectionSnapshot(git, repo, file, text, range); if (!current()) return;
      if (!snapshot.head || !snapshot.ranges.length) {
        await vscode.window.showInformationMessage('所选代码为新增或改写内容，未找到可对应到 HEAD 的未修改行。'); return;
      }
      let mapped = snapshot.ranges[0];
      if (snapshot.ranges.length !== 1 || mapped.current.startLine !== range.startLine || mapped.current.endLine !== range.endLine) {
        const selected = await vscode.window.showQuickPick(snapshot.ranges.map(span => ({
          label: `当前 ${span.current.startLine}–${span.current.endLine} 行`,
          description: `对应 HEAD ${span.committed.startLine}–${span.committed.endLine} 行`, span,
        })), { title: '选区包含未提交内容或不连续的历史范围', placeHolder: '新增或改写行不追溯；选择一段未修改代码查看历史' });
        if (!selected || !current()) return;
        mapped = selected.span;
      }
      let limit = 50;
      while (current()) {
        const result = await loadSelectionHistory(git, repo, snapshot.file, mapped.committed, limit, snapshot.head); if (!current()) return;
        if (!result.commits.length) { await vscode.window.showInformationMessage('未找到可追踪的选区历史。'); return; }
        const items = result.commits.map(commit => ({ label: `${commit.shortHash} ${commit.subject}`, description: `${commit.author} · ${new Date(commit.date).toLocaleDateString('zh-CN')}`, detail: commit.filePath ?? '历史路径无法确认，选择后查看提交详情', hash: commit.hash, filePath: commit.filePath }));
        if (result.hasMore) items.push({ label: '加载更多…', description: '', detail: '', hash: '', filePath: undefined });
        const selected = await vscode.window.showQuickPick(items, { title: `${basename(repo.root)} · ${file} · ${mapped.current.startLine}–${mapped.current.endLine} 行 · HEAD ${mapped.committed.startLine}–${mapped.committed.endLine} · ${result.head.slice(0, 7)}`, placeHolder: '沿首父链追踪；选择提交直接查看此文件差异，历史路径不明时查看详情' });
        if (!selected || !current()) return;
        if (await resolveCommit(git, repo, 'HEAD') !== result.head) throw new Error('HEAD 已变化，请重新选择代码范围。');
        if (!current()) return;
        if (!selected.hash) { limit += 50; continue; }
        if (selected.filePath) await showDiff(repo, selected.hash, selected.filePath, file, { historyHead: result.head, historyFile: snapshot.file });
        else await showCommit(repo, selected.hash);
        return;
      }
    } catch (error) { if (current()) await vscode.window.showErrorMessage(`GitPeek：无法追踪选区历史：${String(error)}`); }
  }));
}
