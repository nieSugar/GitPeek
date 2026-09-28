import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './git/GitService';
import { RepositoryService } from './git/RepositoryService';
import { BlameController } from './features/blame';
import { registerHistory } from './features/history';
import { registerSidebar } from './features/sidebar';
import { registerCommitFeatures } from './features/commitDetail';
import { registerBranchCompare } from './features/branchCompare';
import { registerSelectionOrigins } from './features/selectionOrigins';
import { registerReviewChanges } from './features/reviewChanges';
import { generateCommitMessage } from './features/smartCommit';

const output = vscode.window.createOutputChannel('GitPeek');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(output);
  const git = new GitService((message) => output.appendLine(message));
  const repositories = new RepositoryService(git);
  const commits = registerCommitFeatures(context, git);
  const blame = new BlameController(git, repositories, commits);
  context.subscriptions.push(blame);
  const history = await registerHistory(context, git, repositories, commits.showCommit);
  const review = await registerReviewChanges(context, git, repositories);
  const sidebar = registerSidebar(context, history, review.sidebar);
  const branch = registerBranchCompare(context, git, repositories, commits.showCommit);
  await registerSelectionOrigins(context, git, repositories, commits.showCommit);
  const updateBranchViews = () => {
    sidebar.setBranchChangesItems(branch.items);
    const summary = branch.summary;
    sidebar.setRepositoryItems(summary ? [
      new vscode.TreeItem(path.basename(summary.repo.root)),
      new vscode.TreeItem(summary.branch),
      new vscode.TreeItem(`vs ${summary.base} · ↑${summary.ahead} ↓${summary.behind}`),
    ] : []);
  };
  context.subscriptions.push(branch.onDidChange(updateBranchViews));
  updateBranchViews();
  const refresh = vscode.commands.registerCommand('gitpeek.refresh', () => {
    repositories.clearCache();
    blame.refresh();
    sidebar.refresh();
    void branch.refresh();
    void review.refresh().catch(() => undefined);
    output.appendLine(`[${new Date().toISOString()}] Refresh requested`);
  });
  context.subscriptions.push(refresh);
  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.generateCommitMessage', async () => {
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek is disabled in settings.');
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const repo = (uri ? await repositories.forUri(uri) : undefined) ?? await repositories.pickRepository();
    if (!repo) {
      await vscode.window.showInformationMessage('GitPeek: Open a file in a Git repository or select a repository.');
      return;
    }
    await generateCommitMessage(git, repo);
  }));
  output.appendLine('GitPeek activated.');
}

export function deactivate(): void {}
