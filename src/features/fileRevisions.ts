import { posix, win32 } from 'node:path';
import { parseFileHistory } from '../git/GitParser';
import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';

export interface FileRevisionContext {
  historyHead: string;
  historyFile: string;
  currentCommit: string;
  currentFile: string;
}

export function validRevisionContext(value: unknown): value is FileRevisionContext {
  if (!value || typeof value !== 'object') return false;
  const ref = value as FileRevisionContext;
  return validHash(ref.historyHead) && validHash(ref.currentCommit) && validFile(ref.historyFile) && validFile(ref.currentFile);
}

export function validFile(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value) && !value.includes('\0') && !posix.isAbsolute(value)
    && !win32.isAbsolute(value) && !value.split(/[\\/]/).some(part => part === '.' || part === '..');
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

export async function adjacentFileRevision(git: GitService, repo: Repository, context: FileRevisionContext, direction: -1 | 1, signal?: AbortSignal) {
  if (!validRevisionContext(context)) throw new Error('文件历史上下文无效，请重新打开差异。');
  const { historyHead, historyFile, currentCommit, currentFile } = context;
  context = { historyHead, historyFile, currentCommit, currentFile };
  const load = async (head: string, file: string) => parseFileHistory(await git.run(repo, [
    'log', '--follow', '--first-parent', '--diff-merges=first-parent', '--name-only', '-z', '--date=iso-strict',
    '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x00', head, '--', `:(literal)${file}`,
  ], { signal }));
  let commits = await load(context.historyHead, context.historyFile);
  let index = commits.findIndex(commit => commit.hash === context.currentCommit && commit.filePath === context.currentFile);
  // A selected side-branch commit or a reused path starts its own immutable history.
  if (index < 0 && (context.historyHead !== context.currentCommit || context.historyFile !== context.currentFile)) {
    context = { ...context, historyHead: context.currentCommit, historyFile: context.currentFile };
    commits = await load(context.historyHead, context.historyFile);
    index = commits.findIndex(commit => commit.hash === context.currentCommit && commit.filePath === context.currentFile);
  }
  if (index < 0) throw new Error('无法在此文件的历史中定位当前提交，请重新打开差异。');
  const commit = commits[index + direction];
  return { context, commit };
}
