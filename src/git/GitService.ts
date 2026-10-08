import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BlameInfo, BranchComparison, CommitDetail, FileHistoryCommit, FileChange, GitStatus, Repository } from './types'
import { parseBlame, parseFileHistory, parseLog, parseNameStatus, parseNumStat, parseStatus } from './GitParser'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 5000
const MAX_BUFFER = 16 * 1024 * 1024

export class GitService {
  constructor(private readonly log?: (message: string) => void) {}

  async run(repo: Repository | string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
    const root = typeof repo === 'string' ? repo : repo.root
    const startedAt = Date.now()
    try {
      const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
        windowsHide: true,
      })
      return stdout
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
      const detail = error.killed ? 'timed out' : error.code === 'ENOENT' ? 'git executable not found' : (error.stderr?.trim() || error.message)
      throw new Error(`Git 命令 ${args[0] ?? '未知命令'} 在“${root}”执行失败：${detail}`, { cause })
    } finally {
      try { this.log?.(`[GitPeek] git ${args[0] ?? 'command'} (${root}) ${Date.now() - startedAt}ms`) } catch { /* Logging must not affect Git operations. */ }
    }
  }

  async status(repo: Repository): Promise<GitStatus> {
    return parseStatus(await this.run(repo, ['status', '--porcelain=v2', '-z', '--branch']))
  }

  async blame(repo: Repository, file: string, startLine: number, endLine = startLine): Promise<BlameInfo[]> {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) throw new RangeError('Invalid blame line range')
    return parseBlame(await this.run(repo, ['-c', 'core.quotePath=false', 'blame', '--line-porcelain', '-L', `${startLine},${endLine}`, '--', file]))
  }

  async history(repo: Repository, file: string, limit = 20): Promise<FileHistoryCommit[]> {
    return parseFileHistory(await this.run(repo, ['log', '--follow', '--name-only', '-z', `--max-count=${Math.max(1, Math.floor(limit))}`, '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x00', '--', `:(literal)${file}`]))
  }

  async commit(repo: Repository, hash: string): Promise<CommitDetail> {
    const [meta, names, stats] = await Promise.all([
      this.run(repo, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s', hash]),
      this.run(repo, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', hash]),
      this.run(repo, ['show', '--format=', '--numstat', '-z', '-M', hash]),
    ])
    const [info] = parseLog(`${meta.replace(/\n?$/, '\0')}`)
    if (!info) throw new Error(`Could not parse commit ${hash}`)
    const counts = parseNumStat(stats)
    const files = parseNameStatus(names).map((file) => ({ ...file, ...(counts.get(file.path) ?? {}) }))
    return { ...info, files, additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) }
  }

  async compare(repo: Repository, base: string, head = 'HEAD'): Promise<BranchComparison> {
    const [counts, commits, names, stats] = await Promise.all([
      this.run(repo, ['rev-list', '--left-right', '--count', `${base}...${head}`]),
      this.run(repo, ['log', '-z', '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x00', `${base}..${head}`]),
      this.run(repo, ['diff', '--name-status', '-z', '-M', `${base}...${head}`, '--']),
      this.run(repo, ['diff', '--numstat', '-z', '-M', `${base}...${head}`, '--']),
    ])
    const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map(Number)
    const statMap = parseNumStat(stats)
    const files: FileChange[] = parseNameStatus(names).map((file) => ({ ...file, ...(statMap.get(file.path) ?? {}) }))
    return { base, head, ahead, behind, commits: parseLog(commits), files }
  }
}
