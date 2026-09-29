import type { GitService } from '../git/GitService'
import type { Repository } from '../git/types'

export async function saveStash(
  git: GitService,
  repo: Repository,
  message: string,
  includeUntracked: boolean,
): Promise<void> {
  const statusArgs = ['status', '--porcelain=v1', '-z', includeUntracked ? '--untracked-files=all' : '--untracked-files=no']
  if (!(await git.run(repo, statusArgs))) throw new Error('当前仓库没有可保存的更改。')

  await git.run(repo, ['stash', 'push', '-m', message, ...(includeUntracked ? ['-u'] : [])])
}
