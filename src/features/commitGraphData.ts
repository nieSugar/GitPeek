import { posix, win32 } from 'node:path';
import type { GitService } from '../git/GitService';
import { parseNameStatus } from '../git/GitParser';
import type { FileChange, Repository } from '../git/types';

export interface GraphRow {
  graph: string;
  hash?: string;
  parents?: string[];
  author?: string;
  email?: string;
  time?: number;
  subject?: string;
  refs?: string;
}

export interface GraphSnapshot {
  branch: string;
  branches: string[];
  rows: GraphRow[];
  hasMore: boolean;
}

export interface GraphQuery {
  kind: 'message' | 'author' | 'hash' | 'code';
  text: string;
  scope: 'all' | 'current';
  path?: string;
  since?: string;
  until?: string;
}

export function normalizeGraphQuery(value: unknown): GraphQuery {
  if (!value || typeof value !== 'object') throw new Error('搜索条件无效。');
  const query = value as Record<string, unknown>;
  if (!['message', 'author', 'hash', 'code'].includes(String(query.kind)) || !['all', 'current'].includes(String(query.scope))
    || typeof query.text !== 'string' || query.text.length > 500 || query.text.includes('\0')) throw new Error('搜索类型或内容无效（最多 500 个字符）。');
  const result: GraphQuery = { kind: query.kind as GraphQuery['kind'], text: query.kind === 'code' ? query.text : query.text.trim(), scope: query.scope as GraphQuery['scope'] };
  for (const key of ['path', 'since', 'until'] as const) {
    if (query[key] === undefined || query[key] === '') continue;
    if (typeof query[key] !== 'string') throw new Error('搜索路径或日期格式无效。');
    result[key] = query[key];
  }
  if (result.path) {
    if (result.path.length > 4096 || result.path.includes('\0') || posix.isAbsolute(result.path) || win32.isAbsolute(result.path)
      || /^[A-Za-z]:/.test(result.path) || result.path.split(/[\\/]/).includes('..')) throw new Error('请输入仓库内的相对文件或目录路径，不能包含 ..。');
    result.path = result.path.replace(/\\/g, '/');
  }
  if (result.since) searchDate(result.since);
  if (result.until) searchDate(result.until);
  if (result.since && result.until && result.since > result.until) throw new Error('开始日期不能晚于结束日期。');
  return result;
}

function searchDate(value: string, end = false): string {
  const date = new Date(value + 'T00:00:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime())
    || date.getFullYear() !== Number(value.slice(0, 4)) || date.getMonth() + 1 !== Number(value.slice(5, 7)) || date.getDate() !== Number(value.slice(8))) throw new Error('日期必须是有效的 YYYY-MM-DD。');
  if (end) date.setHours(23, 59, 59, 0);
  return date.toISOString();
}

export function parseGraph(output: string, limit: number): Pick<GraphSnapshot, 'rows' | 'hasMore'> {
  const rows: GraphRow[] = [];
  let commits = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('\x1f');
    const prefix = separator < 0 ? line : line.slice(0, separator);
    const match = /([0-9a-f]{40,64})$/.exec(prefix);
    if (!match || separator < 0) {
      if (line.trim()) rows.push({ graph: line.replace(/\x1e/g, '') });
      continue;
    }
    if (++commits > limit) return { rows, hasMore: true };
    const [parents = '', author = '', email = '', time = '0', subject = '', ...refs] = line.slice(separator + 1).replace(/\x1e$/, '').split('\x1f');
    rows.push({
      graph: prefix.slice(0, match.index), hash: match[1], parents: parents ? parents.split(' ') : [],
      author, email, time: Number(time) || 0, subject: subject || '（无标题）', refs: refs.join('\x1f'),
    });
  }
  return { rows, hasMore: false };
}

export async function loadGraph(git: GitService, repo: Repository, limit = 100, query?: GraphQuery, signal?: AbortSignal): Promise<GraphSnapshot> {
  if (query) query = normalizeGraphQuery(query);
  const count = Math.max(1, Math.floor(limit));
  const [branch, branches, head] = await Promise.all([
    git.run(repo, ['branch', '--show-current'], { signal }),
    git.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { signal }),
    git.run(repo, ['rev-parse', '--verify', 'HEAD'], { signal }).catch(error => { if (signal?.aborted) throw error; return ''; }),
  ]);
  const refs = query?.scope === 'current' ? ['HEAD'] : ['--all', 'HEAD'];
  const filters: string[] = [];
  if (query?.text) {
    if (query.kind === 'hash') {
      if (!/^[0-9a-f]{4,64}$/i.test(query.text)) throw new Error('Hash 至少需要 4 位十六进制字符。');
      const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${query.text}^{commit}`], { signal })).trim();
      if (query.scope === 'current') {
        try { await git.run(repo, ['merge-base', '--is-ancestor', hash, 'HEAD'], { signal }); }
        catch (error) {
          if ((error as Error & { cause?: { code?: number } }).cause?.code !== 1) throw error;
          return { branch: branch.trim(), branches: branches.trim().split(/\r?\n/).filter(Boolean), rows: [], hasMore: false };
        }
      }
      refs.splice(0, refs.length, hash);
    } else if (query.kind === 'code') filters.push(`-S${query.text}`);
    else filters.push('--fixed-strings', '--regexp-ignore-case', `${query.kind === 'author' ? '--author' : '--grep'}=${query.text}`);
  }
  if (query?.since) filters.push(`--since-as-filter=${searchDate(query.since)}`);
  if (query?.until) filters.push(`--until=${searchDate(query.until, true)}`);
  const hashSearch = Boolean(query?.text && query.kind === 'hash');
  // --max-count enables traversal; exact Hash queries must put --no-walk after it.
  const result = head ? parseGraph(await git.run(repo, [
    'log', ...(hashSearch ? [] : ['--graph']), ...filters, ...refs, '--date-order', `--max-count=${count + 1}`, ...(hashSearch ? ['--no-walk'] : []),
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%D%x1e',
    '--', ...(query?.path ? [`:(literal)${query.path}`] : []),
  ], { timeoutMs: 10_000, signal }), count) : { rows: [], hasMore: false };
  return { branch: branch.trim(), branches: branches.trim().split(/\r?\n/).filter(Boolean), ...result };
}

export async function loadCodeSearchFiles(git: GitService, repo: Repository, hash: string, query: GraphQuery, signal?: AbortSignal): Promise<FileChange[]> {
  query = normalizeGraphQuery(query);
  if (query.kind !== 'code' || !query.text || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) throw new Error('代码搜索结果或提交快照无效。');
  return parseNameStatus(await git.run(repo, [
    'show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', `-S${query.text}`,
    hash, '--', ...(query.path ? [`:(literal)${query.path}`] : []),
  ], { timeoutMs: 10_000, signal }));
}

export async function loadCodeSearchLocation(git: GitService, repo: Repository, hash: string, file: FileChange, text: string, signal?: AbortSignal): Promise<{ location?: { side: 'left' | 'right'; line: number; text: string }; reason?: string }> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash) || !text || text.includes('\0')) throw new Error('代码搜索定位条件无效。');
  const parent = file.status === 'R' ? (await git.run(repo, ['rev-list', '--parents', '-n', '1', hash], { signal })).trim().split(/\s+/)[1] : undefined;
  // Compare the renamed blobs directly: the old name may be reused by another file in the same commit.
  const revision = file.status === 'R'
    ? ['diff', `${parent}:${file.oldPath}`, `${hash}:${file.path}`]
    : ['show', '--format=', '--diff-merges=first-parent', hash];
  const patch = await git.run(repo, [
    ...revision, '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', '--inter-hunk-context=0',
    '--', ...(file.status === 'R' ? [] : [`:(literal)${file.path}`]),
  ], { timeoutMs: 10_000, signal });
  if (/^(?:Binary files |GIT binary patch)/m.test(patch)) return { reason: '命中发生在二进制文件中，无法定位到文本行。' };
  let oldLine = 0, newLine = 0;
  let block: { side: 'left' | 'right'; line: number; lines: string[] } | undefined;
  const locate = () => {
    if (!block) return undefined;
    const contents = block.lines.join('\n');
    const offset = contents.indexOf(text);
    if (offset < 0) return undefined;
    const index = contents.slice(0, offset).split('\n').length - 1;
    return { side: block.side, line: block.line + index, text: block.lines[index].replace(/\r$/, '') };
  };
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    const side = oldLine || newLine ? line.startsWith('-') ? 'left' : line.startsWith('+') ? 'right' : undefined : undefined;
    if (block && (hunk || side !== block.side)) {
      const location = locate();
      if (location) return { location };
      block = undefined;
    }
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (side) {
      block ??= { side, line: side === 'left' ? oldLine : newLine, lines: [] };
      block.lines.push(line.slice(1));
      if (side === 'left') oldLine++; else newLine++;
    } else if (line.startsWith(' ')) { oldLine++; newLine++; }
    else if (!line.startsWith('\\')) { oldLine = 0; newLine = 0; }
  }
  const location = locate();
  return location ? { location } : { reason: 'Git 确认文本出现次数发生变化，但补丁中没有可核实的增删命中行（文本可能跨越未变化的行或受文件类型影响）。' };
}

export async function createAndSwitchBranch(git: GitService, repo: Repository, name: string): Promise<void> {
  await git.run(repo, ['check-ref-format', '--branch', name]);
  await git.run(repo, ['switch', '-c', name]);
}

export async function switchLocalBranch(git: GitService, repo: Repository, name: string): Promise<void> {
  const branches = (await git.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).trim().split(/\r?\n/);
  if (!branches.includes(name)) throw new Error(`本地分支“${name}”不存在。`);
  await git.run(repo, ['switch', '--', name]);
}

export async function mergeLocalBranch(git: GitService, repo: Repository, name: string): Promise<void> {
  const [current, branches, status] = await Promise.all([
    git.run(repo, ['branch', '--show-current']),
    git.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git.run(repo, ['status', '--porcelain', '-z']),
  ]);
  if (!current.trim()) throw new Error('分离 HEAD 状态下无法合并到当前分支。');
  if (current.trim() === name) throw new Error('不能合并当前分支自身。');
  if (!branches.trim().split(/\r?\n/).includes(name)) throw new Error(`本地分支“${name}”不存在。`);
  if (status) throw new Error('合并前请先提交或处理工作区更改。');
  await git.run(repo, ['merge', '--no-edit', '--', name], { timeoutMs: 20_000 });
}

export function parseGitHubRemote(remote: string): { owner: string; repo: string } | undefined {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function avatarByEmail(commits: unknown): Record<string, string> {
  const avatars: Record<string, string> = {};
  if (!Array.isArray(commits)) return avatars;
  for (const item of commits) {
    const email = item?.commit?.author?.email;
    const url = item?.author?.avatar_url;
    if (typeof email !== 'string' || typeof url !== 'string') continue;
    try {
      const avatar = new URL(url);
      if (avatar.protocol === 'https:' && avatar.hostname === 'avatars.githubusercontent.com') avatars[email.toLowerCase()] = url;
    } catch { /* Ignore malformed avatar URLs. */ }
  }
  return avatars;
}
