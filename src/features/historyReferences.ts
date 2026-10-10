import type { GitService } from '../git/GitService'
import type { Repository } from '../git/types'

export interface HistoryReference {
  ref: string
  label: string
  description: string
}

export async function resolveHistoryReference(git: GitService, repo: Repository, ref: string, signal?: AbortSignal): Promise<string> {
  if (!ref || ref.startsWith('-') || /[\x00-\x20\x7f]/.test(ref)) throw new Error('文件历史的参考版本无效。')
  const head = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { signal })).trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) throw new Error('文件历史的参考版本没有有效提交。')
  return head
}

export async function listHistoryReferences(git: GitService, repo: Repository, signal?: AbortSignal): Promise<HistoryReference[]> {
  const output = await git.run(repo, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/', 'refs/tags/'], { signal })
  return output.split('\n').flatMap(line => {
    const [ref, symbolic] = line.replace(/\r$/, '').split('\0')
    if (!ref || symbolic) return []
    const match = /^refs\/(heads|remotes|tags)\/(.+)$/.exec(ref)
    if (!match) return []
    return [{ ref, label: match[2], description: match[1] === 'heads' ? '本地分支' : match[1] === 'remotes' ? '远程分支' : '标签' }]
  })
}

export async function listHistoryFiles(git: GitService, repo: Repository, head: string, signal?: AbortSignal): Promise<string[]> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) throw new Error('文件历史的提交快照无效。')
  return (await git.run(repo, ['ls-tree', '-r', '--name-only', '-z', head], { signal })).split('\0').filter(Boolean)
}
