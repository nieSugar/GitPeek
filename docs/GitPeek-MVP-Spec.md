# GitPeek MVP 规格说明

> 一个轻量、Context-first 的 VS Code Git 插件。  
> 核心目标：**围绕当前正在看的代码，快速告诉我：谁改的、什么时候改的、为什么改、当前分支改了什么。**

---

## 1. 产品定位

GitPeek 不试图成为另一个 GitLens，也不追求覆盖 Git 的全部能力。

它只解决高频、上下文相关的问题：

- 当前这行代码是谁改的？
- 当前文件最近改过什么？
- 这个 Commit 到底改了哪些文件？
- 当前分支相比主分支改了什么？
- 当前选中的代码来自哪些 Commit？
- 提交前我到底改了什么？
- 能不能快速生成一个合理的 Commit Message？

核心原则：

> **不要让我去找 Git 信息，把跟当前代码相关的 Git 信息直接给我。**

---

## 2. MVP 功能范围

| 功能 | MVP | 优先级 |
|---|---:|---:|
| Current Line Blame | ✅ | P0 |
| File History | ✅ | P0 |
| Commit Detail | ✅ | P0 |
| Branch vs Base | ✅ | P0 |
| Selection Origins | ✅ | P0 |
| Review Changes | ✅ | P0 |
| Smart Commit Message | ✅ | P1 |
| Git Graph | ❌ | 后续 |
| PR / GitHub | ❌ | 后续 |
| Rebase UI | ❌ | 后续 |
| Stash Manager | ❌ | 后续 |
| AI Chat | ❌ | 后续 |

---

## 3. MVP 最终 UI 形态

尽可能使用 VS Code 原生能力，不自己造复杂 WebView。

主要使用：

```text
TreeView
QuickPick
Hover
StatusBarItem
TextEditorDecorationType
vscode.diff
Command Palette
TextDocumentContentProvider
```

整体结构：

```text
┌──────────────── VS Code ────────────────┐

 editor

 const unit = config[device]?.unit || '℃'

                         History    Diff

             nieSugar · 3 days ago · abc123

──────────────────────────────────────────

 Sidebar
 GitPeek

 CURRENT BRANCH
 feature/device-config
 ↑ 3  ↓ 0
 vs main

 CHANGES
 5 files
 +126 -48

 RECENT COMMITS
 abc123 refactor: extract config
 def456 fix: temperature unit
 ...

──────────────────────────────────────────

 Status Bar

 $(git-branch) feature/device-config ↑3 ↓0
 $(git-compare) 5 changed
```

---

# 4. Current Line Blame

这是 MVP 最重要的能力。

光标停在某一行后，只给当前行显示轻量 blame：

```text
nieSugar · 3 days ago · refactor: extract device config
```

不要给整个编辑器铺满 blame。

## Hover 信息

鼠标悬浮后显示：

```text
nieSugar
Sep 23, 2026 14:32

refactor: extract device temperature configuration

abc1234

View Commit
View Diff
Copy Commit Hash
```

## Git 命令

```bash
git blame --line-porcelain -L 23,23 -- src/config/device.ts
```

## 数据结构

```ts
interface BlameInfo {
  hash: string
  author: string
  authorEmail?: string
  authorTime: number
  summary: string
  line: number
}
```

## 未提交内容

如果 Git 返回：

```text
000000000000000...
```

或者：

```text
Not Committed Yet
```

显示：

```text
You · uncommitted changes
```

如果当前文档有未保存内容：

```ts
document.isDirty === true
```

MVP 暂时不计算 blame，显示：

```text
Unsaved changes
```

避免编辑器内容与磁盘文件发生行号错位。

---

# 5. File History

编辑器右上角提供：

```text
$(history)
```

Tooltip：

```text
GitPeek: File History
```

点击后在 GitPeek Sidebar 显示：

```text
FILE HISTORY

src/views/KM3B/index.vue

● abc123
  refactor: extract temperature config
  nieSugar · Sep 23

● a13db2
  fix: temperature unit
  nieSugar · Sep 22

● e410ab
  feat: add KM3B dashboard
  nieSugar · Sep 10
```

默认展示最近 20 个 Commit。

底部：

```text
Load More
```

## Git 命令

```bash
git log \
--follow \
--date=iso-strict \
--pretty=format:"%H%x1f%an%x1f%ae%x1f%ad%x1f%s" \
-- src/views/KM3B/index.vue
```

## 数据结构

```ts
interface CommitInfo {
  hash: string
  shortHash: string
  author: string
  email?: string
  date: Date
  subject: string
}
```

使用 `--follow`，保证文件重命名后仍能追踪历史。

---

# 6. Commit Detail

点击任意 Commit 后显示：

```text
COMMIT

abc1234
refactor: extract temperature config

nieSugar
Sep 23, 2026 14:32

FILES CHANGED

M src/config/device.ts       +24 -3
M src/views/KM3B/index.vue   +12 -10
M src/views/Overview.vue     +18 -4

TOTAL

3 files
+54 -17
```

点击某个文件后直接打开 VS Code 原生 Diff。

## Git 命令

文件统计：

```bash
git show \
--format= \
--numstat \
--find-renames \
abc123
```

文件状态：

```bash
git diff-tree \
--no-commit-id \
-r \
--name-status \
-M \
abc123
```

## 数据结构

```ts
interface CommitFile {
  path: string
  oldPath?: string

  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'

  additions?: number
  deletions?: number
}
```

---

# 7. Diff 实现

不要自己造 Diff 编辑器。

直接调用：

```ts
vscode.commands.executeCommand(
  'vscode.diff',
  oldUri,
  newUri,
  title
)
```

通过自定义 URI：

```text
gitpeek://abc123^/src/config/device.ts
gitpeek://abc123/src/config/device.ts
```

实现：

```ts
TextDocumentContentProvider
```

内部执行：

```bash
git show abc123^:src/config/device.ts
```

和：

```bash
git show abc123:src/config/device.ts
```

这样直接使用 VS Code 原生 Diff。

---

# 8. Branch vs Base

状态栏：

```text
$(git-branch) feature/device-config ↑3 ↓0
```

点击后：

```text
COMPARE

feature/device-config
       ↓
main

COMMITS

3 ahead
0 behind

COMMITS

abc123 refactor: extract device config
def456 fix: KM3B unit mapping
d231ab feat: support temperature config

FILES CHANGED

M src/config/device.ts
M src/views/KM3B.vue
M src/views/Overview.vue

5 files

+126
-48
```

目标只有一个：

> 当前分支相比主分支到底改了什么？

MVP 不做 Git Graph。

---

# 9. Base Branch 自动识别

配置：

```json
{
  "gitpeek.baseBranch": "auto"
}
```

自动模式：

```bash
git symbolic-ref refs/remotes/origin/HEAD
```

可能返回：

```text
refs/remotes/origin/main
```

解析得到：

```text
main
```

如果失败，依次判断：

```text
main
master
develop
```

用户也可以手动配置：

```json
{
  "gitpeek.baseBranch": "develop"
}
```

---

# 10. Ahead / Behind

执行：

```bash
git rev-list \
--left-right \
--count \
main...HEAD
```

例如：

```text
0    3
```

表示：

```text
behind 0
ahead 3
```

状态栏：

```text
feature/device-config ↑3 ↓0
```

---

# 11. Branch Changed Files

执行：

```bash
git diff --name-status main...HEAD
```

统计：

```bash
git diff --shortstat main...HEAD
```

详细：

```bash
git diff --numstat main...HEAD
```

展示：

```text
CHANGED FILES

src
 ├─ config
 │   └─ device.ts          +24 -3
 │
 └─ views
     ├─ KM3B.vue           +12 -10
     └─ Overview.vue       +18 -4
```

点击文件后打开：

```text
base branch
vs
current branch
```

的原生 VS Code Diff。

---

# 12. Selection Origins

用户选中：

```ts
function getTemperatureUnit(device) {
  return deviceConfig[device]?.unit || '℃'
}
```

右键：

```text
GitPeek: Selection Origins
```

执行：

```bash
git blame \
--line-porcelain \
-L 30,35 \
src/config/device.ts
```

然后按 Commit 聚合：

```text
SELECTION ORIGINS

Lines 30 - 35

abc123   4 lines
refactor: extract device configuration
nieSugar · Sep 23

def456   2 lines
fix: temperature fallback
nieSugar · Sep 22
```

点击 Commit 后进入 Commit Detail。

## MVP 边界

第一版只解决：

> 当前这些代码分别来自哪些 Commit？

不做完整代码演进历史。

暂时不做：

```bash
git log -L 30,35:file.ts
```

因为函数移动、重命名、大范围重构、Merge 等情况复杂度明显更高。

---

# 13. Review Changes

Command Palette：

```text
GitPeek: Review Changes
```

显示：

```text
CHANGES

STAGED

M src/config/device.ts       +24 -3
M src/views/KM3B.vue         +12 -10

UNSTAGED

M src/views/Overview.vue     +18 -4

UNTRACKED

? notes.md

SUMMARY

3 modified
1 untracked

+54
-17
```

目标：

> Commit 前快速确认自己到底改了什么。

---

# 14. Review 警告

MVP 可以做一些低成本检查：

```text
console.log
debugger
TODO
FIXME
.env
*.pem
```

展示：

```text
WARNINGS

⚠ console.log
src/views/KM3B.vue:126

⚠ TODO
src/config/device.ts:44
```

第一版只提醒，不阻止提交。

---

# 15. Smart Commit Message

第一版不依赖 AI。

Command：

```text
GitPeek: Generate Commit Message
```

分析：

```bash
git diff --cached --name-status
```

例如：

```text
M src/config/device.ts
M src/views/KM3B.vue
M src/views/Overview.vue
```

生成几个候选：

```text
refactor(device): update device configuration

fix(device): update device configuration

feat(device): update device configuration
```

用户选择后自动写入 VS Code SCM Commit 输入框。

## 默认类型

```text
feat
fix
refactor
perf
docs
test
style
chore
```

配置：

```json
{
  "gitpeek.commit.conventional": true
}
```

关闭后：

```text
Update device configuration
```

---

# 16. Sidebar 最终结构

```text
GITPEEK

REPOSITORY

812
feature/device-config
↑3 ↓0

CHANGES

4 changed files

BRANCH CHANGES

3 commits
5 files

FILE HISTORY

KM3B.vue
20 commits
```

不要加入：

```text
Branches
Remotes
Tags
Stashes
Worktrees
Repositories
Contributors
Pull Requests
Issues
Graphs
```

MVP 保持极简。

---

# 17. Editor 入口

编辑器右上角只保留两个主要按钮。

## File History

```text
$(history)
```

## Compare with Base

```text
$(git-compare)
```

选中文本后右键：

```text
GitPeek: Selection Origins
```

Current Line Blame 自动工作，不需要按钮。

---

# 18. Status Bar

底部：

```text
$(git-branch) feature/device-config ↑3 ↓0
```

以及：

```text
$(git-compare) 5 changed
```

点击 Branch：

```text
Branch Compare
```

点击 changed：

```text
Review Changes
```

---

# 19. Command Palette

MVP 保持在 8 个命令以内：

```text
GitPeek: File History
GitPeek: Blame Current Line
GitPeek: Selection Origins
GitPeek: Compare with Base
GitPeek: Show Branch Changes
GitPeek: Review Changes
GitPeek: Generate Commit Message
GitPeek: Refresh
```

---

# 20. Settings

```json
{
  "gitpeek.enabled": true,
  "gitpeek.blame.enabled": true,
  "gitpeek.blame.delay": 300,
  "gitpeek.history.limit": 20,
  "gitpeek.baseBranch": "auto",
  "gitpeek.commit.conventional": true,
  "gitpeek.commit.defaultType": "chore"
}
```

MVP 设置项尽量不超过 10 个。

---

# 21. 技术架构

总体架构：

```text
VS Code Extension
        │
        ▼
GitPeek Services
        │
        ▼
Git CLI
```

MVP 直接使用系统 Git：

```ts
child_process.execFile('git', args)
```

暂时不引入：

```text
libgit2
isomorphic-git
simple-git
```

原因：

- 用户已经安装 Git
- 行为可预测
- 依赖少
- 插件体积小
- 调试成本低

---

# 22. Repository Resolver

需要支持多仓库 Workspace。

当前文件属于哪个 Repo：

```bash
git -C <file-dir> rev-parse --show-toplevel
```

例如：

```text
E:\github\812
```

缓存：

```ts
Map<string, Repository>
```

---

# 23. GitService

```ts
class GitService {

  exec(
    repo: Repository,
    args: string[]
  ): Promise<string>

  status(repo): Promise<GitStatus>

  blame(
    repo,
    file,
    startLine,
    endLine
  ): Promise<BlameInfo[]>

  fileHistory(
    repo,
    file
  ): Promise<CommitInfo[]>

  commit(
    repo,
    hash
  ): Promise<CommitDetail>

  compare(
    repo,
    base,
    head
  ): Promise<BranchComparison>
}
```

所有 Git 调用集中在 Git 层。

其他业务模块不要直接调用：

```ts
execFile('git')
```

---

# 24. Service 分层

```text
GitService
       │
       ├── RepositoryService
       ├── BlameService
       ├── HistoryService
       ├── CommitService
       ├── CompareService
       └── ChangeReviewService
```

职责：

## GitService

负责：

- Git 命令执行
- 基础输出解析
- 错误标准化

## Services

负责：

- 业务规则
- 缓存
- 数据组合
- UI 所需模型转换

---

# 25. 推荐目录结构

```text
gitpeek/

├─ src/
│
│  ├─ extension.ts
│
│  ├─ commands/
│  │  ├─ blameCurrentLine.ts
│  │  ├─ fileHistory.ts
│  │  ├─ selectionOrigins.ts
│  │  ├─ compareWithBase.ts
│  │  ├─ reviewChanges.ts
│  │  └─ generateCommitMessage.ts
│
│  ├─ git/
│  │  ├─ GitService.ts
│  │  ├─ GitParser.ts
│  │  ├─ RepositoryService.ts
│  │  └─ types.ts
│
│  ├─ services/
│  │  ├─ BlameService.ts
│  │  ├─ HistoryService.ts
│  │  ├─ CommitService.ts
│  │  ├─ CompareService.ts
│  │  ├─ BaseBranchService.ts
│  │  ├─ ChangeReviewService.ts
│  │  └─ CommitMessageService.ts
│
│  ├─ providers/
│  │  ├─ GitPeekTreeProvider.ts
│  │  ├─ GitContentProvider.ts
│  │  └─ BlameDecorationProvider.ts
│
│  ├─ ui/
│  │  ├─ StatusBarController.ts
│  │  ├─ EditorController.ts
│  │  └─ QuickPickController.ts
│
│  ├─ cache/
│  │  └─ GitCache.ts
│
│  └─ utils/
│      ├─ path.ts
│      ├─ debounce.ts
│      └─ logger.ts
│
├─ resources/
│  └─ gitpeek.svg
│
├─ package.json
├─ tsconfig.json
├─ esbuild.js
└─ README.md
```

---

# 26. 核心数据模型

```ts
export interface Repository {
  root: string
}

export interface CommitInfo {
  hash: string
  shortHash: string

  author: string
  email?: string

  date: number

  subject: string
}

export interface BlameInfo {
  hash: string

  author: string

  date: number

  summary: string

  originalLine: number

  currentLine: number
}

export interface FileChange {
  path: string

  oldPath?: string

  status:
    | 'A'
    | 'M'
    | 'D'
    | 'R'

  additions?: number

  deletions?: number
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
```

---

# 27. Blame 性能设计

监听：

```ts
vscode.window.onDidChangeTextEditorSelection
```

不要立即运行 Git。

流程：

```text
用户移动光标
      ↓
等待 300ms
      ↓
用户没继续移动
      ↓
git blame
      ↓
缓存
      ↓
Decoration
```

默认：

```text
300ms debounce
```

---

# 28. Blame Cache

建议 Key：

```text
repo
file
commit
line
```

例如：

```text
E:\github\812
src/config/device.ts
HEAD
23
```

缓存时间：

```text
30 seconds
```

以下事件清理：

```ts
onDidSaveTextDocument
```

清除当前文件缓存。

Branch / HEAD 变化时清空 Repo 缓存。

---

# 29. History Cache

File History 建议缓存：

```text
60 seconds
```

当 Repository HEAD 变化时失效。

---

# 30. Git Command 安全

不要：

```ts
exec(`git blame ${filename}`)
```

一定使用：

```ts
execFile(
  'git',
  [
    'blame',
    '--line-porcelain',
    '-L',
    `${start},${end}`,
    '--',
    file
  ]
)
```

避免路径中出现：

```text
空格
&
;
"
'
```

导致的问题。

---

# 31. Git 命令超时

建议普通操作：

```text
5 seconds
```

大型仓库：

```text
10 seconds
```

超时后：

```text
GitPeek: Git operation timed out.
```

不要无限 loading。

---

# 32. 大文件保护

例如文件：

```text
> 2 MB
```

或者：

```text
> 20,000 lines
```

默认关闭自动 inline blame。

显示：

```text
GitPeek blame disabled for large file.
```

---

# 33. Root Commit Diff

如果是仓库第一个 Commit：

```text
abc123^
```

不存在。

此时：

```text
oldContent = ''
```

new：

```bash
git show abc123:file
```

Diff：

```text
empty
→
file
```

---

# 34. Deleted File

Commit：

```text
D src/foo.ts
```

new：

```text
''
```

old：

```bash
git show abc123^:src/foo.ts
```

---

# 35. Added File

Commit：

```text
A src/foo.ts
```

old：

```text
''
```

new：

```bash
git show abc123:src/foo.ts
```

---

# 36. Rename

例如：

```text
R100

src/config.ts
→
src/config/device.ts
```

数据：

```ts
{
  status: 'R',
  oldPath: 'src/config.ts',
  path: 'src/config/device.ts'
}
```

Diff：

```text
parent oldPath
vs
commit newPath
```

MVP 就应该正确处理 Rename。

---

# 37. Error UX

自动功能尽量静默失败。

例如：

```text
fatal: not a git repository
```

自动 blame 时：

```text
静默
```

用户主动执行 Command 时才提示：

```text
GitPeek: This file is not inside a Git repository.
```

避免频繁弹错误框。

---

# 38. Logging

增加：

```text
Output
→ GitPeek
```

示例：

```text
[GitPeek]

repo resolved:
E:\github\812

blame:
src/config/device.ts:23

duration:
42ms
```

默认不主动打开。

---

# 39. UX 一致性

用户点击 Commit：

```text
abc123
```

永远进入：

```text
Commit Detail
```

点击文件：

```text
device.ts
```

永远进入：

```text
Diff
```

点击 Branch：

```text
feature/device-config
```

永远进入：

```text
Branch Compare
```

交互保持统一。

---

# 40. MVP 明确不做

第一版不做：

```text
Git Graph
GitHub API
GitLab API
Pull Requests
Issues
Interactive Rebase
Cherry Pick UI
Merge UI
Conflict Editor
Worktrees
Tags
Remote Manager
Stash Manager
Repository Explorer
AI Chat
Cloud Sync
Account
Telemetry
```

这些全部推迟。

---

# 41. MVP 用户完整工作流

1. 用户打开代码文件。
2. 光标停在某一行。
3. 300ms 后出现轻量 blame。
4. 点击 blame 可进入 Commit Detail。
5. 点击编辑器右上角 History 查看当前文件历史。
6. 点击历史 Commit 查看 Commit Detail。
7. 点击 Commit 中的文件打开原生 Diff。
8. 选中代码后执行 Selection Origins。
9. 查看选中代码分别来自哪些 Commit。
10. 点击状态栏 Branch。
11. 查看当前分支相对 Base Branch 的 ahead / behind、Commits 和 Changed Files。
12. 点击 Changed File 打开 Diff。
13. Commit 前执行 Review Changes。
14. 查看 staged、unstaged、untracked 和风险提示。
15. 执行 Generate Commit Message。
16. 选择候选 Commit Message。
17. 自动写入 VS Code SCM 输入框。

---

# 42. 开发顺序

```text
Phase 1
GitService
RepositoryService

        ↓

Phase 2
Current Line Blame

        ↓

Phase 3
File History

        ↓

Phase 4
Commit Detail + Diff

        ↓

Phase 5
Branch Compare

        ↓

Phase 6
Selection Origins

        ↓

Phase 7
Review Changes

        ↓

Phase 8
Smart Commit

        ↓

Phase 9
性能、缓存、错误处理

        ↓

v0.1.0
```

---

# 43. v0.1.0 验收标准

## Repository

```text
✓ 自动识别 repository
✓ 支持多 repository workspace
✓ 非 Git 项目不异常
```

## Current Line Blame

```text
✓ 光标停止后约 300ms 显示 blame
✓ 只显示当前行
✓ Hover 能看到 Commit 基本信息
✓ 点击能进入 Commit Detail
✓ 未保存文件不产生错误 blame
```

## File History

```text
✓ 正确展示当前文件历史
✓ 支持文件 rename 历史
✓ 默认限制 20 条
✓ 支持 Load More
```

## Commit Detail

```text
✓ 正确显示作者
✓ 正确显示时间
✓ 正确显示 Commit Message
✓ 正确显示 Changed Files
✓ 正确显示 additions/deletions
✓ Added / Deleted / Rename 正确处理
```

## Diff

```text
✓ 使用 VS Code 原生 Diff
✓ Commit 文件 Diff 正确
✓ Branch 文件 Diff 正确
✓ Root Commit 正确
✓ Rename 正确
```

## Branch Compare

```text
✓ 自动识别 Base Branch
✓ 正确显示 ahead / behind
✓ 正确显示 Branch Commits
✓ 正确显示 Changed Files
✓ 点击文件打开 Diff
```

## Selection Origins

```text
✓ 能分析选中代码
✓ 能聚合 Commit
✓ 能显示每个 Commit 影响的行数
✓ 点击 Commit 进入 Commit Detail
```

## Review Changes

```text
✓ staged
✓ unstaged
✓ untracked
✓ additions / deletions
✓ console.log 检查
✓ debugger 检查
✓ TODO / FIXME 检查
```

## Smart Commit

```text
✓ 至少生成 3 个候选
✓ 支持 Conventional Commit
✓ 能写入 SCM Commit Input
```

## Performance

```text
✓ 普通仓库移动光标不卡顿
✓ Git 命令有超时
✓ Blame 有缓存
✓ History 有缓存
✓ 大文件有保护
```

---

# 44. README 定位文案

英文：

> **GitPeek is a lightweight, context-first Git extension for VS Code.**
>
> Understand the code you're looking at without navigating through complex Git interfaces.
>
> See who changed a line, inspect file history, understand branch changes, trace selected code to its commits, and review your work before committing.

中文：

> **GitPeek 是一个轻量、Context-first 的 VS Code Git 插件。**
>
> 不需要进入复杂的 Git 页面，就能直接理解你当前正在看的代码。
>
> 查看某行是谁修改的、当前文件历史、当前分支变化、选中代码对应的 Commit，以及提交前的完整改动。

---

# 45. 核心产品原则

开发过程中始终问一个问题：

> **这个功能是否能帮助我理解“我现在正在看的代码”？**

如果答案是否定的，就不要优先加入 MVP。

GitPeek 的目标不是：

> 做一个功能更多的 GitLens。

而是：

> 做一个更轻、更快、更直接、更符合个人开发习惯的 Git 工具。

---

# 46. MVP 版本定义

版本：

```text
v0.1.0
```

完成之后应该已经可以作为日常开发插件长期使用，而不是 Demo。

后续版本再考虑：

```text
v0.2
Selection History

v0.3
Stash Lite

v0.4
AI Commit Summary

v0.5
GitHub PR Context

v1.0
稳定版
```

但在 v0.1.0 阶段，重点只有：

```text
Line
File
Commit
Branch
Selection
Changes
Commit Message
```

七个核心上下文。
