import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';

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
  kind: 'message' | 'author' | 'hash';
  text: string;
  scope: 'all' | 'current';
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

export async function loadGraph(git: GitService, repo: Repository, limit = 100, query?: GraphQuery): Promise<GraphSnapshot> {
  const count = Math.max(1, Math.floor(limit));
  const [branch, branches, head] = await Promise.all([
    git.run(repo, ['branch', '--show-current']),
    git.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git.run(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
  ]);
  const refs = query?.scope === 'current' ? ['HEAD'] : ['--all', 'HEAD'];
  const filters: string[] = [];
  if (query?.text) {
    if (query.kind === 'hash') {
      if (!/^[0-9a-f]{4,64}$/i.test(query.text)) throw new Error('Hash 至少需要 4 位十六进制字符。');
      const hash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${query.text}^{commit}`])).trim();
      if (query.scope === 'current') {
        try { await git.run(repo, ['merge-base', '--is-ancestor', hash, 'HEAD']); }
        catch (error) {
          if ((error as Error & { cause?: { code?: number } }).cause?.code !== 1) throw error;
          return { branch: branch.trim(), branches: branches.trim().split(/\r?\n/).filter(Boolean), rows: [], hasMore: false };
        }
      }
      refs.splice(0, refs.length, hash);
    } else filters.push('--fixed-strings', '--regexp-ignore-case', `${query.kind === 'author' ? '--author' : '--grep'}=${query.text}`);
  }
  const hashSearch = Boolean(query?.text && query.kind === 'hash');
  // --max-count enables traversal; exact Hash queries must put --no-walk after it.
  const result = head ? parseGraph(await git.run(repo, [
    'log', ...(hashSearch ? [] : ['--graph']), ...filters, ...refs, '--date-order', `--max-count=${count + 1}`, ...(hashSearch ? ['--no-walk'] : []),
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e',
    '--',
  ], { timeoutMs: 10_000 }), count) : { rows: [], hasMore: false };
  return { branch: branch.trim(), branches: branches.trim().split(/\r?\n/).filter(Boolean), ...result };
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
