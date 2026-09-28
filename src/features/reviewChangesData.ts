import { readFile } from 'node:fs/promises';
import { parseNameStatus, parseNumStat, parseStatus } from '../git/GitParser';
import type { GitService } from '../git/GitService';
import type { FileChange, Repository } from '../git/types';

export type ReviewSection = 'staged' | 'unstaged' | 'untracked';
export interface ReviewFile extends FileChange {
  section: ReviewSection;
  binary: boolean;
  warnings: string[];
}
export interface ReviewGroup {
  section: ReviewSection;
  files: ReviewFile[];
  additions: number;
  deletions: number;
}
export interface ReviewSnapshot {
  repo: Repository;
  groups: ReviewGroup[];
  fileCount: number;
  additions: number;
  deletions: number;
}
export interface ReviewDiff {
  file: ReviewFile;
  oldContent: string;
  newContent: string;
  binary: boolean;
}

export async function loadReviewSnapshot(git: GitService, repo: Repository): Promise<ReviewSnapshot> {
  const [status, stagedNames, stagedStats, workNames, workStats, stagedPatch, workPatch] = await Promise.all([
    git.run(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']).then(parseStatus),
    git.run(repo, ['diff', '--cached', '--name-status', '-z', '-M', '--']),
    git.run(repo, ['diff', '--cached', '--numstat', '-z', '-M', '--']),
    git.run(repo, ['diff', '--name-status', '-z', '-M', '--']),
    git.run(repo, ['diff', '--numstat', '-z', '-M', '--']),
    git.run(repo, ['-c', 'core.quotePath=false', 'diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff', '--']),
    git.run(repo, ['-c', 'core.quotePath=false', 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--']),
  ]);
  const staged = createFileGroup('staged', parseNameStatus(stagedNames), stagedStats, stagedPatch);
  const unstaged = createFileGroup('unstaged', parseNameStatus(workNames), workStats, workPatch);
  const untracked = await Promise.all(status.files.filter((file) => file.index === '?' || file.worktree === '?').map(async (entry): Promise<ReviewFile> => {
    const bytes = await readFile(joinPath(repo.root, entry.path));
    const binary = bytes.includes(0);
    const text = binary ? '' : bytes.toString('utf8');
    return {
      path: entry.path, status: 'A', section: 'untracked', binary,
      additions: binary ? 0 : countLines(text), deletions: 0,
      warnings: [...pathWarnings(entry.path), ...(binary ? [] : scanAddedLines(text))],
    };
  }));
  const groups = [staged, unstaged, summarizeGroup('untracked', untracked)];
  const paths = new Set(groups.flatMap((group) => group.files.map((file) => file.path)));
  return {
    repo, groups, fileCount: paths.size,
    additions: groups.reduce((sum, group) => sum + group.additions, 0),
    deletions: groups.reduce((sum, group) => sum + group.deletions, 0),
  };
}

export async function loadReviewDiff(git: GitService, repo: Repository, section: ReviewSection, filePath: string): Promise<ReviewDiff> {
  const snapshot = await loadReviewSnapshot(git, repo);
  const file = snapshot.groups.find((group) => group.section === section)?.files.find((entry) => entry.path === filePath || entry.oldPath === filePath);
  if (!file) throw new Error(`This ${section} change no longer exists: ${filePath}`);
  const oldPath = file.oldPath ?? file.path;
  const stagedAddition = section === 'staged' && file.status === 'A';
  const deleted = file.status === 'D';
  let oldContent = '';
  let newContent = '';
  let binary = file.binary;
  if (section === 'staged') {
    if (!stagedAddition) oldContent = await git.run(repo, ['show', `HEAD:${oldPath}`]);
    if (!deleted) newContent = await git.run(repo, ['show', `:${file.path}`]);
  } else if (section === 'unstaged') {
    if (file.status !== 'A') oldContent = await git.run(repo, ['show', `:${oldPath}`]);
    if (!deleted) {
      const bytes = await readFile(joinPath(repo.root, file.path));
      binary ||= bytes.includes(0);
      newContent = binary ? binaryLabel(file.path, 'working tree') : bytes.toString('utf8');
    }
  } else {
    const bytes = await readFile(joinPath(repo.root, file.path));
    binary ||= bytes.includes(0);
    newContent = binary ? binaryLabel(file.path, 'untracked') : bytes.toString('utf8');
  }
  if (binary) {
    oldContent = section === 'untracked' || section === 'staged' && stagedAddition ? '' : binaryLabel(oldPath, section === 'staged' ? 'HEAD' : 'index');
    newContent = deleted ? '' : binaryLabel(file.path, section === 'staged' ? 'index' : 'working tree');
  }
  return { file, oldContent, newContent, binary };
}

function createFileGroup(section: 'staged' | 'unstaged', files: FileChange[], numstat: string, patch: string): ReviewGroup {
  const stats = parseNumStat(numstat);
  const binaries = parseBinaryPaths(numstat);
  const warnings = parsePatchWarnings(patch);
  return summarizeGroup(section, files.map((file) => {
    const stat = stats.get(file.path);
    const found = new Set([...pathWarnings(file.path), ...(file.oldPath ? pathWarnings(file.oldPath) : []), ...(warnings.get(file.path) ?? [])]);
    return { ...file, section, binary: binaries.has(file.path), additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0, warnings: [...found] };
  }));
}

function summarizeGroup(section: ReviewSection, files: ReviewFile[]): ReviewGroup {
  return { section, files, additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) };
}

function parseBinaryPaths(output: string): Set<string> {
  const result = new Set<string>();
  const fields = output.split('\0');
  for (let i = 0; i < fields.length;) {
    const record = fields[i++];
    if (!record) continue;
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0 || record.slice(0, first) !== '-' || record.slice(first + 1, second) !== '-') continue;
    const path = record.slice(second + 1);
    if (path) result.add(path);
    else { i++; const newPath = fields[i++]; if (newPath !== undefined) result.add(newPath); }
  }
  return result;
}

function parsePatchWarnings(patch: string): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  let file = '';
  let line = 0;
  for (const text of patch.split(/\r?\n/)) {
    if (text.startsWith('+++ b/')) { file = text.slice(6); continue; }
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || !text.startsWith('+') || text.startsWith('+++')) continue;
    for (const warning of scanLine(text.slice(1))) {
      const entries = result.get(file) ?? new Set<string>();
      entries.add(`${warning} (line ${line})`);
      result.set(file, entries);
    }
    line++;
  }
  return new Map([...result].map(([path, warnings]) => [path, [...warnings]]));
}

function pathWarnings(path: string): string[] {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.pem') ? [`Sensitive file: ${name}`] : [];
}

function scanAddedLines(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line, index) => scanLine(line).map((warning) => `${warning} (line ${index + 1})`));
}

function scanLine(line: string): string[] {
  const warnings: string[] = [];
  if (/\bconsole\.log\s*\(/.test(line)) warnings.push('console.log');
  if (/\bdebugger\b/.test(line)) warnings.push('debugger');
  if (/\bTODO\b/i.test(line)) warnings.push('TODO');
  if (/\bFIXME\b/i.test(line)) warnings.push('FIXME');
  return warnings;
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? lines : lines + 1;
}

function joinPath(root: string, file: string): string {
  return `${root.replace(/[\\/]$/, '')}/${file}`;
}

function binaryLabel(path: string, side: string): string {
  return `[Binary file ${side}: ${path}; binary contents are not rendered.]\n`;
}
