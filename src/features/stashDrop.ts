import { Repository } from '../git/types'
import { StashEntry, assertStashIdentity } from './stashList'

export async function dropStash(git: { run(repo: Repository | string, args: string[]): Promise<string> }, repo: Repository, entry: StashEntry): Promise<void> {
  await assertStashIdentity(git, repo, entry)
  await git.run(repo, ['stash', 'drop', entry.ref])
}
