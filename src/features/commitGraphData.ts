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

export async function loadGraph(git: GitService, repo: Repository, limit = 100): Promise<GraphSnapshot> {
  const count = Math.min(500, Math.max(1, Math.floor(limit)));
  const [branch, branches, head] = await Promise.all([
    git.run(repo, ['branch', '--show-current']),
    git.run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git.run(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
  ]);
  const result = head ? parseGraph(await git.run(repo, [
    'log', '--graph', '--all', 'HEAD', '--date-order', `--max-count=${count + 1}`,
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1e',
  ], { timeoutMs: 10_000 }), count) : { rows: [], hasMore: false };
  return { branch: branch.trim(), branches: branches.trim().split(/\r?\n/).filter(Boolean), ...result };
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
