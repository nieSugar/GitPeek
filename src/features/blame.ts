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

type BlameSnapshot = {
  document: vscode.TextDocument;
  version: number;
  expires: number;
  repo: Repository;
  file: string;
  lines?: Map<number, BlameInfo>;
  email?: string;
};

export class BlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('descriptionForeground') },
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private snapshot?: BlameSnapshot;
  private loading?: { document: vscode.TextDocument; version: number; revision: number; value: Promise<BlameSnapshot | undefined> };
  private revision = 0;
  private watchedRepo?: string;
  private watcherRequest = 0;
  private watchers: vscode.FileSystemWatcher[] = [];
  private pending?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private suspended = false;
  private disposed = false;
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
        if (event.document === vscode.window.activeTextEditor?.document) this.refresh();
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document === vscode.window.activeTextEditor?.document) this.refresh();
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document === this.snapshot?.document) this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('gitpeek.enabled') || event.affectsConfiguration('gitpeek.blame')) this.refresh();
      }),
      vscode.window.onDidChangeWindowState(event => {
        if (event.focused) this.refresh();
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover: (document, position) => this.shown?.uri === document.uri.toString() && this.shown.line === position.line
          ? new vscode.Hover(this.shown.hover, document.lineAt(position.line).range)
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
    this.revision++;
    this.snapshot = undefined;
    this.loading = undefined;
    this.schedule(true);
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    this.schedule(true);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.revision++;
    this.watcherRequest++;
    if (this.pending) clearTimeout(this.pending);
    for (const watcher of this.watchers) watcher.dispose();
    vscode.Disposable.from(...this.subscriptions).dispose();
  }

  private schedule(immediate = false): void {
    if (this.disposed) return;
    const current = ++this.generation;
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    this.shown = undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    editor.setDecorations(this.decoration, []);
    if (this.suspended) return;

    const config = vscode.workspace.getConfiguration('gitpeek', editor.document.uri);
    if (!config.get<boolean>('enabled', true) || !config.get<boolean>('blame.enabled', true)) return;
    if (editor.document.uri.scheme !== 'file') return;
    if (editor.document.isDirty) {
      this.render(editor, editor.selection.active.line, '未保存的更改');
      return;
    }

    const snapshot = this.snapshot;
    if (snapshot?.document === editor.document && snapshot.version === editor.document.version
      && snapshot.expires > Date.now() && this.watchedRepo === snapshot.repo.id) {
      this.renderSnapshot(editor, editor.selection.active.line, snapshot);
      return;
    }
    const delay = immediate ? 0 : Math.max(0, config.get<number>('blame.delay', 100));
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
      const cached = this.snapshot;
      if (cached?.document === document && cached.version === version && cached.expires > Date.now()
        && this.watchedRepo === cached.repo.id) {
        this.renderSnapshot(editor, line, cached);
        return;
      }
      let loading = this.loading;
      if (!loading || loading.document !== document || loading.version !== version || loading.revision !== this.revision) {
        loading = { document, version, revision: this.revision, value: this.loadSnapshot(editor, this.revision) };
        this.loading = loading;
      }
      let snapshot: BlameSnapshot | undefined;
      try { snapshot = await loading.value; }
      finally { if (this.loading === loading) this.loading = undefined; }
      if (snapshot && isCurrent()) this.renderSnapshot(editor, line, snapshot);
    } catch {
      // Automatic blame stays quiet for non-Git files, missing Git, and timeouts.
    }
  }

  private async watchRepository(repo: Repository): Promise<boolean> {
    if (this.watchedRepo === repo.id) return true;
    const request = ++this.watcherRequest;
    this.watchedRepo = undefined;
    this.snapshot = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    try {
      const entries = ['HEAD', 'index', 'packed-refs', 'refs', 'logs/HEAD', 'config'];
      const paths = (await this.git.run(repo, ['rev-parse', ...entries.flatMap(entry => ['--git-path', entry])])).trim().split(/\r?\n/);
      if (request !== this.watcherRequest || this.disposed || paths.length !== entries.length) return false;
      for (const entry of paths) {
        const filename = path.resolve(repo.root, entry);
        const refs = path.basename(filename) === 'refs';
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
          vscode.Uri.file(refs ? filename : path.dirname(filename)), refs ? '**/*' : path.basename(filename),
        ));
        watcher.onDidChange(() => this.refresh());
        watcher.onDidCreate(() => this.refresh());
        watcher.onDidDelete(() => this.refresh());
        this.watchers.push(watcher);
      }
      this.watchedRepo = repo.id;
      return true;
    } catch { return false; }
  }

  private async loadSnapshot(editor: vscode.TextEditor, revision: number): Promise<BlameSnapshot | undefined> {
    const document = editor.document;
    const version = document.version;
    const current = () => !this.disposed && revision === this.revision && document.version === version
      && !document.isDirty && vscode.window.activeTextEditor === editor;
    const repo = await this.repositories.forUri(document.uri);
    if (!repo || !current()) return undefined;
    const watched = await this.watchRepository(repo);
    if (!current()) return undefined;
    const file = path.relative(repo.root, document.uri.fsPath).replace(/\\/g, '/');
    const head = () => this.git.run(repo, ['rev-parse', '--verify', 'HEAD']).then(value => value.trim(), () => undefined);
    const [before, email] = await Promise.all([head(), this.git.userEmail(repo)]);
    if (!current()) return undefined;
    let lines: Map<number, BlameInfo> | undefined;
    if (before) {
      const contents = document.getText();
      const count = contents ? document.lineCount - Number(contents.endsWith('\n')) : 0;
      try {
        lines = new Map((count ? await this.git.blame(repo, file, 1, count) : []).map(info => [info.currentLine - 1, info]));
      } catch (error) {
        if (!current()) return undefined;
        const tracked = await this.git.run(repo, ['ls-tree', '-z', '--name-only', before, '--', `:(literal)${file}`]);
        if (tracked) throw error;
      }
    }
    const after = await head();
    if (!current()) return undefined;
    if (before !== after) { this.refresh(); return undefined; }
    const snapshot = { document, version, expires: Date.now() + 30_000, repo, file, lines, email };
    if (watched) this.snapshot = snapshot;
    return snapshot;
  }

  private renderSnapshot(editor: vscode.TextEditor, line: number, snapshot: BlameSnapshot): void {
    const blame = snapshot.lines?.get(line);
    if (!snapshot.lines || blame && (/^0+$/.test(blame.hash) || blame.author === 'Not Committed Yet')) {
      this.render(editor, line, '你 · 未提交的更改');
      return;
    }
    if (!blame) return;
    const { repo, file, email } = snapshot;
    const author = blameAuthor(blame, email);
    const hover = new vscode.MarkdownString();
    hover.isTrusted = { enabledCommands: this.actions ? [commitCommand, diffCommand, copyCommand] : [copyCommand] };
    hover.appendMarkdown(`**${escapeMarkdown(author)}**  \n`);
    if (blame.authorEmail) {
      const identity = blame.author === blame.authorEmail ? blame.author : `${blame.author} · ${blame.authorEmail}`;
      hover.appendMarkdown(`${escapeMarkdown(identity)}  \n`);
    }
    hover.appendMarkdown(`${new Date(blame.authorTime * 1000).toLocaleString('zh-CN')}  \n\n${escapeMarkdown(blame.summary)}  \n\n\`${blame.hash}\`  \n\n`);
    const link = (command: string, label: string, args: unknown[]) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
    const links = this.actions ? [
      link(commitCommand, '查看提交', [repo, blame.hash]),
      link(diffCommand, '查看差异', [repo, blame.hash, blame.filename ?? file]),
    ] : [];
    hover.appendMarkdown([...links, link(copyCommand, '复制提交哈希', [blame.hash])].join(' · '));
    this.render(editor, line, `${author} · ${relativeTime(blame.authorTime)} · ${blame.summary}`, hover);
  }

  private render(editor: vscode.TextEditor, line: number, text: string, hover?: vscode.MarkdownString): void {
    editor.setDecorations(this.decoration, [{
      range: editor.document.lineAt(line).range,
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

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&');
}

export function blameAuthor(info: BlameInfo, email?: string): string {
  return info.authorEmail?.trim() && email?.trim()
    && info.authorEmail.trim().toLowerCase() === email.trim().toLowerCase() ? '你' : info.author;
}
