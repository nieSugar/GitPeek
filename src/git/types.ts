export interface Repository {
  root: string
  id: string
}

export interface CommitTarget {
  repo: Repository
  hash: string
  file?: string
  workspacePath?: string
  workspacePathKnown?: boolean
}

export interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email?: string
  date: number
  subject: string
}

export interface FileHistoryCommit extends CommitInfo {
  filePath: string
}

export interface BlameInfo {
  hash: string
  filename?: string
  author: string
  authorEmail?: string
  authorTime: number
  summary: string
  originalLine: number
  currentLine: number
}

export interface FileChange {
  path: string
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B'
  additions?: number
  deletions?: number
}

export interface GitStatus {
  branch?: string
  files: Array<{ path: string; oldPath?: string; index: string; worktree: string }>
}

export interface CommitDetail extends CommitInfo {
  files: FileChange[]
  additions: number
  deletions: number
}

export interface BranchComparison {
  base: string
  head: string
  ahead: number
  behind: number
  commits: CommitInfo[]
  files: FileChange[]
}
