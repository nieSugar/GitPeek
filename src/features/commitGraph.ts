import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import { checkoutCommit } from './checkoutCommit';
import { abortCherryPick, cherryPickCommit, cherryPickInProgress, continueCherryPick } from './cherryPickCommit';
import {
  avatarByEmail, createAndSwitchBranch, loadGraph, mergeLocalBranch, parseGitHubRemote,
  switchLocalBranch, type GraphSnapshot,
} from './commitGraphData';

export function registerCommitGraph(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => Promise<void>,
): { refresh(): Promise<void> } {
  let panel: vscode.WebviewPanel | undefined;
  let repo: Repository | undefined;
  let snapshot: GraphSnapshot | undefined;
  let ready = false;
  let limit = 100;
  let generation = 0;
  const avatarCache = new Map<string, { expires: number; avatars: Record<string, string> }>();

  const refresh = async (): Promise<void> => {
    if (!panel || !repo || !ready) return;
    const current = ++generation;
    const target = repo;
    snapshot = undefined;
    void panel.webview.postMessage({ type: 'loading' });
    try {
      const [data, cherryInProgress] = await Promise.all([loadGraph(git, target, limit), cherryPickInProgress(git, target)]);
      if (current !== generation || !panel || repo?.id !== target.id) return;
      snapshot = data;
      void panel.webview.postMessage({ type: 'render', data, limit, cherryInProgress });
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
    if (repo?.id !== selected.id) snapshot = undefined;
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

  const handleMessage = async (message: unknown): Promise<void> => {
    if (!panel || !repo || !message || typeof message !== 'object') return;
    const action = (message as { type?: unknown }).type;
    if (action === 'ready') { ready = true; await refresh(); return; }
    if (action === 'refresh') { await refresh(); return; }
    if (action === 'loadMore') { limit = Math.min(500, limit + 100); await refresh(); return; }
    if (action === 'commit') {
      const hash = (message as { hash?: unknown }).hash;
      if (typeof hash === 'string' && snapshot?.rows.some(row => row.hash === hash)) await showCommit(repo, hash);
      return;
    }
    if (action === 'actions') {
      const hash = (message as { hash?: unknown }).hash;
      const targetRepo = repo;
      const targetSnapshot = snapshot;
      const targetGeneration = generation;
      const valid = (): boolean => Boolean(panel && targetRepo && repo?.id === targetRepo.id && snapshot === targetSnapshot && generation === targetGeneration && typeof hash === 'string' && snapshot?.rows.some(row => row.hash === hash));
      if (!valid()) return;
      let selectedAction: string | undefined;
      try {
        const selected = await vscode.window.showQuickPick([
          { label: '复制完整 Hash', action: 'copy' },
          { label: '检出此提交', action: 'checkout' },
          { label: 'Cherry-pick 到当前分支', action: 'cherryPick' },
        ], {
          title: `GitPeek：提交 ${String(hash).slice(0, 7)}`, placeHolder: '选择提交操作',
        });
        if (!selected || !valid()) return;
        selectedAction = selected.action;
        if (selected.action === 'copy') {
          await vscode.env.clipboard.writeText(hash as string);
          if (valid()) await vscode.window.showInformationMessage('GitPeek：已复制完整 Commit Hash。');
        } else if (selected.action === 'checkout') {
          const confirmed = await vscode.window.showWarningMessage(
            `检出提交 ${String(hash).slice(0, 7)} 并进入分离 HEAD 状态？工作区必须干净。`,
            { modal: true }, '检出',
          );
          if (confirmed !== '检出' || !valid()) return;
          await checkoutCommit(git, targetRepo, hash as string);
          await vscode.commands.executeCommand('gitpeek.refresh');
          await refresh();
        } else if (selected.action === 'cherryPick') {
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
body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family);}
header{position:sticky;top:0;z-index:2;padding:12px 16px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.top strong{font-size:16px}#branch{color:var(--vscode-descriptionForeground)}
.actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}button{cursor:pointer;font:inherit} .actions button,#more{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:3px;padding:5px 9px}.actions button:hover,#more:hover{background:var(--vscode-button-hoverBackground)}.actions button[hidden]{display:none}
#status{padding:8px 16px;color:var(--vscode-descriptionForeground)}#rows{overflow:auto}.row{display:flex;align-items:center;width:100%;min-height:30px;box-sizing:border-box;padding:2px 16px;border-bottom:1px solid var(--vscode-panel-border);gap:8px}.commit{min-width:0;flex:1;display:flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:inherit;text-align:left;font:inherit}.commit:hover,.commit:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder)}.row-action{flex:none;border:0;border-radius:3px;padding:4px 8px;background:transparent;color:inherit}.row-action:hover,.row-action:focus-visible{background:var(--vscode-toolbar-hoverBackground);outline:1px solid var(--vscode-focusBorder)}
.graph{flex:none;white-space:pre;font:16px/24px monospace}.avatar{flex:none;position:relative;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;font-weight:bold;overflow:hidden}.avatar img{position:absolute;width:100%;height:100%;object-fit:cover}.subject{min-width:120px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{color:var(--vscode-descriptionForeground);white-space:nowrap}.ref{padding:1px 5px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);white-space:nowrap}.connector{min-height:15px;height:15px;border:0;padding-top:0;padding-bottom:0}.connector .graph{line-height:15px}#more{margin:12px 16px}#more[hidden]{display:none}
</style></head><body><header><div class="top"><strong>提交图</strong><span id="branch"></span></div><div class="actions"><button data-action="switch">切换分支</button><button data-action="create">新建分支</button><button data-action="merge">合并分支</button><button data-action="cherryContinue" hidden>继续 Cherry-pick</button><button data-action="cherryAbort" hidden>中止 Cherry-pick</button><button data-action="refresh">刷新</button></div></header><div id="status">正在加载…</div><main id="rows" aria-label="提交历史"></main><button id="more" data-action="loadMore" hidden>加载更多</button>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), rows=document.getElementById('rows'), status=document.getElementById('status'), more=document.getElementById('more');
const colors=['#64b5f6','#ffb74d','#81c784','#ba68c8','#e57373','#4dd0e1','#ffd54f','#a1887f'];let data,avatars={};
function graphCell(text,width){const cell=document.createElement('span');cell.className='graph';cell.style.width=width+'ch';for(let i=0;i<text.length;i++){const s=document.createElement('span'),c=text[i];s.style.color=colors[Math.floor(i/2)%colors.length];s.textContent=c.charCodeAt(0)===92?'╲':({'*':'●','|':'│','/':'╱','_':'─'})[c]||c;cell.append(s)}return cell}
function draw(){rows.replaceChildren();if(!data)return;document.getElementById('branch').textContent=data.branch||'分离 HEAD';const width=Math.max(3,...data.rows.map(r=>r.graph.length));for(const row of data.rows){const item=document.createElement('div');item.className='row '+(row.hash?'':'connector');if(row.hash){const detail=document.createElement('button');detail.type='button';detail.className='commit';detail.dataset.hash=row.hash;detail.setAttribute('aria-label',(row.subject||'')+'，作者 '+(row.author||'')+'，'+row.hash);detail.append(graphCell(row.graph,width));const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=(row.author||'?').trim().slice(0,1).toUpperCase();const url=avatars[(row.email||'').toLowerCase()];if(url){const img=document.createElement('img');img.alt='';img.loading='lazy';img.src=url;img.onerror=()=>img.remove();avatar.append(img)}detail.append(avatar);const subject=document.createElement('span');subject.className='subject';subject.textContent=row.subject||'（无标题）';subject.title=row.subject||'';detail.append(subject);if(row.refs){const ref=document.createElement('span');ref.className='ref';ref.textContent=row.refs;detail.append(ref)}const meta=document.createElement('span');meta.className='meta';meta.textContent=(row.author||'')+' · '+new Date((row.time||0)*1000).toLocaleDateString('zh-CN')+' · '+row.hash.slice(0,7);detail.append(meta);item.append(detail);const actions=document.createElement('button');actions.type='button';actions.className='row-action';actions.dataset.actionsHash=row.hash;actions.textContent='⋯';actions.title='提交操作';actions.setAttribute('aria-label','提交操作：'+row.hash);item.append(actions)}else item.append(graphCell(row.graph,width));rows.append(item)}status.textContent=data.rows.some(r=>r.hash)?'点击提交查看详情；合并前需保持工作区干净。':'仓库暂无提交。';more.hidden=!data.hasMore}
document.addEventListener('click',event=>{const action=event.target.closest('[data-action]');if(action){vscode.postMessage({type:action.dataset.action});return}const commitActions=event.target.closest('[data-actions-hash]');if(commitActions){vscode.postMessage({type:'actions',hash:commitActions.dataset.actionsHash});return}const commit=event.target.closest('[data-hash]');if(commit)vscode.postMessage({type:'commit',hash:commit.dataset.hash})});
window.addEventListener('message',event=>{const message=event.data;if(message.type==='loading')status.textContent='正在加载…';else if(message.type==='error')status.textContent=message.message;else if(message.type==='render'){data=message.data;for(const action of ['cherryContinue','cherryAbort'])document.querySelector('[data-action="'+action+'"]').hidden=!message.cherryInProgress;draw()}else if(message.type==='avatars'){avatars=message.avatars||{};draw()}});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}
