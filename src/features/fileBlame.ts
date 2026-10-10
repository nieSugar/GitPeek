import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitService } from '../git/GitService';
import { RepositoryService } from '../git/RepositoryService';
import type { BlameInfo, Repository } from '../git/types';
import { blameAuthor, escapeMarkdown } from './blame';

type Actions = {
  showCommit(repo: Repository, hash: string): void | Promise<void>;
  showDiff(repo: Repository, hash: string, file: string, workspacePath?: string): void | Promise<void>;
  setLineBlameSuspended?(suspended: boolean): void;
};

const commitCommand = 'gitpeek.internal.fileBlameCommit';
const diffCommand = 'gitpeek.internal.fileBlameDiff';

export function registerFileBlame(
  context: vscode.ExtensionContext, git: GitService, repositories: RepositoryService, actions: Actions,
): { refresh(): void; dispose(): void } {
  const controller = new FileBlameController(git, repositories, actions);
  context.subscriptions.push(controller);
  return controller;
}

class FileBlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: { width: '36ch', margin: '0 2em 0 0', color: new vscode.ThemeColor('descriptionForeground') },
  });
  private readonly subscriptions: vscode.Disposable[];
  private editor?: vscode.TextEditor;
  private pending?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private watcherRequest = 0;
  private watchedRepo?: string;
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly hovers = new Map<number, vscode.MarkdownString>();

  constructor(private readonly git: GitService, private readonly repositories: RepositoryService, private readonly actions: Actions) {
    this.subscriptions = [
      this.decoration,
      vscode.commands.registerCommand('gitpeek.toggleFileBlame', () => this.toggle()),
      vscode.commands.registerCommand(commitCommand, (repo: Repository, hash: string) => actions.showCommit(repo, hash)),
      vscode.commands.registerCommand(diffCommand, (repo: Repository, hash: string, file: string, workspacePath: string) => actions.showDiff(repo, hash, file, workspacePath)),
      vscode.window.onDidChangeActiveTextEditor(editor => { if (editor !== this.editor) this.stop(); }),
      vscode.workspace.onDidCloseTextDocument(document => { if (document === this.editor?.document) this.stop(); }),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.document === this.editor?.document) this.schedule(); }),
      vscode.workspace.onDidSaveTextDocument(document => { if (document === this.editor?.document) this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('gitpeek.enabled') || event.affectsConfiguration('gitpeek.blame')) this.refresh();
      }),
      vscode.window.onDidChangeWindowState(event => { if (event.focused) this.refresh(); }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover: (document, position) => {
          const hover = document === this.editor?.document ? this.hovers.get(position.line) : undefined;
          return hover ? new vscode.Hover(hover, document.lineAt(position.line).range) : undefined;
        },
      }),
    ];
  }

  refresh(): void { this.schedule(true); }

  dispose(): void {
    this.stop();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private enabled(editor: vscode.TextEditor): boolean {
    const config = vscode.workspace.getConfiguration('gitpeek', editor.document.uri);
    return config.get<boolean>('enabled', true) && config.get<boolean>('blame.enabled', true);
  }

  private toggle(): void {
    const editor = vscode.window.activeTextEditor;
    if (this.editor === editor && editor) { this.stop(); return; }
    this.stop();
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('GitPeek：请打开本地文件后查看整文件归属。');
      return;
    }
    if (!this.enabled(editor)) {
      void vscode.window.showInformationMessage('GitPeek：请在设置中启用 GitPeek 和代码归属显示。');
      return;
    }
    this.editor = editor;
    this.actions.setLineBlameSuspended?.(true);
    this.schedule(true);
  }

  private stop(): void {
    this.generation++;
    this.watcherRequest++;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.editor?.setDecorations(this.decoration, []);
    this.hovers.clear();
    const wasActive = !!this.editor;
    this.editor = undefined;
    this.watchedRepo = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    if (wasActive) this.actions.setLineBlameSuspended?.(false);
  }

  private schedule(immediate = false): void {
    const editor = this.editor;
    if (!editor) return;
    if (!this.enabled(editor) || editor !== vscode.window.activeTextEditor) { this.stop(); return; }
    const generation = ++this.generation;
    if (this.pending) clearTimeout(this.pending);
    editor.setDecorations(this.decoration, []);
    this.hovers.clear();
    const delay = immediate ? 0 : Math.max(0, vscode.workspace.getConfiguration('gitpeek', editor.document.uri).get<number>('blame.delay', 300));
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.update(editor, generation);
    }, delay);
  }

  private async watchRepository(repo: Repository, editor: vscode.TextEditor): Promise<void> {
    if (this.watchedRepo === repo.id) return;
    const request = ++this.watcherRequest;
    this.watchedRepo = repo.id;
    try {
      const paths = await Promise.all(['HEAD', 'packed-refs', 'refs', 'logs/HEAD'].map(async entry =>
        path.resolve(repo.root, (await this.git.run(repo, ['rev-parse', '--git-path', entry])).trim())));
      if (request !== this.watcherRequest || this.editor !== editor) return;
      for (const filename of paths) {
        const refs = path.basename(filename) === 'refs';
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
          vscode.Uri.file(refs ? filename : path.dirname(filename)), refs ? '**/*' : path.basename(filename),
        ));
        const refresh = () => { if (this.editor === editor) this.schedule(); };
        watcher.onDidChange(refresh);
        watcher.onDidCreate(refresh);
        watcher.onDidDelete(refresh);
        this.watchers.push(watcher);
      }
    } catch {
      if (request === this.watcherRequest) this.watchedRepo = undefined;
    }
  }

  private async head(repo: Repository): Promise<string | undefined> {
    try { return (await this.git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim(); }
    catch (error) {
      const branch = (await this.git.run(repo, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
      const refs = await this.git.run(repo, ['for-each-ref', '--format=%(refname)', branch]);
      if (refs.trim().split('\n').includes(branch)) throw error;
      return undefined;
    }
  }

  private async update(editor: vscode.TextEditor, generation: number): Promise<void> {
    const document = editor.document;
    const version = document.version;
    const current = () => this.generation === generation && this.editor === editor
      && vscode.window.activeTextEditor === editor && document.version === version;
    try {
      const contents = document.getText();
      if (document.lineCount > 20_000 || Buffer.byteLength(contents, 'utf8') > 2 * 1024 * 1024 || contents.includes('\0')) {
        this.stop();
        void vscode.window.showInformationMessage('GitPeek：整文件归属不支持二进制文件、超过 2 MB 或 20,000 行的文件。');
        return;
      }
      const repo = await this.repositories.forUri(document.uri);
      if (!current()) return;
      if (!repo) { this.stop(); void vscode.window.showInformationMessage('GitPeek：当前文件不在 Git 仓库中。'); return; }
      await this.watchRepository(repo, editor);
      if (!current()) return;
      const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
      const [head, userEmail] = await Promise.all([this.head(repo), this.git.userEmail(repo)]);
      if (!current()) return;
      let lines: BlameInfo[] | undefined;
      if (head) {
        try { lines = await this.git.blameContents(repo, file, contents); }
        catch (error) {
          if (!current()) return;
          const tracked = await this.git.run(repo, ['ls-tree', '-z', '--name-only', head, '--', `:(literal)${file}`]);
          if (tracked) throw error;
        }
      }
      const latestHead = await this.head(repo);
      if (!current()) return;
      if (latestHead !== head) { this.schedule(true); return; }
      const annotations: vscode.DecorationOptions[] = [];
      const actualLines = contents ? document.lineCount - (contents.endsWith('\n') ? 1 : 0) : 0;
      const entries: BlameInfo[] = lines ?? Array.from({ length: actualLines }, (_, line) => ({
        hash: '', author: '', authorTime: 0, summary: '', originalLine: line + 1, currentLine: line + 1, filename: file,
      }));
      for (const info of entries) {
        const line = info.currentLine - 1;
        if (line < 0 || line >= document.lineCount) continue;
        const uncommitted = !info.hash || /^0+$/.test(info.hash) || info.author === 'Not Committed Yet';
        const fullAuthor = blameAuthor(info, userEmail);
        const author = Array.from(fullAuthor);
        const displayAuthor = author.length > 6 ? `${author.slice(0, 5).join('')}…` : fullAuthor;
        const label = uncommitted ? '你 · 未提交' : `${displayAuthor} · ${new Date(info.authorTime * 1000).toLocaleDateString('zh-CN')} · ${info.hash.slice(0, 7)}`;
        const hover = new vscode.MarkdownString();
        if (uncommitted) hover.appendText('此行包含未提交的更改。');
        else {
          hover.isTrusted = { enabledCommands: [commitCommand, diffCommand] };
          hover.appendMarkdown(`**${escapeMarkdown(fullAuthor)}**  \n`);
          if (info.authorEmail) {
            const identity = info.author === info.authorEmail ? info.author : `${info.author} · ${info.authorEmail}`;
            hover.appendMarkdown(`${escapeMarkdown(identity)}  \n`);
          }
          hover.appendMarkdown(`${new Date(info.authorTime * 1000).toLocaleString('zh-CN')}  \n\n${escapeMarkdown(info.summary)}  \n\n\`${info.hash}\`  \n\n`);
          const link = (command: string, title: string, args: unknown[]) => `[${title}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
          hover.appendMarkdown(`${link(commitCommand, '查看提交', [repo, info.hash])} · ${link(diffCommand, '查看差异', [repo, info.hash, info.filename ?? file, file])}`);
        }
        this.hovers.set(line, hover);
        annotations.push({ range: new vscode.Range(line, 0, line, 0), renderOptions: { before: { contentText: label } }, hoverMessage: hover });
      }
      editor.setDecorations(this.decoration, annotations);
    } catch (error) {
      if (!current()) return;
      this.stop();
      void vscode.window.showInformationMessage(`GitPeek：无法读取整文件归属。${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
