import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './git/GitService';
import { RepositoryService } from './git/RepositoryService';
import { BlameController } from './features/blame';
import { registerFileBlame } from './features/fileBlame';
import { registerHistory } from './features/history';
import { registerSidebar } from './features/sidebar';
import { registerCommitFeatures } from './features/commitDetail';
import { registerCommitGraph } from './features/commitGraph';
import { registerBranchCompare } from './features/branchCompare';
import { registerSelectionOrigins } from './features/selectionOrigins';
import { registerReviewChanges } from './features/reviewChanges';
import { generateCommitMessage } from './features/smartCommit';
import { registerStashFeatures } from './features/stashFeature';
import { registerRevisionCompare } from './features/revisionCompare';
import { registerSelectionHistory } from './features/selectionHistory';
import { registerRebaseEditor } from './features/rebaseEditor';
import type { Repository } from './git/types';

const output = vscode.window.createOutputChannel('GitPeek');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(output);
  const git = new GitService((message) => output.appendLine(message));
  const repositories = new RepositoryService(git);
  registerStashFeatures(context, git, repositories);
  const commits = registerCommitFeatures(context, git);
  registerRevisionCompare(context, git);
  registerSelectionHistory(context, git, repositories, commits.showCommit, commits.showDiff);
  const rebase = registerRebaseEditor(context, git, repositories, commits.showCommit);
  const graph = registerCommitGraph(context, git, repositories, commits.showCommit, rebase.show);
  const blame = new BlameController(git, repositories, commits);
  context.subscriptions.push(blame);
  const fileBlame = registerFileBlame(context, git, repositories, { ...commits, setLineBlameSuspended: value => blame.setSuspended(value) });
  const history = await registerHistory(context, git, repositories, commits.showDiff);
  const review = await registerReviewChanges(context, git, repositories);
  const sidebar = registerSidebar(context, history, review.sidebar, commits.showCommit);
  const branch = registerBranchCompare(context, git, repositories, commits.showCommit);
  await registerSelectionOrigins(context, git, repositories, commits.showCommit);
  const updateBranchViews = () => {
    sidebar.setBranchChangesItems(branch.items);
    const summary = branch.summary;
    sidebar.setRepositoryItems(summary ? [
      Object.assign(new vscode.TreeItem(path.basename(summary.repo.root)), {
        description: summary.branch,
        tooltip: `${summary.repo.root}\n当前分支：${summary.branch}`,
        iconPath: new vscode.ThemeIcon('repo'),
      }),
      new vscode.TreeItem(`对比 ${summary.base} · ↑${summary.ahead} ↓${summary.behind}`),
    ] : []);
  };
  context.subscriptions.push(branch.onDidChange(updateBranchViews));
  updateBranchViews();
  const refresh = vscode.commands.registerCommand('gitpeek.refresh', (target?: Repository) => {
    const repo = typeof target?.root === 'string' && typeof target.id === 'string' ? target : undefined;
    repositories.clearCache();
    blame.refresh();
    fileBlame.refresh();
    sidebar.refresh();
    void branch.refresh();
    void review.refresh(repo).catch(() => undefined);
    void graph.refresh();
    output.appendLine(`[${new Date().toISOString()}] 已请求刷新`);
  });
  context.subscriptions.push(refresh);
  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.generateCommitMessage', async () => {
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek 已在设置中禁用。');
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const repo = (uri ? await repositories.forUri(uri) : undefined) ?? await repositories.pickRepository();
    if (!repo) {
      await vscode.window.showInformationMessage('GitPeek：请打开 Git 仓库中的文件，或选择一个仓库。');
      return;
    }
    await generateCommitMessage(git, repo);
  }));
  output.appendLine('GitPeek 已启动。');
}

export function deactivate(): void {}
