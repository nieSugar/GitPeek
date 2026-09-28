import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { BlameInfo, Repository } from '../git/types';

export interface BlameLineRange {
  startLine: number;
  endLine: number;
}

export interface SelectionOrigin {
  hash?: string;
  shortHash?: string;
  author: string;
  authorTime: number;
  summary: string;
  lineCount: number;
  uncommitted: boolean;
}

export function toBlameLineRange(
  start: { line: number; character: number },
  end: { line: number; character: number },
): BlameLineRange {
  const startLine = start.line + 1;
  const inclusiveEnd = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
  return { startLine, endLine: Math.max(startLine, inclusiveEnd + 1) };
}

export function aggregateOrigins(blame: readonly BlameInfo[]): SelectionOrigin[] {
  const groups = new Map<string, SelectionOrigin>();
  for (const line of blame) {
    const uncommitted = /^0+$/.test(line.hash) || line.author === 'Not Committed Yet';
    const key = uncommitted ? 'uncommitted' : line.hash;
    const existing = groups.get(key);
    if (existing) {
      existing.lineCount++;
      continue;
    }
    groups.set(key, {
      ...(uncommitted ? {} : { hash: line.hash, shortHash: line.hash.slice(0, 7) }),
      author: uncommitted ? '你' : line.author,
      authorTime: line.authorTime,
      summary: uncommitted ? '未提交的更改' : line.summary,
      lineCount: 1,
      uncommitted,
    });
  }
  return [...groups.values()];
}

export async function loadSelectionOrigins(
  git: GitService,
  repo: Repository,
  file: string,
  range: BlameLineRange,
): Promise<{ head?: string; origins: SelectionOrigin[] } | undefined> {
  const head = await readHead(git, repo);
  let origins: SelectionOrigin[];
  if (!head) {
    origins = [uncommittedOrigin(range.endLine - range.startLine + 1)];
  } else {
    try {
      origins = aggregateOrigins(await git.blame(repo, file, range.startLine, range.endLine));
    } catch (error) {
      if (!isMissingPathInHead(error) || !await isPendingFile(git, repo, file)) throw error;
      origins = [uncommittedOrigin(range.endLine - range.startLine + 1)];
    }
  }
  if (await readHead(git, repo) !== head) return undefined;
  return { head, origins };
}

async function readHead(git: GitService, repo: Repository): Promise<string | undefined> {
  try {
    const head = (await git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
    return head || undefined;
  } catch (error) {
    if (isMissingHead(error)) return undefined;
    throw error;
  }
}

async function isPendingFile(git: GitService, repo: Repository, file: string): Promise<boolean> {
  const status = await git.run(repo, ['status', '--porcelain=v1', '-z', '--', file]);
  return status.split('\0').some((record) => record.startsWith('?? ') || record[0] === 'A');
}

function isMissingHead(error: unknown): boolean {
  return error instanceof Error && /needed a single revision|unknown revision|ambiguous argument ['"]?HEAD/i.test(error.message);
}

function isMissingPathInHead(error: unknown): boolean {
  return error instanceof Error && /no such path|path .* does not exist/i.test(error.message);
}

function uncommittedOrigin(lineCount: number): SelectionOrigin {
  return { author: '你', authorTime: Math.floor(Date.now() / 1000), summary: '未提交的更改', lineCount, uncommitted: true };
}

export async function registerSelectionOrigins(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => void | Promise<void>,
): Promise<vscode.Disposable> {
  const vscode = await import('vscode');
  let generation = 0;
  const enabled = (uri?: vscode.Uri) => vscode.workspace.getConfiguration('gitpeek', uri).get<boolean>('enabled', true);
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('gitpeek.enabled')) generation++;
  });
  const command = vscode.commands.registerCommand('gitpeek.selectionOrigins', async () => {
    if (!enabled()) {
      void vscode.window.showInformationMessage('GitPeek：请在设置中启用扩展后再分析选中代码来源。');
      return;
    }
    const request = ++generation;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('GitPeek：请先在已打开的文件中选中代码。');
      return;
    }
    const document = editor.document;
    if (document.isDirty) {
      void vscode.window.showWarningMessage('GitPeek：请先保存文件，再分析选中代码来源。');
      return;
    }
    if (document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('GitPeek：仅支持分析 Git 仓库中的文件。');
      return;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      void vscode.window.showInformationMessage('GitPeek：请先选中一行或多行代码。');
      return;
    }

    const version = document.version;
    const isCurrent = () => request === generation && enabled(document.uri) && vscode.window.activeTextEditor === editor && document.version === version && !document.isDirty
      && editor.selection.start.line === selection.start.line && editor.selection.start.character === selection.start.character
      && editor.selection.end.line === selection.end.line && editor.selection.end.character === selection.end.character;
    const repo = await repositories.forUri(document.uri);
    if (!repo || !isCurrent()) {
      if (!repo) void vscode.window.showInformationMessage('GitPeek：此文件不属于任何 Git 仓库。');
      return;
    }
    const range = toBlameLineRange(selection.start, selection.end);
    const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
    let result: Awaited<ReturnType<typeof loadSelectionOrigins>>;
    try {
      result = await loadSelectionOrigins(git, repo, file, range);
    } catch (error) {
      if (isCurrent()) void vscode.window.showErrorMessage(`GitPeek：无法分析选中代码来源：${String(error)}`);
      return;
    }
    if (!result || !isCurrent()) return;

    const { head, origins } = result;
    if (!origins.length) {
      void vscode.window.showInformationMessage('GitPeek：未找到所选代码行的提交来源。');
      return;
    }
    const choices = origins.map((origin) => ({
      label: origin.uncommitted ? `$(circle-slash) ${origin.summary}` : `$(git-commit) ${origin.shortHash}  ${origin.summary}`,
      description: `${origin.author}${origin.uncommitted ? '' : ` · ${new Date(origin.authorTime * 1000).toLocaleDateString('zh-CN')}`} · ${origin.lineCount} 行`,
      origin,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      title: `代码来源 · 第 ${range.startLine}–${range.endLine} 行`,
      placeHolder: '选择一个提交以查看详情',
    });
    if (isCurrent() && selected?.origin.hash && !selected.origin.uncommitted) {
      try {
        if (await readHead(git, repo) === head && isCurrent()) {
          await showCommit(repo, selected.origin.hash);
        }
      } catch { /* A changed or unavailable HEAD makes the selected origin stale. */ }
    }
  });
  const disposable = vscode.Disposable.from(command, configuration);
  context.subscriptions.push(disposable);
  return disposable;
}
