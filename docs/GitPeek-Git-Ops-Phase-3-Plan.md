# GitPeek Git 操作第三阶段：Stash Lite

- 基线：第二阶段已完成提交图操作入口、检出提交与 Cherry-pick，安装包版本为 `0.3.0`。
- 目标：在当前仓库安全地保存、查看、应用和清理 Stash；所有写操作复用 `GitService.run`，使用原生 VS Code QuickPick 与确认框。
- 来源：旧版 [MVP 规格](./GitPeek-MVP-Spec.md)将 Stash Lite 列为后续方向；当前可用的 MCP 未返回独立的 GitPeek 阶段任务清单，若后续提供任务源再对照调整。
- 交付规则：每项功能连同真实仓库检查单独一个 Conventional Commit；可拆为 `6luna` 子代理并行处理 Git 逻辑，主代理统一集成 UI 和验收。

## 任务 3.1：Stash 列表与预览

- 按当前仓库读取 Stash 引用、完整对象 ID、描述和时间，使用 QuickPick 列表展示；选中后查看文件清单和增删统计。
- 列表与后续操作都携带仓库标识和对象 ID；外部新增或删除 Stash 后刷新，避免序号移动导致误操作。
- 验收：空列表、中文描述、多仓库和外部变更均显示准确。
- 独立提交：`feat(stash): 添加列表与改动预览`。

## 任务 3.2：保存工作区改动

- 支持输入 Stash 描述，选择是否包含未跟踪文件；默认不包含忽略文件。
- 工作区没有可保存改动时提示，不创建空 Stash；成功后刷新更改视图和 Stash 列表。
- 验收：暂存、未暂存及可选未跟踪文件在真实仓库中正确保存，其他仓库保持不变。
- 独立提交：`feat(stash): 保存当前仓库改动`。

## 任务 3.3：应用 Stash

- 从列表选择并确认要应用的 Stash，要求目标工作区干净；执行 `git stash apply`，成功后保留原 Stash。
- 发生冲突时保留 Git 的文件状态与 Stash，提示用户在 VS Code 源代码管理中解决。
- 验收：成功、冲突、取消和脏工作区拒绝均不丢失 Stash 或误改其他仓库。
- 独立提交：`feat(stash): 安全应用所选改动`。

## 任务 3.4：删除 Stash

- 删除前再次核对所选对象 ID 与当前引用，显示描述并要求模态确认；引用已变化时取消操作并刷新列表。
- 验收：确认后仅删除所选 Stash，取消或列表过期时不删除任何条目。
- 独立提交：`feat(stash): 确认后删除所选记录`。

## 依赖与总验收

1. 先交付任务 3.1 的列表与稳定身份；任务 3.2 的 Git 逻辑可并行，3.3 和 3.4 依赖列表选择与身份校验。
2. 全部完成后运行 `npm run check`、`npm test`、`npm run package`，并用隔离的 VS Code 临时仓库检查完整流程和取消路径。
3. 计划之外：`stash pop`、`reset --hard`、Interactive Rebase、远程 Push/Pull 与 PR 集成另行划分。

## 执行与验收记录

- 任务 3.1：`994af80 feat(stash): 添加列表与改动预览`。
- 任务 3.2：`8b986d6 feat(stash): 保存当前仓库改动`。
- 任务 3.3：`e60f47f feat(stash): 安全应用所选改动`。
- 任务 3.4：`9018ece feat(stash): 确认后删除所选记录`。
- Windows：`npm run check`、`npm test`（17 项）和 `npm run package` 通过，生成并本机安装 `gitpeek-0.4.0.vsix`。
- 真实 VS Code 临时仓库：空 Stash 提示、中文描述保存、包含未跟踪文件、两类文件及增删统计预览、应用后保留原 Stash、删除确认框与取消后保留记录均已验证。
- 真实 Git 临时仓库自动检查：删除指定记录、引用漂移或过期时拒绝、多仓库隔离均通过。通过 Windows UI 点击最终“删除”尚待 `computer-use` 的现场确认；本次验收未点击该按钮。
- macOS/Linux 的 VS Code 界面尚未实际验证。
