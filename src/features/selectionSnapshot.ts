import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';
import { parseNameStatus } from '../git/GitParser';
import type { BlameLineRange } from './selectionOrigins';

export interface SelectionSnapshot {
  head?: string;
  file: string;
  ranges: Array<{ current: BlameLineRange; committed: BlameLineRange }>;
}

export async function mapSelectionSnapshot(git: GitService, repo: Repository, file: string, text: string, range: BlameLineRange): Promise<SelectionSnapshot> {
  const rel = relative(repo.root, resolve(repo.root, file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || file.includes('\0')) throw new Error('文件路径不在仓库中。');
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) throw new Error('选区行号无效。');
  const current = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = (value: string) => value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0;
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024 || lines(current) > 20_000) throw new Error('文件超过 2 MB 或 20,000 行，无法追踪编辑中的选区。');
  if (current.includes('\0')) throw new Error('二进制内容无法追踪选区历史。');
  const head = await git.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).then(value => value.trim()).catch(error => {
    if (error.cause?.code === 1) return undefined;
    throw error;
  });
  const result: SelectionSnapshot = { head, file, ranges: [] };
  if (!head) return result;
  if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error('提交引用无效。');
  if (await git.run(repo, ['ls-files', '--unmerged', '-z', '--', `:(literal)${file}`])) throw new Error('此文件存在合并冲突，请解决后再追踪选区历史。');
  const staged = parseNameStatus(await git.run(repo, ['diff', '--cached', '--name-status', '-z', '-M', head, '--']));
  result.file = staged.find(change => change.status === 'R' && change.path === file)?.oldPath ?? file;
  const exists = await git.run(repo, ['ls-tree', '-z', head, '--', `:(literal)${result.file}`]);
  if (!exists) return result;
  const committed = (await git.run(repo, ['show', `${head}:${result.file}`])).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (committed.includes('\0') || Buffer.byteLength(committed, 'utf8') > 2 * 1024 * 1024 || lines(committed) > 20_000) throw new Error('HEAD 中的文件为二进制或超过追溯大小限制。');
  let diff = '';
  if (committed !== current) {
    const folder = await mkdtemp(join(tmpdir(), 'gitpeek-selection-'));
    try {
      const before = join(folder, 'head.txt'), after = join(folder, 'editor.txt');
      await Promise.all([writeFile(before, committed, 'utf8'), writeFile(after, current, 'utf8')]);
      try {
        diff = await git.run(repo, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--unified=0', '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic', '--', before, after]);
      } catch (error) {
        const cause = (error as Error & { cause?: { code?: number; stdout?: string } }).cause;
        if (cause?.code !== 1 || typeof cause.stdout !== 'string') throw error;
        diff = cause.stdout;
      }
    } finally {
      if (dirname(folder) !== resolve(tmpdir())) throw new Error('临时路径不在系统临时目录中。');
      await rm(folder, { recursive: true, force: true });
    }
  }
  // ponytail: exact unchanged diff spans only; rewritten or moved code needs explicit selection, not guessed ancestry.
  let oldLine = 1, newLine = 1;
  const addSpan = (length: number) => {
    const start = Math.max(newLine, range.startLine), end = Math.min(newLine + length - 1, range.endLine);
    if (start <= end) result.ranges.push({ current: { startLine: start, endLine: end }, committed: { startLine: oldLine + start - newLine, endLine: oldLine + end - newLine } });
  };
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1);
    const oldStart = Number(match[1]) + (oldCount === 0 ? 1 : 0), newStart = Number(match[3]) + (newCount === 0 ? 1 : 0);
    addSpan(newStart - newLine);
    oldLine = oldStart + oldCount;
    newLine = newStart + newCount;
  }
  addSpan(lines(current) - newLine + 1);
  if ((await git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim() !== head) throw new Error('HEAD 已变化，请重新选择代码范围。');
  return result;
}
