# GitPeek v0.1.0 开发计划清单

- 创建日期：2026-09-28。
- 需求基准：[GitPeek MVP 规格说明](./GitPeek-MVP-Spec.md)。
- 目标：交付可日常使用的轻量、Context-first VS Code Git 插件。
- 当前状态：功能实现、自动检查和本机安装已完成；等待真实 UI 交互验收。
- 更新方式：完成实现并通过相应验收后再勾选任务，记录必要的验证结果和未验证边界。

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

**执行记录**：`node tests/blame.test.cjs` 验证过期结果丢弃、未保存和大文件保护；Commit/Diff 链接已在阶段 4 接通。Hover 与 Decoration 的视觉交互待人工验收。

## 阶段 3：File History 与 Sidebar 基础

- [x] 建立原生 TreeView，采用 Repository、Changes、Branch Changes、File History 四个区域。
- [x] 添加编辑器 File History 按钮。
- [x] 使用 `--follow` 查询文件历史，正确追踪重命名。
- [x] 默认加载最近 `20` 条，支持 Load More。
- [x] 展示提交摘要、作者、日期和短 Hash。
- [x] 实现约 `60 s` 缓存，HEAD 变化和 Refresh 时失效。

**验收条件**：普通文件与重命名文件均能正确分页；切换仓库不会混入其他仓库的历史。

**执行记录**：`node tests/fileHistory.test.mjs` 验证分页、缓存和 HEAD 失效；GitService 真实仓库检查验证 `--follow` 跨 Rename。TreeView 点击 Commit 已在阶段 4 接通，视觉交互待人工验收。

## 阶段 4：Commit Detail 与原生 Diff

- [x] 展示提交作者、时间、完整 Message、Changed Files 和增删行统计。
- [x] 实现 `TextDocumentContentProvider` 和包含仓库上下文的历史文件 URI。
- [x] 通过 `vscode.diff` 打开文件差异。
- [x] 正确处理 Root Commit、Added、Deleted 和 Rename：缺失的一侧使用空内容，Rename 对比父提交的 oldPath 与当前提交的 newPath。
- [x] 明确 Merge Commit 的父提交比较规则，以及二进制文件的展示方式。
- [x] 接通 Blame、Hover 和 File History 的 Commit Detail 入口。
- [x] 实现 View Diff、Copy Commit Hash，统一“点击 Commit 看详情、点击文件看 Diff”。

**验收条件**：上述边界均能打开正确内容；读取失败与“该侧文件不存在”能够区分。

**执行记录**：临时仓库检查通过 Root、Added、Deleted、Rename、二进制、Merge 第一父提交和读取失败；`npm run check`、`npm run build` 通过。原生 VS Code Diff 交互待人工验收。

## 阶段 5：Branch vs Base

- [x] 实现 `gitpeek.baseBranch`，支持自动识别和手动指定。
- [x] 自动识别按 `origin/HEAD → main → master → develop`，保留实际可解析的引用。
- [x] 处理本地 Base 不存在、配置无效和无共同祖先的情况。
- [x] 展示当前分支、ahead／behind、分支提交和变更文件统计；`base...HEAD` 计数左侧为 behind、右侧为 ahead。
- [x] 文件清单、统计与文件 Diff 使用一致的三点比较基点：`merge-base(base, HEAD) → HEAD`。
- [x] 添加 Compare with Base 编辑器按钮及 Branch 状态栏入口。
- [x] 切换分支、外部提交和 Refresh 后更新相关数据。

**验收条件**：Base 与当前分支各自有新提交时，计数、文件清单和打开的 Diff 仍保持一致。

**执行记录**：真实分叉仓库检查通过 ahead／behind、共同祖先文件集、自动与无效 Base、无共同祖先；`npm run check`、`npm run build` 通过。VS Code 分支入口和 Diff 交互待人工验收。

## 阶段 6：Selection Origins

- [x] 添加选中文本的右键命令。
- [x] 正确转换选区行号，处理选区终点位于下一行行首的情况。
- [x] 对选中范围执行 Blame，按 Commit 聚合并统计行数。
- [x] 展示 Commit、作者、日期、摘要及对应行数。
- [x] 点击 Commit 进入统一的 Commit Detail。
- [x] 未保存文档沿用 Blame 的保护规则；未提交行单独展示。

**验收条件**：归属行数与实际分析范围一致，不把未提交内容当成可打开的历史 Commit。范围限定为来源分析，不实现 `git log -L` 完整演进历史。

**执行记录**：真实临时仓库检查通过多 Commit、未提交行、选区排他终点及中文特殊路径；扩展入口独立 TypeScript 检查通过。真实 VS Code 右键与 QuickPick 交互待人工验收。

## 阶段 7：Review Changes

- [x] 分组展示 Staged、Unstaged、Untracked。
- [x] 展示文件状态、增删行和汇总信息。
- [x] 正确处理同一个文件同时存在暂存与未暂存改动。
- [x] 分别打开 `HEAD → index`、`index → 磁盘`、`空内容 → 新文件` 的 Diff。
- [x] 检查新增或修改内容中的 `console.log`、`debugger`、`TODO`、`FIXME`。
- [x] 对 `.env`、`*.pem` 等文件提供提醒，警告不阻止提交。
- [x] 添加 changed 状态栏入口，明确未保存内容不计入磁盘上的 Git 变更。

**验收条件**：三类变更都能准确查看；警告位置正确，不因删除旧代码产生误报。

**执行记录**：真实临时仓库检查通过双区同文件、三类 Diff、嵌套 Untracked、警告行号、敏感文件提醒和磁盘内容更新；`npm run check`、`npm run build` 通过。原生 VS Code Tree/QuickPick 交互待人工验收。

## 阶段 8：Smart Commit Message

优先级为 P1，仍属于 v0.1.0 的交付范围。

- [x] 根据当前仓库的 Staged 文件生成候选，无需 AI。
- [x] 至少提供 `3` 个候选，支持 `feat`、`fix`、`refactor`、`perf`、`docs`、`test`、`style`、`chore`。
- [x] 支持 Conventional Commits 开关和默认类型配置。
- [x] 使用原生 QuickPick 选择候选。
- [x] 将选中内容写入对应仓库的 SCM Commit 输入框。
- [x] 处理无 Staged 文件、内置 Git 扩展不可用及已有提交草稿的情况，避免静默覆盖草稿。

**验收条件**：在真实 VS Code 中验证 SCM 写入；多仓库场景必须写到用户操作的仓库。

**执行记录**：`node tests/smartCommit.test.mjs` 验证候选与多仓库 root 匹配；真实 VS Code Extension Host 在双仓库 Workspace 中对两个 SCM 输入框完成测试值写入与恢复。QuickPick 选择候选的交互待人工验收。

## 阶段 9：联调、验收与 v0.1.0 打包

- [x] 接通全部入口，Command Palette 保持在 `8` 个命令以内。
- [x] 落实规格中的 `7` 个设置项，验证开关、配置变化和 Refresh。
- [x] 检查缓存更新：保存、切换分支、外部提交和仓库切换。
- [x] 检查性能：快速移动光标、大文件、长历史及慢 Git 命令。
- [x] 检查生命周期：停用功能和关闭编辑器后释放事件、定时器与 Decoration。
- [ ] 验证键盘操作、Tooltip、空状态、加载状态及错误提示；自动功能静默失败，主动命令展示必要提示，日志默认不主动打开。
- [ ] 按 MVP 规格第 43 节逐项验收；核心 Git 逻辑保留可重复运行的检查。
- [x] 在实际支持的平台验证路径和 Git 行为，记录尚未验证的平台。
- [x] 完成 README、使用说明和已知限制，生成并本地安装 `v0.1.0` VSIX。

**验收条件**：完整跑通“看行 → 查历史 → 看 Commit → 开 Diff → 比分支 → 查选区 → 审改动 → 生成提交信息”。

**执行记录**：Windows 上 `npm run check`、`npm test`（8 项）和 `npm run package` 通过；VS Code 1.137 的 Extension Development Host 验证 8 个公开命令、双仓库 SCM 输入框写入与恢复，本机已安装 `gitpeek.gitpeek@0.1.0`。自动检查覆盖快速切换光标、大文件保护、长历史分页、Git 调用超时设置、保存与 HEAD 变化失效；关闭 Host 后进程正常退出。macOS/Linux 未验证；键盘、Tooltip、空/加载状态及完整 QuickPick 工作流仍待人工视觉验收，因此本计划保留当前状态，不归档。

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

后续版本方向继续以 MVP 规格为准，本计划不提前实施。
