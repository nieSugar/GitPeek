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

type GitRepository = {
  rootUri: vscode.Uri;
  inputBox: { value: string };
};

type GitApi = { repositories: GitRepository[] };
type GitExtensionExports = { getAPI(version: 1): GitApi };

const output = vscode.window.createOutputChannel('GitPeek');

/** Resolve the built-in Git SCM input box for one repository root. */
export function resolveScmInputBox(api: GitApi, repositoryRoot: string): GitRepository['inputBox'] | undefined {
  const target = path.resolve(repositoryRoot);
  return api.repositories.find((repository) => path.resolve(repository.rootUri.fsPath) === target)?.inputBox;
}

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
  output.appendLine('GitPeek activated.');
  void inspectGitScm();
}

async function inspectGitScm(): Promise<void> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      output.appendLine('Built-in Git extension is unavailable.');
      return;
    }
    const api = extension.isActive ? extension.exports.getAPI(1) : (await extension.activate()).getAPI(1);
    output.appendLine(`Built-in Git API v1 available (${api.repositories.length} repositories).`);
    for (const repository of api.repositories) {
      const inputBox = resolveScmInputBox(api, repository.rootUri.fsPath);
      output.appendLine(`SCM input box ${inputBox ? 'resolved' : 'missing'}: ${repository.rootUri.fsPath}`);
    }
  } catch (error) {
    output.appendLine(`SCM probe failed: ${String(error)}`);
  }
}

export function deactivate(): void {}
