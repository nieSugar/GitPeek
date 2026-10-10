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

export async function readCommitContent(git: GitService, repo: Repository, ref: CommitContentRef, signal?: AbortSignal): Promise<string> {
  if (ref.empty) return '';
  if (ref.binary) return binaryLabel(ref.file, ref.side ?? 'requested', ref.ref);
  return git.run(repo, ['show', `${ref.ref}:${ref.file}`], { signal });
}

export async function loadCommitDetail(git: GitService, repo: Repository, ref: string, signal?: AbortSignal): Promise<CommitDetail> {
  const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal })).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error(`Git 返回了无效的提交哈希：${ref}`);
  const detail = await git.commit(repo, hash, signal);
  const [parentsLine] = (await git.run(repo, ['rev-list', '--parents', '-n', '1', hash], { signal })).trim().split('\n');
  const [, firstParent] = (parentsLine ?? '').split(' ');
  if (!firstParent) return { ...detail, hash };

  const [names, stats] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', firstParent, hash, '--'], { signal }),
    git.run(repo, ['diff', '--numstat', '-z', '-M', firstParent, hash, '--'], { signal }),
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

export async function resolveWorkspacePaths(git: GitService, repo: Repository, hash: string, files: readonly FileChange[], signal?: AbortSignal): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  try {
    const head = (await git.run(repo, ['rev-parse', '--verify', 'HEAD'], { signal })).trim();
    const chain = (await git.run(repo, ['rev-list', '--first-parent', head], { signal })).trim().split('\n');
    if (!chain.includes(hash)) return paths;
    const initial = new Set((await git.run(repo, ['ls-tree', '-r', '--name-only', '-z', hash], { signal })).split('\0'));
    for (const file of files) if (initial.has(file.path)) paths.set(file.path, file.path);
    if (head !== hash) {
      const changes = await git.run(repo, ['log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--format=%x00%x00', '--name-status', '-z', '-M', `${hash}..${head}`, '--'], { signal });
      // NUL-delimited commit boundaries keep simultaneous renames from being followed twice.
      for (const record of changes.split('\0\0\0')) {
        const changesInCommit = parseNameStatus(record.replace(/^[\0\n]+/, ''));
        for (const [original, current] of paths) {
          const change = changesInCommit.find(file => (file.status === 'R' ? file.oldPath : file.path) === current);
          if (change?.status === 'R') paths.set(original, change.path);
          else if (change?.status === 'D') paths.delete(original);
        }
      }
    }
    const current = new Set((await git.run(repo, ['ls-tree', '-r', '--name-only', '-z', head], { signal })).split('\0'));
    for (const [original, path] of paths) if (!current.has(path)) paths.delete(original);
    return paths;
  } catch (error) {
    if (signal?.aborted) throw error;
    return new Map(); // A mapping that cannot be verified must not open a reused historical name.
  }
}

export async function loadCommitDiffContents(
  git: GitService,
  repo: Repository,
  commit: CommitDetail,
  filePath: string,
  signal?: AbortSignal,
): Promise<CommitDiffContents> {
  const file = commit.files.find((item) => item.path === filePath || item.oldPath === filePath);
  if (!file) throw new Error(`文件不属于提交 ${commit.hash}：${filePath}`);
  const [parentsLine] = (await git.run(repo, ['rev-list', '--parents', '-n', '1', commit.hash], { signal })).trim().split('\n');
  const [, parent] = (parentsLine ?? '').split(' ');
  const stats = parent
    ? await git.run(repo, ['diff', '--numstat', '-z', '-M', parent, commit.hash, '--', ...literalPaths(file)], { signal })
    : await git.run(repo, ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', '-z', '-M', commit.hash, '--', `:(literal)${file.path}`], { signal });
  const binary = isBinaryNumstat(stats, file.path);
  const beforePath = file.status === 'R' ? file.oldPath : file.path;
  const isAdded = file.status === 'A';
  const isDeleted = file.status === 'D';
  const oldContent = isAdded ? '' : binary ? binaryLabel(file.oldPath ?? file.path, 'before', parent) : await git.run(repo, ['show', `${parent}:${beforePath}`], { signal });
  const newContent = isDeleted ? '' : binary ? binaryLabel(file.path, 'after', commit.hash) : await git.run(repo, ['show', `${commit.hash}:${file.path}`], { signal });
  return { commit, file, parent, oldContent, newContent, binary };
}

function literalPaths(file: FileChange): string[] {
  return (file.oldPath ? [file.oldPath, file.path] : [file.path]).map((path) => `:(literal)${path}`);
}

export function isBinaryNumstat(output: string, filePath: string): boolean {
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

function binaryLabel(path: string, side: string, ref?: string): string {
  return `[二进制文件（${side === 'before' ? '提交前' : side === 'after' ? '提交后' : '请求内容'}）：${path}${ref ? `；提交 ${ref.slice(0, 7)}` : ''}；GitPeek 以元数据形式显示更改。]\n`;
}
