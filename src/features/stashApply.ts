import { StashEntry, assertStashIdentity } from './stashList'
import { Repository } from '../git/types'

export async function applyStash(git: { run(repo: Repository | string, args: string[]): Promise<string> }, repo: Repository, entry: StashEntry): Promise<void> {
  await assertStashIdentity(git, repo, entry)
  if ((await git.run(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length > 0) {
    throw new Error('工作区不干净，无法应用 Stash。')
  }
  await git.run(repo, ['stash', 'apply', entry.oid])
}
