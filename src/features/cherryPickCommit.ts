import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';

export async function cherryPickInProgress(git: GitService, repo: Repository, signal?: AbortSignal): Promise<boolean> {
  try {
    await git.run(repo, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], { signal });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

export async function cherryPickCommit(git: GitService, repo: Repository, hash: string): Promise<void> {
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(hash)) throw new Error('Cherry-pick 需要完整的十六进制 Commit Hash。');
  if (await cherryPickInProgress(git, repo)) throw new Error('当前已有 Cherry-pick 正在进行。');
  if (!(await git.run(repo, ['branch', '--show-current'])).trim()) throw new Error('分离 HEAD 状态下不能 Cherry-pick。');
  if ((await git.run(repo, ['status', '--porcelain', '-z', '--untracked-files=all'])).length) throw new Error('工作区不干净，不能 Cherry-pick。');

  const resolved = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
  if (resolved.toLowerCase() !== hash.toLowerCase()) throw new Error('未找到该完整 Commit Hash。');
  if ((await git.run(repo, ['rev-list', '--parents', '-n', '1', resolved])).trim().split(/\s+/).length > 2) {
    throw new Error('不能 Cherry-pick Merge Commit。');
  }
  await git.run(repo, ['cherry-pick', resolved], { timeoutMs: 20_000 });
}

export async function continueCherryPick(git: GitService, repo: Repository): Promise<void> {
  if (!(await cherryPickInProgress(git, repo))) throw new Error('当前没有进行中的 Cherry-pick。');
  await git.run(repo, ['-c', 'core.editor=true', 'cherry-pick', '--continue'], { timeoutMs: 20_000 });
}

export async function abortCherryPick(git: GitService, repo: Repository): Promise<void> {
  if (!(await cherryPickInProgress(git, repo))) throw new Error('当前没有进行中的 Cherry-pick。');
  await git.run(repo, ['cherry-pick', '--abort'], { timeoutMs: 20_000 });
}
