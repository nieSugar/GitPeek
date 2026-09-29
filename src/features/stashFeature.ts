import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { listStashes, previewStash, type StashEntry } from './stashList';
import { saveStash } from './stashSave';

export function registerStashFeatures(context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService): void {
  const pickRepo = async (): Promise<Repository | undefined> => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri?.scheme === 'file' ? await repositories.forUri(uri) : undefined) ?? await repositories.pickRepository();
  };

  const show = async (): Promise<void> => {
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek 已在设置中禁用。');
      return;
    }
    const repo = await pickRepo();
    if (!repo) {
      await vscode.window.showInformationMessage('GitPeek：请打开 Git 仓库中的文件，或选择一个仓库。');
      return;
    }
    try {
      const entries = await listStashes(git, repo);
      type Choice = vscode.QuickPickItem & ({ action: 'save' } | { entry: StashEntry });
      const choices: Choice[] = [
        { label: '保存当前改动…', action: 'save' },
        ...entries.map(entry => ({
          label: entry.ref,
          description: entry.subject,
          detail: new Date(entry.time * 1000).toLocaleString('zh-CN'),
          entry,
        })),
      ];
      const selected = await vscode.window.showQuickPick(choices, {
        title: `GitPeek：${basename(repo.root)} 的 Stash`,
        placeHolder: entries.length ? '选择一条 Stash 预览改动' : '暂无 Stash，可保存当前改动',
        matchOnDescription: true,
      });
      if (!selected) return;
      if ('entry' in selected) await showPreview(repo, selected.entry);
      else await save(repo);
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：Stash 操作失败：${errorText(error)}`);
    }
  };

  const save = async (repo: Repository): Promise<void> => {
    const message = await vscode.window.showInputBox({
      title: `GitPeek：保存 ${basename(repo.root)} 的改动`,
      prompt: '输入 Stash 描述',
      validateInput: value => value.trim() ? undefined : '请输入 Stash 描述',
    });
    if (message === undefined) return;
    const selected = await vscode.window.showQuickPick([
      { label: '仅保存已跟踪文件', includeUntracked: false },
      { label: '包含未跟踪文件', includeUntracked: true },
    ], { title: 'GitPeek：保存范围', placeHolder: '忽略文件始终不会保存' });
    if (!selected) return;
    await saveStash(git, repo, message.trim(), selected.includeUntracked);
    await vscode.commands.executeCommand('gitpeek.refresh');
    await vscode.window.showInformationMessage('GitPeek：改动已保存到 Stash。');
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
