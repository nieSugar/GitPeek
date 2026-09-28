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
      author: uncommitted ? 'You' : line.author,
      authorTime: line.authorTime,
      summary: uncommitted ? 'Uncommitted changes' : line.summary,
      lineCount: 1,
      uncommitted,
    });
  }
  return [...groups.values()];
}

export async function registerSelectionOrigins(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => void | Promise<void>,
): Promise<vscode.Disposable> {
  const vscode = await import('vscode');
  const command = vscode.commands.registerCommand('gitpeek.selectionOrigins', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('GitPeek: Select code in an open file first.');
      return;
    }
    const document = editor.document;
    if (document.isDirty) {
      void vscode.window.showWarningMessage('GitPeek: Save the file before analyzing selection origins.');
      return;
    }
    if (document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('GitPeek: Selection origins are available for files inside a Git repository.');
      return;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      void vscode.window.showInformationMessage('GitPeek: Select one or more lines first.');
      return;
    }

    const version = document.version;
    const isCurrent = () => vscode.window.activeTextEditor === editor && document.version === version && !document.isDirty
      && editor.selection.start.line === selection.start.line && editor.selection.start.character === selection.start.character
      && editor.selection.end.line === selection.end.line && editor.selection.end.character === selection.end.character;
    const repo = await repositories.forUri(document.uri);
    if (!repo || !isCurrent()) {
      if (!repo) void vscode.window.showInformationMessage('GitPeek: This file is not inside a Git repository.');
      return;
    }
    const range = toBlameLineRange(selection.start, selection.end);
    const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
    let blame: BlameInfo[];
    try {
      blame = await git.blame(repo, file, range.startLine, range.endLine);
    } catch (error) {
      if (isCurrent()) void vscode.window.showErrorMessage(`GitPeek: Could not analyze selection origins: ${String(error)}`);
      return;
    }
    if (!isCurrent()) return;

    const origins = aggregateOrigins(blame);
    if (!origins.length) {
      void vscode.window.showInformationMessage('GitPeek: No line origins were found for this selection.');
      return;
    }
    const choices = origins.map((origin) => ({
      label: origin.uncommitted ? `$(circle-slash) ${origin.summary}` : `$(git-commit) ${origin.shortHash}  ${origin.summary}`,
      description: `${origin.author}${origin.uncommitted ? '' : ` · ${new Date(origin.authorTime * 1000).toLocaleDateString()}`} · ${origin.lineCount} ${origin.lineCount === 1 ? 'line' : 'lines'}`,
      origin,
    }));
    const selected = await vscode.window.showQuickPick(choices, {
      title: `Selection Origins · Lines ${range.startLine}–${range.endLine}`,
      placeHolder: 'Choose a commit to inspect',
    });
    if (selected?.origin.hash && !selected.origin.uncommitted) await showCommit(repo, selected.origin.hash);
  });
  context.subscriptions.push(command);
  return command;
}
