import { FileChange, Repository } from '../git/types'
import { parseNameStatus, parseNumStat } from '../git/GitParser'

export interface StashEntry {
  ref: string
  oid: string
  subject: string
  time: number
}

export interface StashPreview {
  files: FileChange[]
  additions: number
  deletions: number
}

interface GitRunner {
  run(repo: Repository | string, args: string[]): Promise<string>
}

export async function listStashes(git: GitRunner, repo: Repository): Promise<StashEntry[]> {
  const output = await git.run(repo, ['stash', 'list', '--format=%gd%x1f%H%x1f%gs%x1f%ct'])
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, oid, subject, rawTime] = line.split('\x1f')
    const time = Number(rawTime)
    if (!/^stash@\{\d+\}$/.test(ref) || !/^[0-9a-f]{40,64}$/i.test(oid) || !Number.isFinite(time)) {
      throw new Error('无法解析 Git stash 列表')
    }
    return { ref, oid, subject, time }
  })
}

export async function assertStashIdentity(git: GitRunner, repo: Repository, entry: StashEntry): Promise<void> {
  if (!/^stash@\{\d+\}$/.test(entry.ref) || !/^[0-9a-f]{40,64}$/i.test(entry.oid)) {
    throw new Error('Stash 身份无效，请刷新列表后重试')
  }
  let oid: string
  try {
    oid = (await git.run(repo, ['rev-parse', '--verify', `${entry.ref}^{commit}`])).trim()
  } catch {
    throw new Error('Stash 列表已变化或无法验证，请刷新后重试')
  }
  if (oid.toLowerCase() !== entry.oid.toLowerCase()) throw new Error('Stash 列表已变化，请刷新后重试')
}

export async function previewStash(git: GitRunner, repo: Repository, entry: StashEntry): Promise<StashPreview> {
  await assertStashIdentity(git, repo, entry)
  const [trackedNames, trackedStats, parents] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', `${entry.oid}^1`, entry.oid, '--']),
    git.run(repo, ['diff', '--numstat', '-z', '-M', `${entry.oid}^1`, entry.oid, '--']),
    git.run(repo, ['rev-list', '--parents', '-n', '1', entry.oid]),
  ])
  const files = parseNameStatus(trackedNames)
  const stats = parseNumStat(trackedStats)

  // `stash -u` stores untracked files in the third parent, outside the usual stash diff.
  const parentOids = parents.trim().split(/\s+/)
  if (parentOids.length >= 4) {
    const untrackedParent = parentOids[3]
    const [names, numstat] = await Promise.all([
      git.run(repo, ['diff', '--name-status', '-z', `${entry.oid}^1`, untrackedParent, '--']),
      git.run(repo, ['diff', '--numstat', '-z', `${entry.oid}^1`, untrackedParent, '--']),
    ])
    const existing = new Set(files.map((file) => file.path))
    const untrackedFiles = parseNameStatus(names).filter((file) => file.status === 'A')
    for (const file of untrackedFiles) {
      if (!existing.has(file.path)) files.push(file)
    }
    const untrackedPaths = new Set(untrackedFiles.map((file) => file.path))
    for (const [path, count] of parseNumStat(numstat)) {
      if (untrackedPaths.has(path)) stats.set(path, count)
    }
  }

  const detailedFiles = files.map((file) => ({ ...file, ...(stats.get(file.path) ?? { additions: 0, deletions: 0 }) }))
  return {
    files: detailedFiles,
    additions: detailedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: detailedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
  }
}
