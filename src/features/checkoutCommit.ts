import type { GitService } from '../git/GitService';
import type { Repository } from '../git/types';

export async function checkoutCommit(git: GitService, repo: Repository, hash: string): Promise<void> {
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(hash)) throw new Error('检出提交需要完整的十六进制 Commit Hash。');
  if ((await git.run(repo, ['status', '--porcelain', '-z', '--untracked-files=all'])).length) {
    throw new Error('工作区不干净，不能检出提交。');
  }

  const resolved = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
  if (resolved.toLowerCase() !== hash.toLowerCase()) throw new Error('未找到该完整 Commit Hash。');
  await git.run(repo, ['switch', '--detach', resolved]);
}
