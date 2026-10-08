# GitPeek v0.1.0 开发计划清单

- 创建日期：2026-09-28。
- 需求基准：[GitPeek MVP 规格说明](./GitPeek-MVP-Spec.md)。
- 目标：交付可日常使用的轻量、Context-first VS Code Git 插件。
- v0.1.0 状态：功能实现、自动检查及 Windows 实际 UI 自检完成；等待用户最终验收，计划暂不归档。
- 更新方式：完成实现并通过相应验收后再勾选任务，记录必要的验证结果和未验证边界。
- 2026-09-30 补充：文末新增阶段 10–14 的后续优化计划；阶段 0–9、命令核对表与 MVP 排除项保留为 v0.1.0 的历史基线。

## 范围与执行原则

- P0：Current Line Blame、File History、Commit Detail、Branch vs Base、Selection Origins、Review Changes。
- P1：Smart Commit Message，仍属于 v0.1.0 的交付范围。
- 优先原生 VS Code UI 和系统 Git，通过 `execFile('git', args)` 集中执行 Git 命令。
- 按实际需要建立模块，复用已有能力；规格中的推荐目录无需提前全部搭建。
- 先打通“代码 → Commit → Diff”，历史、选区来源和分支对比复用同一套详情与 Diff 能力。
- 多仓库标识贯穿命令、Tree 节点、缓存、Diff URI 和 SCM 输入，避免同名文件串数据。
- 超时、过期请求处理和缓存失效随功能实现；最后阶段负责整体验收。
- 本计划补充的边界处理属于开发与验收安排，不修改归档的 MVP 原文。

## 阶段 0：工程初始化

- [x] 初始化 Git 仓库，建立 TypeScript、esbuild、VS Code Extension 基础工程。
- [x] 配置编译、类型检查、调试和本地 VSIX 打包命令。
- [x] 添加最小扩展入口、GitPeek 图标、Output 日志通道。
- [x] 确定最低支持的 VS Code 版本，配置对应类型与运行环境。
- [x] 提前验证：能通过内置 Git 扩展定位指定仓库的 SCM Commit 输入框。

**验收条件**：在 Extension Development Host 中成功加载扩展，能够调试、查看日志和完成本地打包。

**执行记录**：`npm install`、`npm run check`、`npm run build`、`npm run package` 通过；VS Code 最低版本为 1.96。隔离的 Extension Development Host 成功激活 GitPeek，并在双仓库 Workspace 中定位两个 SCM 输入框、写入测试值后恢复原值；已添加可用的调试配置。

## 阶段 1：GitService 与仓库上下文

- [x] 统一数据模型，解决规格中时间类型、Blame 字段和文件状态命名不一致的问题。
- [x] 集中封装 `execFile('git', args)`，处理超时、错误和执行耗时；禁止拼接 shell 命令，路径参数按命令规则使用 `--` 分隔。
- [x] 实现当前文件所属仓库识别与缓存，支持多仓库 Workspace。
- [x] 让命令参数、Tree 节点、缓存和 Diff URI 携带明确的仓库标识。
- [x] 处理 Git 不可用、非 Git 文件、空仓库及无活动编辑器的情况；需要选择仓库时使用原生 QuickPick。
- [x] 实现状态、提交信息、文件状态和增删行统计的基础解析。
- [x] 用临时真实 Git 仓库验证解析，覆盖中文、空格及特殊字符路径、Rename。

**验收条件**：能够准确读取两个仓库的数据；Git 调用有超时，异常不会导致扩展失效。

**执行记录**：临时仓库检查通过，覆盖双仓库、嵌套仓库、空仓库、中文与特殊字符路径、Rename 及增删行统计；命令、Tree、缓存、Diff URI 已按仓库隔离，主动命令有空状态和错误提示。

## 阶段 2：Current Line Blame

- [x] 监听编辑器和光标变化，默认采用 `300 ms` debounce。
- [x] 仅在当前行显示作者、相对时间和提交摘要。
- [x] 实现 Hover，展示作者、时间、Hash 和完整摘要。
- [x] 未提交行显示 `You · uncommitted changes`。
- [x] 未保存文档停止查询并显示 `Unsaved changes`。
- [x] 丢弃光标移动、切换文件或编辑内容后过期的异步结果。
- [x] 实现约 `30 s` 缓存、保存失效及 HEAD／分支变化失效。
- [x] 对超过 `2 MB` 或 `20,000` 行的文件关闭自动 Blame，并展示对应状态。

**验收条件**：快速移动光标不频繁调用 Git，不出现旧结果覆盖新位置的问题；Commit 和 Diff 入口在阶段 4 接通。

**执行记录**：自动检查覆盖过期结果、未保存、大文件及暂存新增文件；Windows 编辑器确认当前行 Decoration、Hover 作者／时间／Hash／链接，重命名前行的 View Diff 正确打开根提交旧路径。

## 阶段 3：File History 与 Sidebar 基础

- [x] 建立原生 TreeView，采用 Repository、Changes、Branch Changes、File History 四个区域。
- [x] 添加编辑器 File History 按钮。
- [x] 使用 `--follow` 查询文件历史，正确追踪重命名。
- [x] 默认加载最近 `20` 条，支持 Load More。
- [x] 展示提交摘要、作者、日期和短 Hash。
- [x] 实现约 `60 s` 缓存，HEAD 变化和 Refresh 时失效。

**验收条件**：普通文件与重命名文件均能正确分页；切换仓库不会混入其他仓库的历史。

**执行记录**：自动检查覆盖分页、缓存、HEAD 失效和 Rename；Windows TreeView 显示重命名前的三条历史，点击 Commit 进入详情，暂存新增文件显示无历史空状态。

## 阶段 4：Commit Detail 与原生 Diff

- [x] 展示提交作者、时间、完整 Message、Changed Files 和增删行统计。
- [x] 实现 `TextDocumentContentProvider` 和包含仓库上下文的历史文件 URI。
- [x] 通过 `vscode.diff` 打开文件差异。
- [x] 正确处理 Root Commit、Added、Deleted 和 Rename：缺失的一侧使用空内容，Rename 对比父提交的 oldPath 与当前提交的 newPath。
- [x] 明确 Merge Commit 的父提交比较规则，以及二进制文件的展示方式。
- [x] 接通 Blame、Hover 和 File History 的 Commit Detail 入口。
- [x] 实现 View Diff、Copy Commit Hash，统一“点击 Commit 看详情、点击文件看 Diff”。

**验收条件**：上述边界均能打开正确内容；读取失败与“该侧文件不存在”能够区分。

**执行记录**：临时仓库检查通过 Root、Added、Deleted、Rename、二进制、Merge 第一父提交和读取失败；Windows 原生 Diff 实测 Rename 旧／新路径以及根提交空白 → 新文件，Diff 页签保留仓库上下文。

## 阶段 5：Branch vs Base

- [x] 实现 `gitpeek.baseBranch`，支持自动识别和手动指定。
- [x] 自动识别按 `origin/HEAD → main → master → develop`，保留实际可解析的引用。
- [x] 处理本地 Base 不存在、配置无效和无共同祖先的情况。
- [x] 展示当前分支、ahead／behind、分支提交和变更文件统计；`base...HEAD` 计数左侧为 behind、右侧为 ahead。
- [x] 文件清单、统计与文件 Diff 使用一致的三点比较基点：`merge-base(base, HEAD) → HEAD`。
- [x] 添加 Compare with Base 编辑器按钮及 Branch 状态栏入口。
- [x] 切换分支、外部提交和 Refresh 后更新相关数据。

**验收条件**：Base 与当前分支各自有新提交时，计数、文件清单和打开的 Diff 仍保持一致。

**执行记录**：真实分叉仓库检查通过 ahead／behind、共同祖先文件集、自动与无效 Base、无共同祖先；Windows 状态栏和 QuickPick 显示 ↑1／↓1，点击文件打开正确的分支 Diff，无效 Base 在侧边栏和状态栏显示错误。

## 阶段 6：Selection Origins

- [x] 添加选中文本的右键命令。
- [x] 正确转换选区行号，处理选区终点位于下一行行首的情况。
- [x] 对选中范围执行 Blame，按 Commit 聚合并统计行数。
- [x] 展示 Commit、作者、日期、摘要及对应行数。
- [x] 点击 Commit 进入统一的 Commit Detail。
- [x] 未保存文档沿用 Blame 的保护规则；未提交行单独展示。

**验收条件**：归属行数与实际分析范围一致，不把未提交内容当成可打开的历史 Commit。范围限定为来源分析，不实现 `git log -L` 完整演进历史。

**执行记录**：真实临时仓库检查通过多 Commit、未提交行、选区排他终点及中文特殊路径；Windows 右键入口对前两行显示两个 Commit、各 1 行，点击可进入 Commit Detail。

## 阶段 7：Review Changes

- [x] 分组展示 Staged、Unstaged、Untracked。
- [x] 展示文件状态、增删行和汇总信息。
- [x] 正确处理同一个文件同时存在暂存与未暂存改动。
- [x] 分别打开 `HEAD → index`、`index → 磁盘`、`空内容 → 新文件` 的 Diff。
- [x] 检查新增或修改内容中的 `console.log`、`debugger`、`TODO`、`FIXME`。
- [x] 对 `.env`、`*.pem` 等文件提供提醒，警告不阻止提交。
- [x] 添加 changed 状态栏入口，明确未保存内容不计入磁盘上的 Git 变更。

**验收条件**：三类变更都能准确查看；警告位置正确，不因删除旧代码产生误报。

**执行记录**：真实临时仓库检查通过双区同文件、三类 Diff、嵌套 Untracked、警告行号、敏感文件提醒和磁盘内容更新；Windows TreeView 实测 Staged、Unstaged、Untracked 各自的原生 Diff 和 `.env.local` 提醒。

## 阶段 8：Smart Commit Message

优先级为 P1，仍属于 v0.1.0 的交付范围。

- [x] 根据当前仓库的 Staged 文件生成候选，无需 AI。
- [x] 至少提供 `3` 个候选，支持 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`style`、`chore`。
- [x] 支持 Conventional Commits 开关和默认类型配置。
- [x] 使用原生 QuickPick 选择候选。
- [x] 将选中内容写入对应仓库的 SCM Commit 输入框。
- [x] 处理无 Staged 文件、内置 Git 扩展不可用及已有提交草稿的情况，避免静默覆盖草稿。

**验收条件**：在真实 VS Code 中验证 SCM 写入；多仓库场景必须写到用户操作的仓库。

**执行记录**：自动检查验证候选与多仓库 root 匹配；Extension Host 对双仓库 SCM 输入框完成写入与恢复；Windows QuickPick 选择候选后正确写入测试仓库草稿，再次选择时须确认覆盖，取消后原草稿保留。

## 阶段 9：联调、验收与 v0.1.0 打包

- [x] 接通全部入口，Command Palette 保持在 `8` 个命令以内。
- [x] 落实规格中的 `7` 个设置项，验证开关、配置变化和 Refresh。
- [x] 检查缓存更新：保存、切换分支、外部提交和仓库切换。
- [x] 检查性能：快速移动光标、大文件、长历史及慢 Git 命令。
- [x] 检查生命周期：停用功能和关闭编辑器后释放事件、定时器与 Decoration。
- [x] 验证键盘操作、Tooltip、空状态、加载状态及错误提示；自动功能静默失败，主动命令展示必要提示，日志默认不主动打开。
- [x] 按 MVP 规格第 43 节逐项验收；核心 Git 逻辑保留可重复运行的检查。
- [x] 在实际支持的平台验证路径和 Git 行为，记录尚未验证的平台。
- [x] 完成 README、使用说明和已知限制，生成并本地安装 `v0.1.0` VSIX。

**验收条件**：完整跑通“看行 → 查历史 → 看 Commit → 开 Diff → 比分支 → 查选区 → 审改动 → 生成提交信息”。

**执行记录**：Windows 上 `npm run check`、`npm test`（9 项）和 `npm run package` 通过；VS Code 1.137 的 Extension Development Host 验证 8 个公开命令、双仓库 SCM 输入框写入与恢复，本机安装 `gitpeek.gitpeek@0.1.0`。实际 VS Code UI 完整走通当前行 → 历史 → 提交详情 → Diff → 分支比较 → 选区来源 → 改动审查 → 生成提交信息；还验证了键盘、Hover、空／加载／错误状态、禁用与恢复、Rename、Root Commit 和虚拟 Diff 上下文。macOS/Linux 未验证；等待用户最终验收，不自动归档。

## 命令与设置核对表

Command Palette 最多包含以下 8 个命令；内部导航命令按需要注册，不额外扩展公开入口。

| 命令 | 主要交付阶段 |
| --- | --- |
| GitPeek: File History | 阶段 3 |
| GitPeek: Blame Current Line | 阶段 2 |
| GitPeek: Selection Origins | 阶段 6 |
| GitPeek: Compare with Base | 阶段 5 |
| GitPeek: Show Branch Changes | 阶段 5 |
| GitPeek: Review Changes | 阶段 7 |
| GitPeek: Generate Commit Message | 阶段 8 |
| GitPeek: Refresh | 随各功能接入，阶段 9 验收 |

| 设置 | 默认值 |
| --- | --- |
| `gitpeek.enabled` | `true` |
| `gitpeek.blame.enabled` | `true` |
| `gitpeek.blame.delay` | `300` |
| `gitpeek.history.limit` | `20` |
| `gitpeek.baseBranch` | `"auto"` |
| `gitpeek.commit.conventional` | `true` |
| `gitpeek.commit.defaultType` | `"chore"` |

## 里程碑

| 里程碑 | 完成范围 | 交付结果 |
| --- | --- | --- |
| M1 | 阶段 0–4 | 基础查看闭环：当前行／文件历史 → Commit Detail → 原生 Diff |
| M2 | 阶段 5–7 | 全部 P0：分支对比、选区来源、提交前改动审查 |
| M3 | 阶段 8–9 | Smart Commit、完整验收和可本地安装的 v0.1.0 VSIX |

## MVP 不包含

Git Graph、GitHub／GitLab API、Pull Requests、Issues、Interactive Rebase、Cherry Pick UI、Merge UI、Conflict Editor、Worktrees、Tags、Remote Manager、Stash Manager、Repository Explorer、AI Chat、Cloud Sync、Account、Telemetry。

以上排除项限定于 v0.1.0。后续已交付能力及新增优化范围见下节，MVP 规格原文保持不变。

## 后续优化计划（2026-09-30 补充）

**目标**：结合 GitLens 的高频使用体验，优先改善现有功能的连续查看、历史查找和比较能力，保持 GitPeek 轻量、面向当前代码上下文的定位。

**实施基线**：当前项目版本为 `0.4.0`，已具备提交图、本地分支操作、检出提交、Cherry-pick、Stash Lite，以及右键菜单、打开工作区文件、复制相对路径和侧栏刷新入口。Git 操作阶段的记录分别见[第二阶段计划](./GitPeek-Git-Ops-Phase-2-Plan.md)和[第三阶段计划](./GitPeek-Git-Ops-Phase-3-Plan.md)。本节编号延续本文的阶段 0–9。

阶段 10–14 已于 2026-10-08 完成实现及 Windows 验收，交付版本为 `0.5.0`；下表优先级保留为本轮实施顺序记录。

| 顺序 | 阶段 | 优先级 | 交付重点 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 10：固定提交详情区 | P0 | 连续查看提交信息与多个变更文件 | 已完成 |
| 2 | 11：提交搜索与筛选 | P0 | 从完整历史中查找提交，缩小图中范围 | 已完成 |
| 3 | 12：自由选择比较对象 | P0 | 两个提交之间、历史版本与工作区之间比较 | 已完成 |
| 4 | 13：选区演进历史 | P1 | 追溯选中代码经历过的修改 | 已完成 |
| 5 | 14：文件级暂存与取消暂存 | P1 | 从审查列表直接处理单个文件 | 已完成 |

### 阶段 10：固定提交详情区

- [x] 建立持续可见的提交详情区，优先复用原生 TreeView 与现有 Commit Detail 数据，展示仓库、完整 Hash、作者、时间、完整提交消息、文件列表和增删统计。
- [x] 接通提交图、Blame、选区来源和“查看提交详情”菜单；保留文件历史单击直接打开当前文件历史 Diff 的行为。
- [x] 支持固定／取消固定当前提交；打开 Diff 或切换编辑器后仍可继续查看该提交的其他文件。
- [x] 复用已有原生 Diff、复制 Hash、打开工作区文件和复制相对路径能力；历史文件路径与工作区路径各自保留明确语义。
- [x] 处理加载、空提交、读取失败与快速切换提交；异步结果和固定状态携带仓库及提交标识。

**验收条件**：连续切换提交并查看多个文件时，详情与 Diff 对应正确；两个仓库有同名文件时不串数据；Root、Rename、Deleted 和二进制文件保持既有处理规则；文件历史直达 Diff 无回退。

### 阶段 11：提交搜索与筛选

- [x] 支持按 Hash、提交消息或作者搜索，由 Git 查询仓库历史；搜索覆盖图中尚未加载的提交。
- [x] 支持当前分支／全部分支范围切换，并在界面显示当前搜索条件和结果范围。
- [x] 搜索结果可进入统一提交详情并定位到提交图中的对应提交；清除搜索后恢复正常浏览。
- [x] 结果按需分页；切换仓库、修改搜索条件或清除搜索后丢弃过期响应，Git 查询遵循现有超时与参数数组规范。

**验收条件**：能找到超过当前提交图 500 条加载上限的较早提交；Hash、中文消息和作者搜索正确；空结果、慢查询及连续输入有明确反馈；筛选不会把未加载的匹配提交遗漏为“无结果”。

**首轮范围**：Hash、消息、作者及分支范围；日期、文件内容、正则和自然语言搜索根据后续使用需求安排。

### 阶段 12：自由选择比较对象

- [x] 在提交菜单提供“选择此提交进行比较”和“与所选提交比较”，明确左右顺序 `A → B`，允许清除选择。
- [x] 展示两个提交的文件清单、状态和增删统计，并复用原生文件 Diff；选择携带仓库标识，跨仓库选择给出提示。
- [x] 增加历史版本与当前工作区文件的比较，标明比较的是磁盘内容，并对未保存文档给出提示。
- [x] 两个提交采用其快照之间的直接比较；现有 Branch vs Base 继续采用 `merge-base(base, HEAD) → HEAD`。文件清单、统计、Diff 与标题保持同一比较语义。
- [x] 将所选引用解析为明确的提交 Hash，处理引用失效、缺失文件、Rename 与二进制文件。

**验收条件**：在两侧各自有新提交的分叉仓库中，任意提交比较与 Branch vs Base 的结果符合各自语义；交换顺序后增删方向正确；历史版本与工作区比较显示当前磁盘内容；仓库切换不复用另一仓库的比较选择。

### 阶段 13：选区演进历史

- [x] 增加选区历史入口，展示曾修改该范围的提交序列；保留现有 Selection Origins 的最后修改来源分析。
- [x] 先用真实仓库验证 Git 行历史追踪在普通修改、插入删除、重命名和 Merge 场景下的边界，再确定支持范围。
- [x] 查询绑定仓库、文件、起始提交及选区范围；未保存内容或未提交修改导致行号无法可靠映射时提示用户，不返回未经验证的历史归属。
- [x] 复用阶段 10 的提交详情与原生 Diff，能够查看对应历史路径；不可追踪、历史中断或查询超时时给出明确说明。

**验收条件**：同一代码段多次修改可按提交追溯；插入删除不会悄悄转为另一段代码的历史；覆盖选区排他终点、中文路径和多仓库；不支持的重命名或 Merge 情况在界面与文档中明确记录。

### 阶段 14：文件级暂存与取消暂存

- [x] 为未暂存／未跟踪文件提供“暂存文件”，为已暂存文件提供“取消暂存”；仅针对右键选中的仓库和文件。
- [x] 优先复用 VS Code 内置 Git 能力；如需调用系统 Git，统一经过 GitService，使用参数数组及明确路径。
- [x] 正确处理同一文件同时有暂存和未暂存修改、Added、Deleted、Rename、未跟踪文件及空仓库；冲突状态和未保存内容提供明确提示。
- [x] 操作成功后刷新更改分组、统计、Diff 与提交信息生成上下文；失败保留现有文件内容和有用错误信息。

**验收条件**：真实仓库中暂存单个文件只更新该文件的 index 内容；取消暂存保留工作区修改；重命名两侧处理一致；没有 HEAD 的首次提交场景可用；多仓库操作不串仓库。

**首轮范围**：单文件 Stage／Unstage；批量操作、按行暂存、丢弃修改、直接提交及 Push／Pull 单独安排。

### 执行顺序与验证

- 推荐顺序：阶段 10 → 11 → 12 → 13 → 14；阶段 11–13 复用统一详情入口，阶段 14 沿用现有 Review Changes 分组。
- 每项完成后运行对应的真实 Git 仓库检查，以及 `npm run check`、`npm test`、`npm run package`；新增 UI 必须在 Extension Development Host 中验证实际入口、键盘操作和错误状态。
- 保留已有右键菜单、文件历史直达 Diff、仓库隔离、删除文件提示及缓存失效行为；既有完成项不因新增阶段而重新计为待办。
- 每个独立功能连同必要检查单独整理为 Conventional Commit；完成实现与验收后再更新本节状态。

### 暂缓方向

整文件 Blame、修改热度、CodeLens、PR 上下文、远程管理、Tags、Worktrees 和 AI 能力进入候选范围，待上述高频体验完善后按实际需求选择，不计入阶段 10–14 的交付要求。

**对照参考**：[GitLens 提交图、详情面板及搜索](https://help.gitkraken.com/gitlens/gl-commit-graph/)、[GitLens 行历史与 Search & Compare](https://help.gitkraken.com/gitlens/side-bar/)。

### 阶段 10–14 执行与验收记录（2026-10-08）

- 自动验证：`npm run check`、`npm test`（22 项）及 `npm run package` 通过，生成 `gitpeek-0.5.0.vsix`。真实 Git 检查覆盖 510 条历史中的早期提交、非根 Hash 精确搜索、分叉快照比较、Root／Added／Deleted／Rename／二进制、两次重命名与旧名重用、选区插入删除／首父 Merge、首次提交取消暂存、冲突、异步未保存保护和多仓库隔离。
- 阶段 10：实际 Extension Development Host 验证固定／取消固定、待查看提交切换、完整提交消息、文件列表及持续打开 Diff；迟到响应不会覆盖新详情。历史文件工作区路径通过 Git 首父链的重命名记录验证，Delete 后重新创建同名文件不沿用旧身份。
- 阶段 11：提交图实际按消息搜索并清除条件，结果范围可见；VM 及真实 Git 检查验证作者／Hash、分页、当前／全部分支与新输入保护。搜索结果不绘制缺席祖先的连线，清除搜索恢复正常拓扑；选择详情会高亮并定位对应提交。
- 阶段 12：实际 UI 从提交图选择比较起点和终点，显示 A → B 文件及统计；点击文件打开 1 → 2 的原生 Diff，文件历史可与工作区磁盘比较。原有 Branch vs Base 的共同祖先语义保留；过期比较及禁用后查询结果被丢弃。
- 阶段 13：实际编辑器选中第 1 行，通过右键“选区演进历史”显示两条修改提交，选择后进入统一详情。Git `-L` 沿首父链，Merge 展示合入结果；复制、跨父分支及 Git 无法识别的复杂重命名不作跨链身份推断，限制在 UI 与 README 说明。
- 阶段 14：实际右键暂存后仅目标文件进入 index；取消暂存后 index 清空、工作区内容保留。命令执行前再次校验文档状态；Git 标记隐藏的修改也通过磁盘 blob 校验阻止错误选区归属。
- 整合修复：VS Code 1.139.1 的真实 Webview 标识为 `mainThreadWebview-gitpeek.commitGraph`。修复共用虚拟编辑器识别后，真实事件及实际 UI 均确认打开提交图会保留仓库、更改、分支变更和文件历史上下文。
- 验证平台：Windows／VS Code 1.139.1；macOS 与 Linux 的实际 UI 尚未验证。工作区 Diff 为磁盘快照；已关闭且超出缓存的旧磁盘快照需要重新打开。未知历史工作区路径明确提示；固定详情和比较选择只在当前 Extension Host 会话中保留。
- v0.5.0 已完成开发宿主验收及本地打包；日常编辑器安装和远端推送不属于本次已执行动作。
