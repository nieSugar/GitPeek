import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { checkoutCommit } from './checkoutCommit';
import { abortCherryPick, cherryPickCommit, cherryPickInProgress, continueCherryPick } from './cherryPickCommit';
import {
  avatarByEmail, createAndSwitchBranch, loadGraph, mergeLocalBranch, normalizeGraphQuery, parseGitHubRemote,
  switchLocalBranch, type GraphSnapshot, type GraphQuery,
} from './commitGraphData';

export function registerCommitGraph(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => Promise<void>,
  openRebase?: (repo: Repository, firstHash?: string) => Promise<void>,
): { refresh(): Promise<void> } {
  let panel: vscode.WebviewPanel | undefined;
  let repo: Repository | undefined;
  let snapshot: GraphSnapshot | undefined;
  let ready = false;
  let limit = 100;
  let generation = 0;
  let query: GraphQuery = { kind: 'message', text: '', scope: 'all' };
  const avatarCache = new Map<string, { expires: number; avatars: Record<string, string> }>();

  const refresh = async (): Promise<void> => {
    if (!panel || !repo || !ready) return;
    const current = ++generation;
    const target = repo;
    snapshot = undefined;
    void panel.webview.postMessage({ type: 'loading' });
    try {
      const [data, cherryInProgress] = await Promise.all([loadGraph(git, target, limit, query), cherryPickInProgress(git, target)]);
      if (current !== generation || !panel || repo?.id !== target.id) return;
      snapshot = data;
      void panel.webview.postMessage({ type: 'render', data, query, limit, cherryInProgress, repoId: target.id, generation: current });
      void loadAvatars(target, data.branch).then(avatars => {
        if (current === generation && panel && repo?.id === target.id) {
          void panel.webview.postMessage({ type: 'avatars', avatars });
        }
      });
    } catch (error) {
      if (current === generation && panel) void panel.webview.postMessage({ type: 'error', message: errorText(error) });
    }
  };

  const show = async (): Promise<void> => {
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) {
      await vscode.window.showInformationMessage('GitPeek 已在设置中禁用。');
      return;
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    const selected = (uri?.scheme === 'file' ? await repositories.forUri(uri) : undefined)
      ?? await repositories.pickRepository();
    if (!selected) {
      await vscode.window.showInformationMessage('GitPeek：请打开 Git 仓库中的文件，或选择一个仓库。');
      return;
    }
    if (repo?.id !== selected.id) { snapshot = undefined; limit = 100; query = { kind: 'message', text: '', scope: 'all' }; }
    repo = selected;
    if (panel) {
      panel.title = `GitPeek 提交图 · ${basename(selected.root)}`;
      panel.reveal();
      await refresh();
      return;
    }
    panel = vscode.window.createWebviewPanel('gitpeek.commitGraph', `GitPeek 提交图 · ${basename(selected.root)}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => { panel = undefined; ready = false; generation++; });
    panel.onDidChangeViewState(() => { if (panel?.visible) void refresh(); });
    panel.webview.onDidReceiveMessage((message: unknown) => { void handleMessage(message); });
    panel.webview.html = graphHtml();
  };

  const handleMessage = async (message: unknown, requestedAction?: string): Promise<void> => {
    if (!panel || !repo || !message || typeof message !== 'object') return;
    const action = (message as { type?: unknown }).type;
    if (action === 'ready') { ready = true; await refresh(); return; }
    if (action === 'refresh') { await refresh(); return; }
    if (action === 'loadMore') { if (snapshot?.hasMore) { limit += 100; await refresh(); } return; }
    if (!vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true)) return;
    if (action === 'search') {
      try {
        query = normalizeGraphQuery(message);
        limit = 100; await refresh();
      } catch (error) {
        generation++; snapshot = undefined;
        void panel.webview.postMessage({ type: 'error', message: errorText(error) });
      }
      return;
    }
    if (action === 'rebase') {
      const target = message as { repoId?: unknown; generation?: unknown };
      if (!snapshot || target.repoId !== repo.id || target.generation !== generation) return;
      try { await openRebase?.(repo); }
      catch (error) { await vscode.window.showErrorMessage(`GitPeek：无法打开提交整理：${errorText(error)}`); }
      return;
    }
    if (action === 'commit') {
      const hash = (message as { hash?: unknown }).hash;
      if (typeof hash === 'string' && snapshot?.rows.some(row => row.hash === hash)) {
        void panel.webview.postMessage({ type: 'select', hash, repoId: repo.id, generation });
        await showCommit(repo, hash);
      }
      return;
    }
    if (action === 'actions') {
      const target = message as { hash?: unknown; repoId?: unknown; generation?: unknown };
      if (!requestedAction && (target.repoId !== repo.id || target.generation !== generation)) return;
      const hash = target.hash;
      const targetRepo = repo;
      const targetSnapshot = snapshot;
      const targetGeneration = generation;
      const valid = (): boolean => Boolean(panel && targetRepo && repo?.id === targetRepo.id && snapshot === targetSnapshot && generation === targetGeneration && typeof hash === 'string' && snapshot?.rows.some(row => row.hash === hash));
      if (!valid()) return;
      let selectedAction = requestedAction;
      try {
        if (!selectedAction) {
          const selected = await vscode.window.showQuickPick([
            { label: '复制完整 Hash', action: 'copy' },
            { label: '检出此提交', action: 'checkout' },
            { label: 'Cherry-pick 到当前分支', action: 'cherryPick' },
            { label: '从此提交开始整理', action: 'rebase' },
          ], {
            title: `GitPeek：提交 ${String(hash).slice(0, 7)}`, placeHolder: '选择提交操作',
          });
          selectedAction = selected?.action;
        }
        if (!selectedAction || !valid()) return;
        if (selectedAction === 'copy') {
          await vscode.env.clipboard.writeText(hash as string);
          if (valid()) await vscode.window.showInformationMessage('GitPeek：已复制完整 Commit Hash。');
        } else if (selectedAction === 'rebase') {
          await openRebase?.(targetRepo, hash as string);
        } else if (selectedAction === 'checkout') {
          const confirmed = await vscode.window.showWarningMessage(
            `检出提交 ${String(hash).slice(0, 7)} 并进入分离 HEAD 状态？工作区必须干净。`,
            { modal: true }, '检出',
          );
          if (confirmed !== '检出' || !valid()) return;
          await checkoutCommit(git, targetRepo, hash as string);
          await vscode.commands.executeCommand('gitpeek.refresh');
          await refresh();
        } else if (selectedAction === 'cherryPick') {
          if (!targetSnapshot?.branch) throw new Error('分离 HEAD 状态下不能 Cherry-pick。');
          const confirmed = await vscode.window.showWarningMessage(
            `将提交 ${String(hash).slice(0, 7)} Cherry-pick 到“${targetSnapshot.branch}”？工作区必须干净。`,
            { modal: true }, 'Cherry-pick',
          );
          if (confirmed !== 'Cherry-pick' || !valid()) return;
          await cherryPickCommit(git, targetRepo, hash as string);
          await vscode.commands.executeCommand('gitpeek.refresh');
          await refresh();
        }
      } catch (error) {
        const conflicted = selectedAction === 'cherryPick' && await cherryPickInProgress(git, targetRepo);
        await refresh();
        await vscode.window.showErrorMessage(conflicted
          ? `GitPeek：Cherry-pick 已暂停。请解决冲突并暂存文件，然后点击“继续 Cherry-pick”；也可点击“中止 Cherry-pick”。Git 错误：${errorText(error)}`
          : `GitPeek：提交操作失败：${errorText(error)}`);
      }
      return;
    }
    if (action === 'cherryContinue' || action === 'cherryAbort') {
      const targetRepo = repo;
      const targetGeneration = generation;
      try {
        if (action === 'cherryAbort') {
          const confirmed = await vscode.window.showWarningMessage(
            '中止 Cherry-pick 将丢弃本次操作产生的冲突改动。确定中止？',
            { modal: true }, '中止',
          );
          if (confirmed !== '中止' || repo?.id !== targetRepo.id || generation !== targetGeneration) return;
          await abortCherryPick(git, targetRepo);
        } else {
          await continueCherryPick(git, targetRepo);
        }
        await vscode.commands.executeCommand('gitpeek.refresh');
        await refresh();
      } catch (error) {
        await refresh();
        await vscode.window.showErrorMessage(`GitPeek：Cherry-pick ${action === 'cherryAbort' ? '中止' : '继续'}失败：${errorText(error)}`);
      }
      return;
    }
    try {
      if (action === 'switch') {
        const branches = snapshot?.branches ?? [];
        const selected = await vscode.window.showQuickPick(branches.filter(name => name !== snapshot?.branch), {
          title: 'GitPeek：切换本地分支', placeHolder: '选择目标分支',
        });
        if (selected) await switchLocalBranch(git, repo, selected);
        else return;
      } else if (action === 'create') {
        const name = await vscode.window.showInputBox({ title: 'GitPeek：创建并切换分支', prompt: '输入新分支名称' });
        if (!name) return;
        await createAndSwitchBranch(git, repo, name.trim());
      } else if (action === 'merge') {
        if (!snapshot?.branch) throw new Error('分离 HEAD 状态下无法合并。');
        const selected = await vscode.window.showQuickPick(snapshot.branches.filter(name => name !== snapshot?.branch), {
          title: `GitPeek：合并到 ${snapshot.branch}`, placeHolder: '选择要合入当前分支的本地分支',
        });
        if (!selected) return;
        const answer = await vscode.window.showWarningMessage(
          `将“${selected}”合并到当前分支“${snapshot.branch}”？合并前工作区必须干净。`,
          { modal: true }, '合并',
        );
        if (answer !== '合并') return;
        await mergeLocalBranch(git, repo, selected);
      } else return;
      await vscode.commands.executeCommand('gitpeek.refresh');
      await refresh();
    } catch (error) {
      await vscode.window.showErrorMessage(`GitPeek：Git 操作失败：${errorText(error)}`);
      await refresh();
    }
  };

  const loadAvatars = async (target: Repository, branch: string): Promise<Record<string, string>> => {
    const key = `${target.id}\0${branch}`;
    const cached = avatarCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.avatars;
    const remote = await git.run(target, ['remote', 'get-url', 'origin']).catch(() => '');
    const github = parseGitHubRemote(remote);
    if (!github) return {};
    const url = new URL(`https://api.github.com/repos/${github.owner}/${github.repo}/commits`);
    url.searchParams.set('per_page', '100');
    if (branch) url.searchParams.set('sha', branch);
    const request = async (): Promise<Record<string, string>> => {
      const response = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GitPeek' },
        signal: AbortSignal.timeout(4_000),
      });
      return response.ok ? avatarByEmail(await response.json()) : {};
    };
    let avatars: Record<string, string> = {};
    try {
      avatars = await request();
      if (!Object.keys(avatars).length && branch) { url.searchParams.delete('sha'); avatars = await request(); }
    } catch { /* Keep author initials when GitHub is unavailable. */ }
    avatarCache.set(key, { expires: Date.now() + 10 * 60_000, avatars });
    return avatars;
  };

  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.showCommitGraph', show));
  for (const action of ['commit', 'copy', 'checkout', 'cherryPick', 'rebase', 'selectCompare', 'compareSelected']) {
    context.subscriptions.push(vscode.commands.registerCommand(`gitpeek.internal.graph.${action}`, (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const target = value as Record<string, unknown>;
      if (target.gitpeekGraphRepoId !== repo?.id || target.gitpeekGraphGeneration !== generation) return;
      if (action === 'selectCompare' || action === 'compareSelected') {
        if (!repo || typeof target.gitpeekCommitHash !== 'string' || !snapshot?.rows.some(row => row.hash === target.gitpeekCommitHash)) return;
        return vscode.commands.executeCommand(`gitpeek.internal.compare.${action}`, { commitTarget: { repo, hash: target.gitpeekCommitHash } });
      }
      return handleMessage({ type: action === 'commit' ? 'commit' : 'actions', hash: target.gitpeekCommitHash }, action);
    }));
  }
  return { refresh };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function graphHtml(): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://avatars.githubusercontent.com; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1"><style nonce="${nonce}">
*{box-sizing:border-box}body{display:flex;flex-direction:column;height:100vh;margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family);}
button{cursor:pointer;font:inherit;color:inherit}button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}[hidden]{display:none!important}
header{flex:none;padding:18px 24px 12px;border-bottom:1px solid var(--vscode-panel-border)}
.toolbar,.context,.actions,.summary{display:flex;align-items:center;gap:12px}.toolbar{justify-content:space-between;flex-wrap:wrap}.context{min-width:0;max-width:100%}h1{margin:0;font-size:15px;font-weight:600;white-space:nowrap}
.branch-button{display:flex;align-items:center;gap:7px;min-width:0;max-width:280px;padding:5px 9px;border:1px solid var(--vscode-panel-border);border-radius:5px;background:transparent;color:var(--vscode-textLink-foreground)}
.branch-button svg{flex:none}.branch-button:hover,.actions button:hover,.row-action:hover{background:var(--vscode-toolbar-hoverBackground)}#branch{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actions{gap:4px;flex-wrap:wrap}.actions button{padding:5px 9px;border:1px solid transparent;border-radius:4px;background:transparent}.actions .refresh{display:flex;align-items:center;gap:6px}.actions .cherry{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.summary{justify-content:space-between;margin-top:10px;font-size:12px;color:var(--vscode-descriptionForeground)}#status{min-width:0;overflow-wrap:anywhere}.hint{white-space:nowrap}
.search{display:grid;grid-template-columns:auto minmax(120px,1fr) auto auto auto;gap:6px;margin-top:10px}.search input,.search select,.search button{min-width:0;max-width:100%;font:inherit;padding:5px 8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px}.search input{width:100%}.search button[type=submit]{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}.search button[type=submit]:hover{background:var(--vscode-button-hoverBackground)}.search input:focus-visible,.search select:focus-visible,.filters summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.filters{grid-column:1/-1;min-width:0}.filters summary{width:fit-content;max-width:100%;padding:3px 0;cursor:pointer;color:var(--vscode-descriptionForeground);font-size:12px}.filters summary:hover{color:var(--vscode-editor-foreground)}#searchDraft{margin-left:10px;color:var(--vscode-textLink-foreground)}.filter-fields{display:grid;grid-template-columns:minmax(160px,1fr) auto auto;gap:8px;margin-top:8px}.filter-fields label{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--vscode-descriptionForeground);font-size:12px}.search input[type=date]{width:150px}.search-help{grid-column:1/-1;margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--vscode-descriptionForeground)}.row.selected{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.history{--graph-width:56px;--author-width:148px;--date-width:100px;--hash-width:76px;flex:1;min-height:0;overflow:auto;padding:0 12px}
.columns,.commit{display:grid;grid-template-columns:var(--graph-width) minmax(180px,1fr) var(--author-width) var(--date-width) var(--hash-width);align-items:center;column-gap:12px}
.columns{position:sticky;top:0;z-index:1;min-width:660px;padding:12px 44px 10px 12px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);font-size:11px;color:var(--vscode-descriptionForeground)}
.row{display:flex;align-items:center;min-width:660px;padding:0 12px;border-radius:4px}.row.current{background:color-mix(in srgb,var(--vscode-textLink-foreground) 7%,transparent)}.row:has(.commit:hover),.row:focus-within{background:var(--vscode-list-hoverBackground)}
.commit{flex:1;min-width:0;height:44px;padding:0;border:0;background:transparent;text-align:left}.graph{display:block;overflow:visible}.graph .node{fill:var(--vscode-editor-background);stroke-width:2}.graph .merge-node{stroke-width:3}.graph .head-node{fill:var(--vscode-editor-background);stroke-width:2;opacity:.45}
.message,.author,.refs{display:flex;align-items:center;gap:8px;min-width:0}.subject,.author-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.subject{font-weight:500}.refs{flex:none;max-width:42%;overflow:hidden;gap:4px}.ref{display:block;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:2px 6px;font-size:11px;color:var(--vscode-descriptionForeground)}.ref.head{color:var(--vscode-textLink-foreground);border-color:color-mix(in srgb,var(--vscode-textLink-foreground) 40%,transparent);background:color-mix(in srgb,var(--vscode-textLink-foreground) 8%,transparent)}.ref.tag{color:var(--vscode-charts-orange,var(--vscode-descriptionForeground))}
.author,.date,.hash{font-size:12px;color:var(--vscode-descriptionForeground)}.date,.hash{white-space:nowrap}.hash{font-family:var(--vscode-editor-font-family,monospace);font-size:11px}.avatar{flex:none;position:relative;display:inline-grid;place-items:center;width:22px;height:22px;border:1px solid var(--vscode-panel-border);border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10px;overflow:hidden}.avatar img{position:absolute;width:100%;height:100%;object-fit:cover}
.row-action{flex:none;width:32px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--vscode-descriptionForeground);font-size:20px;opacity:0}.row:hover .row-action,.row:focus-within .row-action,.row-action:focus-visible{opacity:1}.empty{display:block;padding:48px 16px;text-align:center;color:var(--vscode-descriptionForeground)}
#more{display:block;margin:16px auto 24px;padding:7px 18px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}#more:hover{background:var(--vscode-button-secondaryHoverBackground)}
@media(max-width:800px){header{padding:14px 16px 12px}.history{--author-width:100px;--date-width:84px;padding:0 4px}.hint{display:none}.row,.columns{min-width:580px}.refs{max-width:45%}}
@media(max-width:700px){.toolbar{gap:8px}.actions{gap:0}.actions button{padding:5px}.filter-fields{grid-template-columns:1fr 1fr}.filter-fields label:first-child{grid-column:1/-1}.search input[type=date]{width:100%}.columns,.commit{grid-template-columns:var(--graph-width) minmax(180px,1fr) 28px 64px}.row,.columns{min-width:440px}.date,.columns>span:nth-child(4),.author-name{display:none}}
@media(max-width:480px){.search{grid-template-columns:100px minmax(0,1fr) auto}#searchText{grid-column:2/-1}}
@media(max-width:380px){header{padding:12px}.actions{gap:0}.actions button{padding:5px 7px}.search{grid-template-columns:minmax(0,1fr) auto auto}#searchKind{grid-column:1/-1}#searchText{grid-column:1/-1}.filter-fields{grid-template-columns:1fr}.filter-fields label:first-child{grid-column:auto}}
@media(hover:none){.row-action{opacity:1}}
@media(forced-colors:active){.row.current{outline:1px solid CanvasText;outline-offset:-1px}.graph path,.graph circle{stroke:CanvasText}.ref{border-color:CanvasText}}
</style></head><body>
<header><div class="toolbar"><div class="context"><h1>提交图</h1><button class="branch-button" data-action="switch" title="切换本地分支" aria-label="切换分支"><svg width="14" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4" cy="3" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="13" r="2"/><path d="M4 5v6m8-5c0 4-8 1-8 5"/></svg><span id="branch">读取分支…</span></button></div>
<div class="actions"><button data-action="create">＋ 新建分支</button><button data-action="merge">合并分支</button><button data-action="rebase">整理提交</button><button class="cherry" data-action="cherryContinue" hidden>继续 Cherry-pick</button><button class="cherry" data-action="cherryAbort" hidden>中止 Cherry-pick</button><button class="refresh" data-action="refresh"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13 6a5 5 0 1 0 0 5M13 2v4H9"/></svg>刷新</button></div></div>
<form id="search" class="search"><select id="searchKind" aria-label="搜索类型"><option value="message">提交消息</option><option value="author">作者</option><option value="hash">Hash</option><option value="code">代码变化</option></select><input id="searchText" maxlength="500" aria-label="搜索完整 Git 历史" aria-describedby="codeSearchHelp" placeholder="搜索完整 Git 历史"><select id="searchScope" aria-label="分支范围"><option value="all">全部分支</option><option value="current">当前分支</option></select><button type="submit">搜索</button><button type="button" data-action="clearSearch" title="清除关键词、路径和日期，保留搜索类型与分支范围">清除</button>
<p id="codeSearchHelp" class="search-help" hidden>查找区分大小写的字面量出现次数变化。</p>
<details class="filters"><summary><span id="filterSummary">高级筛选</span><span id="searchDraft" hidden>条件未应用</span></summary><div class="filter-fields"><label>文件或目录<input id="searchPath" maxlength="4096" aria-label="仓库相对路径" placeholder="仓库相对路径（可选）"></label><label>开始日期<input id="searchSince" type="date" aria-label="开始日期" aria-describedby="dateSearchHelp"></label><label>结束日期<input id="searchUntil" type="date" aria-label="结束日期" aria-describedby="dateSearchHelp"></label></div><p id="dateSearchHelp" class="search-help">按提交者时间，包含首尾日期，使用 Git 所在环境的本地时区。</p></details></form>
<div class="summary"><span id="status" role="status" aria-live="polite">正在加载…</span><span class="hint">点击提交查看详情 · 右键打开提交操作</span></div></header>
<main class="history" aria-label="提交历史"><div class="columns" aria-hidden="true"><span>提交线</span><span>提交信息</span><span>作者</span><span>日期</span><span>Commit</span></div><div id="rows"></div><button id="more" data-action="loadMore" hidden>加载更多提交</button></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), rows=document.getElementById('rows'), status=document.getElementById('status'), more=document.getElementById('more');
const colors=['blue','orange','green','purple','red','yellow'].map(name=>'var(--vscode-charts-'+name+', var(--vscode-textLink-foreground))');let data,avatars={},repoId,generation,query,selectedHash;
const searchForm=document.getElementById('search'),searchKind=document.getElementById('searchKind'),searchText=document.getElementById('searchText'),searchScope=document.getElementById('searchScope'),searchPath=document.getElementById('searchPath'),searchSince=document.getElementById('searchSince'),searchUntil=document.getElementById('searchUntil');let searchDirty=false;
function updateSearchControls(){const count=[searchPath.value,searchSince.value,searchUntil.value].filter(Boolean).length;document.getElementById('filterSummary').textContent='高级筛选'+(count?'（'+count+' 项）':'');document.getElementById('searchDraft').hidden=!searchDirty;document.getElementById('codeSearchHelp').hidden=searchKind.value!=='code'}
for(const event of ['input','change'])searchForm.addEventListener(event,()=>{searchDirty=true;updateSearchControls()});
function submitSearch(){searchDirty=false;updateSearchControls();vscode.postMessage({type:'search',kind:searchKind.value,text:searchText.value,scope:searchScope.value,...(searchPath.value?{path:searchPath.value}:{}),...(searchSince.value?{since:searchSince.value}:{}),...(searchUntil.value?{until:searchUntil.value}:{})})}
searchForm.addEventListener('submit',event=>{event.preventDefault();submitSearch()});
function filtered(){return Boolean(query?.text||query?.path||query?.since||query?.until)}
function svgElement(name,attributes){const element=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value));return element}
function graphCells(commits){
  const cells=[];let lanes=[],nextColor=0,maxLanes=1;
  for(const row of commits){
    let column=lanes.findIndex(lane=>lane.hash===row.hash);const incoming=column>=0;
    if(!incoming){column=lanes.length;lanes.push({hash:row.hash,color:colors[nextColor++%colors.length]})}
    const current=lanes[column],parents=row.parents||[],next=lanes.filter((_,index)=>index!==column);
    parents.forEach((hash,index)=>{if(!next.some(lane=>lane.hash===hash))next.splice(Math.min(column+index,next.length),0,{hash,color:index===0?current.color:colors[nextColor++%colors.length]})});
    maxLanes=Math.max(maxLanes,lanes.length,next.length);
    const cell=svgElement('svg',{class:'graph',height:44,'aria-hidden':'true'}),x=16+column*20;
    const connect=(from,to,color,start)=>cell.append(svgElement('path',{d:'M '+from+' '+start+' V 22 C '+from+' 33 '+to+' 33 '+to+' 44',fill:'none',stroke:color,'stroke-width':1.8}));
    lanes.forEach((lane,index)=>{
      const from=16+index*20;
      if(index!==column)connect(from,16+next.findIndex(target=>target.hash===lane.hash)*20,lane.color,0);
      else if(incoming)cell.append(svgElement('path',{d:'M '+x+' 0 V 22',fill:'none',stroke:current.color,'stroke-width':1.8}));
    });
    for(const hash of parents){const index=next.findIndex(lane=>lane.hash===hash);connect(x,16+index*20,next[index].color,22)}
    if(isHead(row))cell.append(svgElement('circle',{class:'head-node',cx:x,cy:22,r:8,stroke:current.color}));
    cell.append(svgElement('circle',{class:'node'+(parents.length>1?' merge-node':''),cx:x,cy:22,r:4,stroke:current.color}));
    cells.push(cell);lanes=next;
  }
  const width=Math.max(56,maxLanes*20+12);for(const cell of cells){cell.setAttribute('width',width);cell.setAttribute('viewBox','0 0 '+width+' 44')}
  return {cells,width};
}
function isHead(row){return (row.refs||'').split(', ').some(ref=>ref==='HEAD'||ref.startsWith('HEAD -> '))}
function label(className,text){const element=document.createElement('span');element.className=className;element.textContent=text;return element}
function draw(){
  rows.replaceChildren();if(!data)return;
  const branch=document.getElementById('branch');branch.textContent=data.branch||'分离 HEAD';branch.title=branch.textContent;
  const commits=data.rows.filter(row=>row.hash);
  // Search hits can skip ancestors; omit edges instead of accumulating orphan lanes.
  const {cells,width}=graphCells(filtered()?commits.map(row=>({...row,parents:[]})):commits);rows.parentElement.style.setProperty('--graph-width',width+'px');
  let count=0;
  for(const row of commits){
    const item=document.createElement('div');item.dataset.hash=row.hash;item.className='row'+(isHead(row)?' current':'')+(selectedHash===row.hash?' selected':'');
    item.dataset.vscodeContext=JSON.stringify({webviewSection:'commit',gitpeekCommitHash:row.hash,gitpeekGraphRepoId:repoId,gitpeekGraphGeneration:generation,preventDefaultContextMenuItems:true});
    const graph=cells[count++];
    const detail=document.createElement('button');detail.type='button';detail.className='commit';detail.dataset.hash=row.hash;
    detail.setAttribute('aria-label',(row.subject||'')+'，作者 '+(row.author||'')+'，'+row.hash+(row.refs?'，'+row.refs:''));
    detail.append(graph);
    const message=label('message',''),subject=label('subject',row.subject||'（无标题）');subject.title=row.subject||'';
    if(row.refs){
      const refs=label('refs','');refs.title=row.refs;
      for(const value of row.refs.split(', ')){
        const head=value==='HEAD'||value.startsWith('HEAD -> '),tag=value.startsWith('tag: ');
        const ref=label('ref'+(head?' head':tag?' tag':''),head?(value==='HEAD'?'HEAD':value.slice(8)):tag?value.slice(5):value);ref.title=value;refs.append(ref);
      }
      message.append(refs);
    }
    message.append(subject);detail.append(message);
    const author=label('author',''),avatar=label('avatar',(row.author||'?').trim().slice(0,1).toUpperCase());avatar.setAttribute('aria-hidden','true');
    const url=avatars[(row.email||'').toLowerCase()];
    if(url){const img=document.createElement('img');img.alt='';img.loading='lazy';img.src=url;img.onerror=()=>img.remove();avatar.append(img)}
    author.title=(row.author||'')+(row.email?' <'+row.email+'>':'');author.append(avatar,label('author-name',row.author||'未知作者'));detail.append(author);
    const time=new Date((row.time||0)*1000),date=label('date',time.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}));date.title=time.toLocaleString('zh-CN');
    detail.title=(row.subject||'（无标题）')+'\\n'+(row.author||'')+' · '+date.title+'\\n'+row.hash+(row.refs?'\\n'+row.refs:'');
    const hash=label('hash',row.hash.slice(0,7));hash.title=row.hash;detail.append(date,hash);item.append(detail);
    const actions=document.createElement('button');actions.type='button';actions.className='row-action';actions.dataset.actionsHash=row.hash;actions.textContent='⋯';actions.title='提交操作';actions.setAttribute('aria-label','提交操作：'+row.hash);item.append(actions);
    rows.append(item);
  }
  status.textContent=count?'已显示 '+count+' 条提交'+(data.hasMore?' · 可加载更多':''):'仓库暂无提交';
  if(filtered()||query?.scope==='current')status.textContent=(query.scope==='current'?'当前分支':'全部分支')+(query.text?' · '+({message:'消息',author:'作者',hash:'Hash',code:'代码变化'}[query.kind])+': '+query.text:'')+(query.path?' · 路径: '+query.path:'')+(query.since?' · 从 '+query.since:'')+(query.until?' · 至 '+query.until:'')+' · '+(count?'已显示 '+count+' 条提交'+(data.hasMore?' · 可加载更多':''):'没有匹配的提交');
  if(!count)rows.append(label('empty',filtered()||query?.scope==='current'?'没有匹配的提交，请修改搜索条件或清除搜索。':'还没有提交，完成首次提交后即可查看历史。'));
  more.hidden=!data.hasMore;
}
document.addEventListener('click',event=>{const action=event.target.closest('[data-action]');if(action){if(action.dataset.action==='clearSearch'){searchText.value='';searchPath.value='';searchSince.value='';searchUntil.value='';submitSearch()}else vscode.postMessage({type:action.dataset.action,repoId,generation});return}const commitActions=event.target.closest('[data-actions-hash]');if(commitActions){vscode.postMessage({type:'actions',hash:commitActions.dataset.actionsHash,repoId,generation});return}const commit=event.target.closest('[data-hash]');if(commit){selectedHash=commit.dataset.hash;vscode.postMessage({type:'commit',hash:commit.dataset.hash});draw()}});
window.addEventListener('message',event=>{const message=event.data;if(message.type==='loading'){data=undefined;rows.replaceChildren();more.hidden=true;status.textContent='正在加载…'}else if(message.type==='error'){data=undefined;rows.replaceChildren(label('empty',message.message));more.hidden=true;status.textContent=message.message;}else if(message.type==='render'){const switchedRepo=repoId!==message.repoId;data=message.data;query=message.query;repoId=message.repoId;generation=message.generation;if(query&&(!searchDirty||switchedRepo)){searchText.value=query.text;searchKind.value=query.kind;searchScope.value=query.scope;searchPath.value=query.path||'';searchSince.value=query.since||'';searchUntil.value=query.until||'';searchDirty=false}updateSearchControls();for(const action of ['cherryContinue','cherryAbort'])document.querySelector('[data-action="'+action+'"]').hidden=!message.cherryInProgress;draw()}else if(message.type==='select'&&message.repoId===repoId&&message.generation===generation){selectedHash=message.hash;draw();[...rows.children].find(row=>row.dataset.hash===selectedHash)?.scrollIntoView?.({block:'nearest'})}else if(message.type==='avatars'){avatars=message.avatars||{};draw()}});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
