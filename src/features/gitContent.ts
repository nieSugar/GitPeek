import { parseNameStatus, parseNumStat } from '../git/GitParser';
import type { GitService } from '../git/GitService';
import type { CommitDetail, FileChange, Repository } from '../git/types';

export interface CommitDiffContents {
  commit: CommitDetail;
  file: FileChange;
  parent?: string;
  oldContent: string;
  newContent: string;
  binary: boolean;
}

export interface CommitContentRef {
  ref: string;
  file: string;
  empty?: boolean;
  binary?: boolean;
  side?: 'before' | 'after';
}

export async function readCommitContent(git: GitService, repo: Repository, ref: CommitContentRef): Promise<string> {
  if (ref.empty) return '';
  if (ref.binary) return binaryLabel(ref.file, ref.side ?? 'requested');
  return git.run(repo, ['show', `${ref.ref}:${ref.file}`]);
}

export async function loadCommitDetail(git: GitService, repo: Repository, ref: string): Promise<CommitDetail> {
  const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error(`Invalid commit hash returned for ${ref}`);
  const detail = await git.commit(repo, hash);
  const [parentsLine] = (await git.run(repo, ['rev-list', '--parents', '-n', '1', hash])).trim().split('\n');
  const [, firstParent] = (parentsLine ?? '').split(' ');
  if (!firstParent) return { ...detail, hash };

  const [names, stats] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', firstParent, hash, '--']),
    git.run(repo, ['diff', '--numstat', '-z', '-M', firstParent, hash, '--']),
  ]);
  const numstats = parseNumStat(stats);
  const files = parseNameStatus(names).map((file) => ({ ...file, ...(numstats.get(file.path) ?? {}) }));
  return {
    ...detail,
    hash,
    files,
    additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
    deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
  };
}

export async function loadCommitDiffContents(
  git: GitService,
  repo: Repository,
  commit: CommitDetail,
  filePath: string,
): Promise<CommitDiffContents> {
  const file = commit.files.find((item) => item.path === filePath || item.oldPath === filePath);
  if (!file) throw new Error(`File is not part of commit ${commit.hash}: ${filePath}`);
  const [parentsLine] = (await git.run(repo, ['rev-list', '--parents', '-n', '1', commit.hash])).trim().split('\n');
  const [, parent] = (parentsLine ?? '').split(' ');
  const stats = parent
    ? await git.run(repo, ['diff', '--numstat', '-z', '-M', parent, commit.hash, '--', ...literalPaths(file)])
    : await git.run(repo, ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '-M', commit.hash, '--', `:(literal)${file.path}`]);
  const binary = isBinaryNumstat(stats, file.path);
  const beforePath = file.status === 'R' ? file.oldPath : file.path;
  const isAdded = file.status === 'A';
  const isDeleted = file.status === 'D';
  const oldContent = isAdded ? '' : binary ? binaryLabel(file.oldPath ?? file.path, 'before') : await git.run(repo, ['show', `${parent}:${beforePath}`]);
  const newContent = isDeleted ? '' : binary ? binaryLabel(file.path, 'after') : await git.run(repo, ['show', `${commit.hash}:${file.path}`]);
  return { commit, file, parent, oldContent, newContent, binary };
}

function literalPaths(file: FileChange): string[] {
  return (file.oldPath ? [file.oldPath, file.path] : [file.path]).map((path) => `:(literal)${path}`);
}

function isBinaryNumstat(output: string, filePath: string): boolean {
  const fields = output.split('\0');
  for (let i = 0; i < fields.length;) {
    const record = fields[i++];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0 || record.slice(0, firstTab) !== '-' || record.slice(firstTab + 1, secondTab) !== '-') continue;
    const path = record.slice(secondTab + 1);
    if (path === filePath) return true;
    if (!path) {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      if (oldPath === filePath || newPath === filePath) return true;
    }
  }
  return false;
}

function binaryLabel(path: string, side: string): string {
  return `[Binary file ${side}: ${path}; GitPeek displays binary changes as metadata.]\n`;
}
