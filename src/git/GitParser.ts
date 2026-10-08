import { BlameInfo, CommitInfo, FileChange, FileHistoryCommit, GitStatus } from './types'

export function parseNameStatus(output: string): FileChange[] {
  const fields = output.split('\0')
  const result: FileChange[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]
    if (!status) continue
    const code = status[0] as FileChange['status']
    if (code === 'R' || code === 'C') {
      const oldPath = fields[i++]
      const path = fields[i++]
      if (oldPath !== undefined && path !== undefined) result.push({ status: code, oldPath, path })
    } else {
      const path = fields[i++]
      if (path !== undefined) result.push({ status: code, path })
    }
  }
  return result
}

export function parseNumStat(output: string): Map<string, { additions: number; deletions: number }> {
  const fields = output.split('\0')
  const result = new Map<string, { additions: number; deletions: number }>()
  for (let i = 0; i < fields.length;) {
    const field = fields[i++]
    if (!field) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    const add = firstTab < 0 ? undefined : field.slice(0, firstTab)
    const del = secondTab < 0 ? undefined : field.slice(firstTab + 1, secondTab)
    const path = secondTab < 0 ? undefined : field.slice(secondTab + 1)
    if (path === '' && add !== undefined && del !== undefined) {
      // Rename records use an empty path followed by old and new paths.
      const oldPath = fields[i++]
      const newPath = fields[i++]
      if (oldPath !== undefined && newPath !== undefined) result.set(newPath, { additions: numberOrZero(add), deletions: numberOrZero(del) })
    } else if (path !== undefined) result.set(path, { additions: numberOrZero(add ?? ''), deletions: numberOrZero(del ?? '') })
  }
  return result
}

export function parseLog(output: string): CommitInfo[] {
  return output.split('\0').filter(Boolean).map((record) => {
    const [hash, author, email, date, ...subject] = record.split('\x1f')
    return { hash, shortHash: hash.slice(0, 7), author, ...(email ? { email } : {}), date: Date.parse(date), subject: subject.join('\x1f') }
  }).filter((commit) => commit.hash && Number.isFinite(commit.date))
}

export function parseFileHistory(output: string): FileHistoryCommit[] {
  return output.split('\0\0').flatMap((record) => {
    const [metadata, name] = record.split('\0')
    const [commit] = parseLog(metadata)
    // Git inserts one newline between the commit metadata and the raw filename.
    const filePath = name?.replace(/^\n/, '')
    return commit && filePath ? [{ ...commit, filePath }] : []
  })
}

export function parseStatus(output: string): GitStatus {
  const fields = output.split('\0').filter(Boolean)
  const headers = fields.filter((field) => field.startsWith('# '))
  const branchLine = headers.find((field) => field.startsWith('# branch.head ')) ?? ''
  const branch = branchLine ? branchLine.slice(14) : undefined
  const files: GitStatus['files'] = []
  for (let i = 0; i < fields.length;) {
    const record = fields[i++]
    if (record.startsWith('# ')) continue
    if (record.startsWith('? ')) { files.push({ index: '?', worktree: '?', path: record.slice(2) }); continue }
    const kind = record[0]
    const index = record[2] ?? ' '
    const worktree = record[3] ?? ' '
    const fieldCount = kind === '2' ? 9 : 8
    let pathStart = 0
    for (let split = 0; split < fieldCount; split++) {
      pathStart = record.indexOf(' ', pathStart) + 1
      if (!pathStart) break
    }
    const path = record.slice(pathStart)
    if (kind === '2') files.push({ index, worktree, oldPath: fields[i++], path })
    else files.push({ index, worktree, path })
  }
  return { ...(branch && branch !== '(detached)' ? { branch } : {}), files }
}

export function parseBlame(output: string): BlameInfo[] {
  const lines = output.split('\n')
  const result: BlameInfo[] = []
  for (let i = 0; i < lines.length;) {
    const header = lines[i++].match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/i)
    if (!header) continue
    const info: Partial<BlameInfo> = { hash: header[1], originalLine: Number(header[2]), currentLine: Number(header[3]) }
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const [key, ...value] = lines[i++].split(' ')
      const text = value.join(' ')
      if (key === 'author') info.author = text
      else if (key === 'author-mail') info.authorEmail = text.replace(/^<|>$/g, '')
      else if (key === 'author-time') info.authorTime = Number(text)
      else if (key === 'summary') info.summary = text
      else if (key === 'filename') info.filename = text
    }
    if (lines[i]?.startsWith('\t')) i++
    if (info.authorTime !== undefined) result.push({ hash: info.hash!, filename: info.filename, author: info.author ?? '', authorEmail: info.authorEmail, authorTime: info.authorTime, summary: info.summary ?? '', originalLine: info.originalLine!, currentLine: info.currentLine! })
  }
  return result
}

function numberOrZero(value: string): number {
  return value === '-' ? 0 : Number(value) || 0
}
