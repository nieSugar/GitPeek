import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GitService } from '../git/GitService'
import type { FileChange, Repository } from '../git/types'
import { parseNameStatus, parseNumStat } from '../git/GitParser'

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop'
export interface RebaseCommit { hash: string; subject: string; message: string }
export interface RebasePlan { repo: Repository; branch: string; head: string; base?: string; commits: RebaseCommit[]; published: boolean }
export interface RebaseStep { hash: string; action: RebaseAction; message?: string }
export interface RebaseState { status: 'completed' | 'paused' | 'aborted'; backupRef?: string; message?: string }
export interface GitOperation { kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert'; conflicts: string[]; rebase?: RebaseState }
export interface RebaseBackup { ref: string; head: string; date: string; subject: string }
export interface RebaseBackupComparison { repo: Repository; backup: RebaseBackup; head: string; files: FileChange[] }

interface StoredPlan { version: 1; plan: RebasePlan; steps: RebaseStep[]; backupRef: string }
const actions = new Set<RebaseAction>(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'])
const busy = new Set<string>()
const hashPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i
const stateDirectory = 'gitpeek-rebase'
const backupPattern = /^refs\/gitpeek\/rebase\/[a-f\d-]{36}$/
const rebaseConfig = ['-c', 'rebase.abbreviateCommands=false', '-c', 'rebase.autoSquash=false', '-c', 'rebase.updateRefs=false', '-c', 'commit.cleanup=verbatim', '-c', 'i18n.commitEncoding=UTF-8', '-c', 'i18n.logOutputEncoding=UTF-8']

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function gitDirectory(git: GitService, repo: Repository): Promise<string> {
  return (await git.run(repo, ['rev-parse', '--absolute-git-dir'])).trim()
}

async function nativeRebase(directory: string): Promise<string | undefined> {
  for (const name of ['rebase-merge', 'rebase-apply']) if (await exists(path.join(directory, name))) return path.join(directory, name)
  return undefined
}

async function assertNoOperation(directory: string): Promise<void> {
  for (const name of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_START']) {
    if (await exists(path.join(directory, name))) throw new Error('当前已有 Git 操作正在进行，请先完成或中止它。')
  }
}

async function assertClean(git: GitService, repo: Repository): Promise<void> {
  if ((await git.run(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignore-submodules=none'])).length) {
    throw new Error('工作区不干净，请先提交或 Stash 全部更改（包括未跟踪文件）。')
  }
}

export async function loadRebasePlan(git: GitService, repo: Repository, firstHash: string): Promise<RebasePlan> {
  if (!hashPattern.test(firstHash)) throw new Error('交互式 Rebase 需要完整的 Commit Hash。')
  await assertNoOperation(await gitDirectory(git, repo))
  const branch = (await git.run(repo, ['branch', '--show-current'])).trim()
  if (!branch) throw new Error('分离 HEAD 状态下不能整理提交，请先切换到本地分支。')
  const head = (await git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim()
  const first = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${firstHash}^{commit}`])).trim()
  try { await git.run(repo, ['merge-base', '--is-ancestor', first, head]) } catch {
    throw new Error('所选提交不是当前分支的祖先，不能从这里整理当前分支。')
  }
  const firstParents = (await git.run(repo, ['rev-list', '--parents', '-n', '1', first])).trim().split(/\s+/).slice(1)
  if (firstParents.length > 1) throw new Error('当前版本只支持线性提交范围，不能包含合并提交。')
  const base = firstParents[0]
  const range = base ? `${base}..${head}` : head
  const rows = (await git.run(repo, ['rev-list', '--reverse', '--topo-order', '--parents', '--max-count=201', range])).trim().split('\n').map(line => line.trim().split(/\s+/))
  if (rows.length > 200) throw new Error('一次最多整理 200 个提交，请选择更近的起点。')
  if (rows[0]?.[0] !== first || rows.some((row, index) => row.length > 2 || (index > 0 && row[1] !== rows[index - 1][0]))) {
    throw new Error('当前版本只支持线性提交范围，不能包含合并提交。')
  }
  const fields = (await git.run(repo, ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', '--reverse', '-z', '--format=%H%x00%s%x00%B', range])).split('\0')
  const commits: RebaseCommit[] = []
  for (let index = 0; index + 2 < fields.length; index += 3) commits.push({ hash: fields[index].trim(), subject: fields[index + 1], message: fields[index + 2] })
  if (commits.length !== rows.length || commits.some((commit, index) => commit.hash !== rows[index][0])) throw new Error('无法读取完整的提交范围，请重新加载。')
  const published = Boolean((await git.run(repo, ['for-each-ref', `--contains=${first}`, '--format=%(refname)', 'refs/remotes/'])).trim())
  return { repo, branch, head, base, commits, published }
}

export function validateRebaseSteps(plan: RebasePlan, input: unknown): RebaseStep[] {
  if (!Array.isArray(input) || input.length !== plan.commits.length) throw new Error('整理计划必须恰好包含范围内的全部提交；删除提交请使用“丢弃”。')
  const remaining = new Set(plan.commits.map(commit => commit.hash))
  let kept = false
  const steps = input.map(value => {
    if (!value || typeof value !== 'object' || typeof value.hash !== 'string' || !remaining.delete(value.hash) || !actions.has(value.action)) {
      throw new Error('整理计划包含重复、未知提交或无效操作，请重新加载。')
    }
    const step: RebaseStep = { hash: value.hash, action: value.action }
    if (value.message !== undefined) {
      if (typeof value.message !== 'string' || value.message.includes('\0') || value.message.length > 20_000) throw new Error('提交信息必须是有效文本，且不能超过 20000 个字符。')
      if (!['reword', 'squash'].includes(step.action)) throw new Error('只有“修改信息”和“合并提交”可以指定提交信息。')
      if (value.message.trim()) step.message = value.message.replace(/\r\n/g, '\n')
    }
    if (step.action === 'reword' && !step.message) throw new Error('修改后的提交信息不能为空。')
    if (step.action !== 'drop') {
      if (!kept && (step.action === 'squash' || step.action === 'fixup')) throw new Error('第一个保留的提交不能合并到前一个提交。')
      kept = true
    }
    return step
  })
  if (!kept) throw new Error('至少需要保留一个提交，不能丢弃全部提交。')
  return steps
}

// Git invokes editors through sh, including on Windows; single-quote both executable paths.
function quoteEditorPath(value: string): string { return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'` }

const editorSource = String.raw`const fs = require('node:fs');
const path = require('node:path');
const stateFile = path.join(__dirname, 'plan.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const target = process.argv[3];
if (!target) throw new Error('Missing Git editor target');
if (process.argv[2] === 'sequence') {
  fs.writeFileSync(path.join(__dirname, '..', 'rebase-merge', 'gitpeek-backup-ref'), state.backupRef, 'utf8');
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  const command = quote(process.execPath) + ' ' + quote(__filename);
  const todo = [];
  let baseHash, captured = false;
  for (const step of state.steps) {
    if (['squash', 'fixup'].includes(step.action)) {
      if (!captured) { todo.push('exec ' + command + ' capture ' + baseHash); captured = true; }
    } else if (step.action !== 'drop') { baseHash = step.hash; captured = false; }
    todo.push(step.action + ' ' + step.hash);
  }
  fs.writeFileSync(target, todo.join('\n') + '\n', 'utf8');
} else if (process.argv[2] === 'capture') {
  // Capture after edit/amend so subsequent folds retain the actual preceding commit message.
  const message = require('node:child_process').execFileSync('git', ['-c', 'i18n.logOutputEncoding=UTF-8', 'show', '-s', '--format=%B', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  state.baseMessage = { hash: target, message };
  fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
} else {
  const done = fs.readFileSync(path.join(__dirname, '..', 'rebase-merge', 'done'), 'utf8').trim().split(/\r?\n/).filter(line => /^(pick|reword|edit|squash|fixup|drop)\s/.test(line));
  const lastHash = done.at(-1)?.split(/\s+/)[1];
  const index = state.steps.findIndex(step => step.hash === lastHash);
  const current = state.steps[index];
  if (!current) throw new Error('Current rebase step is not in the saved plan');
  const originalMessage = hash => state.plan.commits.find(commit => commit.hash === hash).message;
  let message = current.action === 'reword' ? current.message : originalMessage(current.hash);
  if (['squash', 'fixup'].includes(current.action)) {
    let base = index - 1;
    while (base >= 0 && ['squash', 'fixup', 'drop'].includes(state.steps[base].action)) base--;
    if (!state.baseMessage || state.baseMessage.hash !== state.steps[base]?.hash) throw new Error('Missing preceding commit message for squash');
    message = state.baseMessage.message;
    for (let cursor = base + 1; cursor <= index; cursor++) {
      const step = state.steps[cursor];
      if (step.action === 'squash') message = step.message || message.replace(/\n+$/, '') + '\n\n' + originalMessage(step.hash);
    }
  }
  fs.writeFileSync(target, message.replace(/\n?$/, '\n'), 'utf8');
}
`

function editorEnvironment(directory: string): NodeJS.ProcessEnv {
  const command = `${quoteEditorPath(process.execPath)} ${quoteEditorPath(path.join(directory, stateDirectory, 'editor.cjs'))}`
  return { GIT_SEQUENCE_EDITOR: `${command} sequence`, GIT_EDITOR: `${command} message`, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0' }
}

async function readStored(directory: string): Promise<StoredPlan | undefined> {
  const file = path.join(directory, stateDirectory, 'plan.json')
  if (!(await exists(file))) return undefined
  let stored: StoredPlan
  try { stored = JSON.parse(await readFile(file, 'utf8')) as StoredPlan } catch {
    throw new Error('GitPeek Rebase 状态文件无法读取，请在终端检查当前 Git 状态。')
  }
  const plan = stored?.plan
  if (!stored || typeof stored !== 'object' || stored.version !== 1 || typeof stored.backupRef !== 'string' || !backupPattern.test(stored.backupRef)
    || !plan || typeof plan !== 'object' || typeof plan.head !== 'string' || !hashPattern.test(plan.head)
    || typeof plan.branch !== 'string' || !plan.branch || /[\0\r\n]/.test(plan.branch)
    || (plan.base !== undefined && (typeof plan.base !== 'string' || !hashPattern.test(plan.base))) || typeof plan.published !== 'boolean'
    || !plan.repo || typeof plan.repo.root !== 'string' || typeof plan.repo.id !== 'string'
    || !Array.isArray(plan.commits) || !plan.commits.length || plan.commits.length > 200
    || plan.commits.some(commit => !commit || typeof commit !== 'object' || typeof commit.hash !== 'string' || !hashPattern.test(commit.hash)
      || typeof commit.subject !== 'string' || typeof commit.message !== 'string' || commit.message.includes('\0'))
    || new Set(plan.commits.map(commit => commit.hash)).size !== plan.commits.length || plan.commits.at(-1)?.hash !== plan.head) {
    throw new Error('GitPeek Rebase 状态文件无效，请在终端检查当前 Git 状态。')
  }
  stored.steps = validateRebaseSteps(stored.plan, stored.steps)
  return stored
}

async function ownsRebase(active: string, stored: StoredPlan): Promise<boolean> {
  const marker = path.join(active, 'gitpeek-backup-ref')
  if (!(await exists(marker))) return false
  const [originalHead, headName, backupRef] = await Promise.all([readFile(path.join(active, 'orig-head'), 'utf8'), readFile(path.join(active, 'head-name'), 'utf8'), readFile(marker, 'utf8')])
  return originalHead.trim() === stored.plan.head && headName.trim() === `refs/heads/${stored.plan.branch}` && backupRef === stored.backupRef
}

async function cleanStored(directory: string): Promise<void> {
  const ownDirectory = path.join(directory, stateDirectory)
  for (const name of ['editor.cjs', 'plan.json']) {
    try { await unlink(path.join(ownDirectory, name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await rmdir(ownDirectory)
}

export async function readRebaseState(git: GitService, repo: Repository): Promise<RebaseState | undefined> {
  const directory = await gitDirectory(git, repo)
  const active = await nativeRebase(directory)
  if (!active) return undefined
  const stored = await readStored(directory)
  if (!stored || !(await ownsRebase(active, stored))) return { status: 'paused', message: '当前 Rebase 由其他工具发起，请使用原工具或终端继续、中止。' }
  return { status: 'paused', backupRef: stored.backupRef, message: 'Rebase 已暂停；请解决冲突并暂存，或完成提交编辑后继续。' }
}

export async function readGitOperation(git: GitService, repo: Repository): Promise<GitOperation | undefined> {
  const directory = await gitDirectory(git, repo)
  let kind: GitOperation['kind'] | undefined
  if (await nativeRebase(directory)) kind = 'rebase'
  else for (const [marker, operation] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    if (await exists(path.join(directory, marker))) { kind = operation; break }
  }
  if (!kind) return undefined
  const output = await git.run(repo, ['ls-files', '--unmerged', '-z'])
  const conflicts = [...new Set(output.split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\t') + 1)))]
  return { kind, conflicts, ...(kind === 'rebase' ? { rebase: await readRebaseState(git, repo) } : {}) }
}

export async function listRebaseBackups(git: GitService, repo: Repository): Promise<RebaseBackup[]> {
  const output = await git.run(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(committerdate:iso-strict)%00%(subject)', 'refs/gitpeek/rebase/'])
  return output.split('\n').flatMap(line => {
    const [ref, head, type, date, subject] = line.replace(/\r$/, '').split('\0')
    return backupPattern.test(ref) && hashPattern.test(head) && type === 'commit' ? [{ ref, head, date, subject }] : []
  })
}

export async function compareRebaseBackup(git: GitService, repo: Repository, backup: RebaseBackup): Promise<RebaseBackupComparison> {
  if (!backupPattern.test(backup.ref) || !hashPattern.test(backup.head)) throw new Error('Rebase 备份引用无效。')
  const [head, backupHead] = await Promise.all([
    git.run(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).then(value => value.trim()),
    git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${backup.ref}^{commit}`]).then(value => value.trim()),
  ])
  if (!hashPattern.test(head) || backupHead !== backup.head) throw new Error('HEAD 或备份已变化，请重新选择备份。')
  const [names, stats] = await Promise.all([
    git.run(repo, ['diff', '--name-status', '-z', '-M', head, backup.head, '--']),
    git.run(repo, ['diff', '--numstat', '-z', '-M', head, backup.head, '--']),
  ])
  const counts = parseNumStat(stats)
  return { repo, backup, head, files: parseNameStatus(names).map(file => ({ ...file, ...counts.get(file.path) })) }
}

export async function createRecoveryBranch(git: GitService, comparison: RebaseBackupComparison, name: string): Promise<void> {
  const { repo, backup, head } = comparison
  if (!backupPattern.test(backup.ref) || !hashPattern.test(backup.head) || !hashPattern.test(head)) throw new Error('恢复比较快照无效。')
  if (!name || name.startsWith('-') || /[\0\r\n]/.test(name)) throw new Error('请输入有效的新分支名称。')
  await guarded(repo, async () => {
    if ((await git.run(repo, ['check-ref-format', '--branch', name])).trim() !== name) throw new Error('恢复分支名称不能使用分支切换简写。')
    const [currentHead, currentBackup] = await Promise.all([
      git.run(repo, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']),
      git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${backup.ref}^{commit}`]),
    ])
    if (currentHead.trim() !== head || currentBackup.trim() !== backup.head) throw new Error('HEAD 或备份已变化，请先重新比较。')
    await git.run(repo, ['branch', '--', name, backup.head])
  })
}

async function guarded<T>(repo: Repository, operation: () => Promise<T>): Promise<T> {
  const root = await realpath(repo.root)
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  if (busy.has(key)) throw new Error('此仓库的 Rebase 操作正在执行，请稍候。')
  busy.add(key)
  try { return await operation() } finally { busy.delete(key) }
}

async function runRebase(git: GitService, repo: Repository, directory: string, stored: StoredPlan, args: string[], completed: 'completed' | 'aborted' = 'completed'): Promise<RebaseState> {
  let failure: unknown
  try { await git.run(repo, [...rebaseConfig, 'rebase', ...args], { env: editorEnvironment(directory), timeoutMs: 120_000 }) } catch (error) { failure = error }
  const active = await nativeRebase(directory)
  if (active) return { status: 'paused', backupRef: stored.backupRef, message: failure instanceof Error ? failure.message : 'Rebase 已暂停，请完成提交编辑或解决冲突后继续。' }
  await cleanStored(directory)
  if (failure) throw new Error(`${failure instanceof Error ? failure.message : String(failure)}\n原提交已备份到 ${stored.backupRef}。`)
  return { status: completed, backupRef: stored.backupRef }
}

export async function startRebase(git: GitService, plan: RebasePlan, input: unknown): Promise<RebaseState> {
  return guarded(plan.repo, async () => {
    const steps = validateRebaseSteps(plan, input)
    const fresh = await loadRebasePlan(git, plan.repo, plan.commits[0].hash)
    if (fresh.head !== plan.head || fresh.branch !== plan.branch || fresh.base !== plan.base || (!plan.published && fresh.published) || fresh.commits.map(commit => commit.hash).join() !== plan.commits.map(commit => commit.hash).join()) {
      throw new Error('当前分支、HEAD 或发布状态已改变，整理计划已过期，请重新加载并确认。')
    }
    await assertClean(git, plan.repo)
    const directory = await gitDirectory(git, plan.repo)
    if (await readStored(directory)) await cleanStored(directory)
    const ownDirectory = path.join(directory, stateDirectory)
    await mkdir(ownDirectory)
    const backupRef = `refs/gitpeek/rebase/${randomUUID()}`
    const stored: StoredPlan = { version: 1, plan: fresh, steps, backupRef }
    try {
      await git.run(plan.repo, ['update-ref', backupRef, plan.head, '0'.repeat(plan.head.length)])
      await writeFile(path.join(ownDirectory, 'plan.json'), JSON.stringify(stored), 'utf8')
      await writeFile(path.join(ownDirectory, 'editor.cjs'), editorSource, 'utf8')
      await assertNoOperation(directory)
      await assertClean(git, plan.repo)
      const [head, branch, published] = await Promise.all([
        git.run(plan.repo, ['rev-parse', '--verify', 'HEAD']),
        git.run(plan.repo, ['branch', '--show-current']),
        git.run(plan.repo, ['for-each-ref', `--contains=${fresh.commits[0].hash}`, '--format=%(refname)', 'refs/remotes/']),
      ])
      if (head.trim() !== plan.head || branch.trim() !== plan.branch || (!plan.published && published.trim())) throw new Error('当前分支、HEAD 或发布状态已改变，请重新加载并确认整理计划。')
    } catch (error) {
      await cleanStored(directory)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n如已创建备份，它位于 ${backupRef}。`)
    }
    return runRebase(git, plan.repo, directory, stored, ['--interactive', '--no-autostash', '--no-update-refs', '--no-autosquash', '--no-rebase-merges', '--no-fork-point', '--keep-empty', '--empty=stop', '--reapply-cherry-picks', ...(plan.base ? [plan.base] : ['--root'])])
  })
}

async function resumeRebase(git: GitService, repo: Repository, action: '--continue' | '--abort'): Promise<RebaseState> {
  return guarded(repo, async () => {
    const directory = await gitDirectory(git, repo)
    const active = await nativeRebase(directory)
    if (!active) throw new Error('当前没有正在进行的 Rebase。')
    const stored = await readStored(directory)
    if (!stored || !(await ownsRebase(active, stored))) throw new Error('此 Rebase 不是 GitPeek 发起的，请使用原工具或终端继续、中止。')
    return runRebase(git, repo, directory, stored, [action], action === '--abort' ? 'aborted' : 'completed')
  })
}

export function continueRebase(git: GitService, repo: Repository): Promise<RebaseState> { return resumeRebase(git, repo, '--continue') }
export function abortRebase(git: GitService, repo: Repository): Promise<RebaseState> { return resumeRebase(git, repo, '--abort') }
