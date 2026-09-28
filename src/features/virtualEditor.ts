import * as vscode from 'vscode';

export function isGitPeekEditor(editor: vscode.TextEditor | undefined): boolean {
  if (editor) return editor.document.uri.scheme.startsWith('gitpeek-');
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    return input.original.scheme.startsWith('gitpeek-') || input.modified.scheme.startsWith('gitpeek-');
  }
  return input instanceof vscode.TabInputText && input.uri.scheme.startsWith('gitpeek-');
}
