import * as vscode from 'vscode';
import * as path from 'node:path';

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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(output);
  const refresh = vscode.commands.registerCommand('gitpeek.refresh', () => {
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
