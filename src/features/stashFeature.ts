import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { listStashes, previewStash, type StashEntry } from './stashList';

export function registerStashFeatures(context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService): void {
  const pickRepo = async (): Promise<Repository | undefined> => {
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek 已在设置中禁用。');
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri?.scheme === 'file' ? await repositories.forUri(uri) : undefined) ?? await repositories.pickRepository();
  };

  const show = async (): Promise<void> => {
    const repo = await pickRepo();
    if (!repo) {
      await vscode.window.showInformationMessage('GitPeek：请打开 Git 仓库中的文件，或选择一个仓库。');
      return;
    }
    try {
      const entries = await listStashes(git, repo);
      if (!entries.length) {
        await vscode.window.showInformationMessage('GitPeek：当前仓库没有 Stash。');
        return;
      }
      const selected = await vscode.window.showQuickPick(entries.map(entry => ({
        label: entry.ref,
        description: entry.subject,
        detail: new Date(entry.time * 1000).toLocaleString('zh-CN'),
        entry,
      })), { title: `GitPeek：${basename(repo.root)} 的 Stash`, placeHolder: '选择一条 Stash 预览改动', matchOnDescription: true });
      if (selected) await showPreview(repo, selected.entry);
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：无法读取 Stash：${errorText(error)}`);
    }
  };

  const showPreview = async (repo: Repository, entry: StashEntry): Promise<void> => {
    const preview = await previewStash(git, repo, entry);
    if (!preview.files.length) {
      await vscode.window.showInformationMessage(`GitPeek：${entry.ref} 没有可显示的文件改动。`);
      return;
    }
    await vscode.window.showQuickPick(preview.files.map(file => ({
      label: `${file.status} ${file.path}`,
      description: `+${file.additions ?? 0} −${file.deletions ?? 0}`,
    })), {
      title: `GitPeek：${entry.ref} · ${entry.subject}`,
      placeHolder: `${preview.files.length} 个文件 · +${preview.additions} −${preview.deletions}`,
      matchOnDescription: true,
    });
  };

  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.stash', show));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
