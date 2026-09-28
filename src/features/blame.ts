import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { RepositoryService } from '../git/RepositoryService';
import { BlameInfo, Repository } from '../git/types';

type Actions = {
  showCommit(repo: Repository, hash: string): void | Promise<void>;
  showDiff(repo: Repository, hash: string, file: string): void | Promise<void>;
};

const commitCommand = 'gitpeek.internal.blameCommit';
const diffCommand = 'gitpeek.internal.blameDiff';
const copyCommand = 'gitpeek.internal.copyBlameHash';

export class BlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground') },
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly cache = new Map<string, { expires: number; value: BlameInfo }>();
  private pending?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private shown?: { uri: string; line: number; hover: vscode.MarkdownString };

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryService,
    private readonly actions?: Actions,
  ) {
    this.subscriptions.push(
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === vscode.window.activeTextEditor?.document) this.schedule();
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        this.cache.clear();
        if (document === vscode.window.activeTextEditor?.document) this.schedule(true);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('gitpeek.enabled') || event.affectsConfiguration('gitpeek.blame')) this.refresh();
      }),
      vscode.window.onDidChangeWindowState(event => {
        if (event.focused) this.schedule();
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover: (document, position) => this.shown?.uri === document.uri.toString() && this.shown.line === position.line
          ? new vscode.Hover(this.shown.hover)
          : undefined,
      }),
      vscode.commands.registerCommand(copyCommand, (hash: string) => vscode.env.clipboard.writeText(hash)),
      vscode.commands.registerCommand('gitpeek.blameCurrentLine', () => this.schedule(true)),
    );
    if (actions) this.subscriptions.push(
      vscode.commands.registerCommand(commitCommand, (repo: Repository, hash: string) => actions.showCommit(repo, hash)),
      vscode.commands.registerCommand(diffCommand, (repo: Repository, hash: string, file: string) => actions.showDiff(repo, hash, file)),
    );
    this.schedule();
  }

  refresh(): void {
    this.cache.clear();
    this.schedule(true);
  }

  dispose(): void {
    this.generation++;
    if (this.pending) clearTimeout(this.pending);
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private schedule(immediate = false): void {
    const current = ++this.generation;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.shown = undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    editor.setDecorations(this.decoration, []);

    const config = vscode.workspace.getConfiguration('gitpeek', editor.document.uri);
    if (!config.get<boolean>('enabled', true) || !config.get<boolean>('blame.enabled', true)) return;
    if (editor.document.uri.scheme !== 'file') return;
    if (editor.document.isDirty) {
      this.render(editor, editor.selection.active.line, '未保存的更改');
      return;
    }

    const delay = immediate ? 0 : Math.max(0, config.get<number>('blame.delay', 300));
    const pending = setTimeout(() => {
      if (this.pending === pending) this.pending = undefined;
      void this.update(editor, current);
    }, delay);
    this.pending = pending;
  }

  private async update(editor: vscode.TextEditor, generation: number): Promise<void> {
    const document = editor.document;
    const line = editor.selection.active.line;
    const version = document.version;
    const isCurrent = () => generation === this.generation && vscode.window.activeTextEditor === editor
      && document.version === version && editor.selection.active.line === line && !document.isDirty;
    if (document.lineCount > 20_000) {
      if (isCurrent()) this.render(editor, line, 'GitPeek：大文件已停用当前行归属显示。');
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(document.uri);
      if (!isCurrent()) return;
      if (stat.size > 2 * 1024 * 1024) {
        this.render(editor, line, 'GitPeek：大文件已停用当前行归属显示。');
        return;
      }
      const repo = await this.repositories.forUri(document.uri);
      if (!repo || !isCurrent()) return;
      const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
      let head: string;
      try {
        head = (await this.git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
      } catch {
        if (isCurrent()) this.render(editor, line, '你 · 未提交的更改');
        return;
      }
      if (!isCurrent()) return;
      const key = `${repo.id}\0${file}\0${head}\0${line}`;
      const cached = this.cache.get(key);
      let blame = cached && cached.expires > Date.now() ? cached.value : undefined;
      if (!blame) {
        try {
          blame = (await this.git.blame(repo, file, line + 1))[0];
        } catch {
          if (!isCurrent()) return;
          try {
            const committed = await this.git.run(repo, ['ls-tree', '-z', '--name-only', 'HEAD', '--', `:(literal)${file}`]);
            if (!committed && isCurrent()) this.render(editor, line, '你 · 未提交的更改');
          } catch { /* Automatic blame errors remain silent. */ }
          return;
        }
        if (blame) this.cache.set(key, { expires: Date.now() + 30_000, value: blame });
      }
      const latestHead = (await this.git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
      if (!isCurrent()) return;
      if (latestHead !== head) {
        this.schedule(true);
        return;
      }
      if (!blame || !isCurrent()) return;
      if (/^0+$/.test(blame.hash) || blame.author === 'Not Committed Yet') {
        this.render(editor, line, '你 · 未提交的更改');
        return;
      }
      const when = relativeTime(blame.authorTime);
      const hover = new vscode.MarkdownString();
      hover.isTrusted = { enabledCommands: this.actions ? [commitCommand, diffCommand, copyCommand] : [copyCommand] };
      hover.appendMarkdown(`**${escapeMarkdown(blame.author)}**  \n${new Date(blame.authorTime * 1000).toLocaleString('zh-CN')}  \n\n${escapeMarkdown(blame.summary)}  \n\n\`${blame.hash}\`  \n\n`);
      const link = (command: string, label: string, args: unknown[]) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
      const links = this.actions ? [
        link(commitCommand, '查看提交', [repo, blame.hash]),
        link(diffCommand, '查看差异', [repo, blame.hash, blame.filename ?? file]),
      ] : [];
      hover.appendMarkdown([...links, link(copyCommand, '复制提交哈希', [blame.hash])].join(' · '));
      this.render(editor, line, `${blame.author} · ${when} · ${blame.summary}`, hover);
    } catch {
      // Automatic blame stays quiet for non-Git files, missing Git, and timeouts.
    }
  }

  private render(editor: vscode.TextEditor, line: number, text: string, hover?: vscode.MarkdownString): void {
    const end = editor.document.lineAt(line).range.end;
    editor.setDecorations(this.decoration, [{
      range: new vscode.Range(end, end),
      renderOptions: { after: { contentText: text } },
      hoverMessage: hover,
    }]);
    this.shown = hover ? { uri: editor.document.uri.toString(), line, hover } : undefined;
  }
}

function relativeTime(seconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  const [value, unit] = elapsed < 3_600 ? [Math.max(1, Math.floor(elapsed / 60)), 'minute']
    : elapsed < 86_400 ? [Math.floor(elapsed / 3_600), 'hour']
      : [Math.floor(elapsed / 86_400), 'day'];
  return new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-value, unit as Intl.RelativeTimeFormatUnit);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}
