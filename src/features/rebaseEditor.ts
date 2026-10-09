import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { RepositoryService } from '../git/RepositoryService';
import type { Repository } from '../git/types';
import {
  abortRebase, continueRebase, loadRebasePlan, readRebaseState, startRebase, validateRebaseSteps,
  type RebasePlan, type RebaseState,
} from './interactiveRebase';

interface Editor {
  repo: Repository;
  panel: vscode.WebviewPanel;
  token: string;
  plan?: RebasePlan;
  state?: RebaseState;
  busy: boolean;
  closed: boolean;
  detail?: string;
}

export function registerRebaseEditor(
  context: vscode.ExtensionContext,
  git: GitService,
  repositories: RepositoryService,
  showCommit: (repo: Repository, hash: string) => Promise<void>,
): { show(repo?: Repository, firstHash?: string): Promise<void> } {
  const editors = new Map<string, Editor>();
  const enabled = (): boolean => vscode.workspace.isTrusted !== false
    && vscode.workspace.getConfiguration('gitpeek').get<boolean>('enabled', true);
  const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

  const pickRepository = async (): Promise<Repository | undefined> => {
    const active = [...editors.values()].find(editor => editor.panel.active);
    if (active) return active.repo;
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri?.scheme === 'file' ? await repositories.forUri(uri) : undefined) ?? await repositories.pickRepository();
  };

  const requireSaved = (repo: Repository): void => {
    const dirty = vscode.workspace.textDocuments.find(document => {
      if (!document.isDirty || document.uri.scheme !== 'file') return false;
      const path = relative(repo.root, document.uri.fsPath);
      return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
    });
    if (dirty) throw new Error(`请先保存或关闭未保存的文件：${dirty.uri.fsPath}。`);
  };

  const postState = (editor: Editor): void => {
    if (!editor.closed) void editor.panel.webview.postMessage({
      type: 'state', state: editor.state, busy: editor.busy, canStart: Boolean(editor.plan), detail: editor.detail,
      canResume: Boolean(editor.state?.backupRef),
    });
  };

  const operate = async (editor: Editor, action: string, steps?: unknown): Promise<void> => {
    if (!enabled() || editor.closed || editor.busy) return;
    editor.busy = true;
    editor.detail = undefined;
    postState(editor);
    try {
      requireSaved(editor.repo);
      if (action === 'start') {
        if (!editor.plan || editor.state?.status === 'paused') return;
        const plan = editor.plan;
        const validated = validateRebaseSteps(plan, steps);
        const dropped = validated.filter(step => step.action === 'drop').length;
        const confirmed = await vscode.window.showWarningMessage(
          `整理“${plan.branch}”的 ${plan.commits.length} 个提交？`,
          { modal: true, detail: `提交顺序和消息将按预览重写${dropped ? `，其中 ${dropped} 个提交将被丢弃` : ''}。执行前会保存备份引用。` +
            (plan.published ? '\n所选历史已被本地远程跟踪引用包含。重写会影响协作者，请确认已协调；GitPeek 不会自动推送。' : '\n未在本地远程跟踪引用中发现这些提交；这不能证明它们从未推送。GitPeek 不会自动推送。') },
          '开始整理',
        );
        if (confirmed !== '开始整理' || editor.closed || !enabled()) return;
        requireSaved(editor.repo);
        editor.state = await startRebase(git, plan, validated);
        editor.plan = undefined;
      } else if (action === 'continue') {
        editor.state = await continueRebase(git, editor.repo);
        editor.plan = undefined;
      } else if (action === 'abort') {
        const confirmed = await vscode.window.showWarningMessage(
          '中止此次 rebase 并恢复原分支？',
          { modal: true, detail: '本次 rebase 期间的冲突解决和编辑改动会被丢弃，备份引用仍会保留。' }, '中止 rebase',
        );
        if (confirmed !== '中止 rebase' || editor.closed || !enabled()) return;
        requireSaved(editor.repo);
        editor.state = await abortRebase(git, editor.repo);
        editor.plan = undefined;
      }
      await vscode.commands.executeCommand('gitpeek.refresh', editor.repo);
    } catch (error) {
      editor.detail = errorText(error);
      const current = await readRebaseState(git, editor.repo).catch(() => undefined);
      if (current) { editor.state = current; editor.plan = undefined; }
      await vscode.window.showErrorMessage(`GitPeek：${editor.detail}`);
    } finally {
      editor.busy = false;
      postState(editor);
    }
  };

  const present = (repo: Repository, plan?: RebasePlan, state?: RebaseState): Editor => {
    const previous = editors.get(repo.id);
    if (previous) { previous.panel.reveal(); return previous; }
    const panel = vscode.window.createWebviewPanel('gitpeek.rebaseEditor', `GitPeek 整理提交 · ${basename(repo.root)}`, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
    });
    const editor: Editor = { repo, panel, plan, state, token: randomBytes(16).toString('hex'), busy: false, closed: false };
    editors.set(repo.id, editor);
    context.subscriptions.push(panel);
    panel.onDidDispose(() => { editor.closed = true; editors.delete(repo.id); });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || editor.closed) return;
      const value = message as Record<string, unknown>;
      if (value.type === 'ready') {
        void panel.webview.postMessage({ type: 'plan', plan: editor.plan, repo: repo.root, token: editor.token });
        postState(editor);
        return;
      }
      if (!enabled() || value.token !== editor.token || editor.busy) return;
      if (value.type === 'showCommit' && typeof value.hash === 'string' && editor.plan?.commits.some(commit => commit.hash === value.hash)) {
        try { await showCommit(repo, value.hash); } catch (error) { await vscode.window.showErrorMessage(errorText(error)); }
      } else if (value.type === 'start' || value.type === 'continue' || value.type === 'abort') {
        await operate(editor, value.type, value.steps);
      } else if (value.type === 'refresh') {
        try {
          const current = await readRebaseState(git, repo);
          if (current) { editor.state = current; editor.plan = undefined; }
          else if (editor.state?.status === 'paused') {
            editor.state = undefined;
            editor.detail = '当前没有进行中的 rebase。关闭面板后可重新选择提交。';
          }
          postState(editor);
        } catch (error) { editor.detail = errorText(error); postState(editor); }
      }
    });
    panel.webview.html = rebaseHtml();
    return editor;
  };

  const show = async (provided?: Repository, firstHash?: string): Promise<void> => {
    if (!enabled()) { await vscode.window.showInformationMessage('请启用 GitPeek 并信任当前工作区后再整理提交。'); return; }
    try {
      const repo = provided ?? await pickRepository();
      if (!repo) { await vscode.window.showInformationMessage('GitPeek：请先打开一个 Git 仓库。'); return; }
      const existing = editors.get(repo.id);
      if (existing) {
        existing.panel.reveal();
        if (!existing.busy) {
          const current = await readRebaseState(git, repo);
          if (current) { existing.state = current; existing.plan = undefined; }
          else if (existing.state?.status === 'paused') {
            existing.state = undefined;
            existing.detail = 'rebase 已在其他位置结束。关闭面板后可重新选择提交。';
          }
          postState(existing);
        }
        return;
      }
      const state = await readRebaseState(git, repo);
      if (state) { present(repo, undefined, state); return; }
      requireSaved(repo);
      if (!firstHash) {
        const log = await git.run(repo, ['log', '-100', '--format=%H%x1f%s', 'HEAD', '--']);
        const items = log.trim().split('\n').filter(Boolean).map(line => {
          const separator = line.indexOf('\x1f');
          return { hash: line.slice(0, separator), label: line.slice(separator + 1), description: line.slice(0, 8) };
        });
        const selected = await vscode.window.showQuickPick(items, {
          title: 'GitPeek：选择最早要整理的提交', placeHolder: '包含所选提交及其后直到 HEAD 的提交；更早的记录可从提交图打开',
        });
        if (!selected) return;
        firstHash = selected.hash;
      }
      present(repo, await loadRebasePlan(git, repo, firstHash));
    } catch (error) { await vscode.window.showErrorMessage(`GitPeek：${errorText(error)}`); }
  };

  context.subscriptions.push(vscode.commands.registerCommand('gitpeek.interactiveRebase', () => show()));
  for (const action of ['continue', 'abort'] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(`gitpeek.${action}Rebase`, async () => {
      if (!enabled()) return;
      try {
        const repo = await pickRepository();
        if (!repo) return;
        const state = await readRebaseState(git, repo);
        if (!state) { await vscode.window.showInformationMessage('GitPeek：当前没有进行中的 rebase。'); return; }
        await operate(present(repo, undefined, state), action);
      } catch (error) { await vscode.window.showErrorMessage(`GitPeek：${errorText(error)}`); }
    }));
  }
  return { show };
}

export function rebaseHtml(): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>整理提交</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:1000px;margin:auto;line-height:1.6}h1{font-size:22px;margin:0}p{color:var(--vscode-descriptionForeground)}button,select,textarea{font:inherit}button,select{padding:5px 10px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));border-radius:4px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button{cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}#start{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.toolbar,.row-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.toolbar{position:sticky;bottom:0;padding:16px 0;background:var(--vscode-editor-background)}ol{list-style:none;padding:0}li{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;margin:10px 0}.subject{flex:1;min-width:160px;overflow-wrap:anywhere}.hash{font-family:var(--vscode-editor-font-family);font-size:12px}.number{min-width:20px;color:var(--vscode-descriptionForeground)}textarea{box-sizing:border-box;display:block;width:100%;min-height:90px;margin-top:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:8px;resize:vertical}.drop .subject{text-decoration:line-through;color:var(--vscode-descriptionForeground)}#status,#backup,#repo{white-space:pre-wrap;overflow-wrap:anywhere}#status{border-left:3px solid var(--vscode-textLink-foreground);padding:10px 14px;background:var(--vscode-textBlockQuote-background)}#backup{font-size:12px;color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}@media(max-width:500px){body{padding:12px}.row-top{gap:6px}.subject{flex-basis:100%}}
</style></head><body>
<h1>整理提交</h1><p id="repo"></p>
<p>按从上到下的顺序重放提交。上移／下移调整顺序；点击 Hash 查看提交。仅支持线性历史。</p>
<p>Squash：合入前一个保留的提交并组合消息。Fixup：合入前一个保留的提交并丢弃自己的消息。暂停编辑：应用该提交后停下，可修改代码并 Amend，再继续。</p>
<div id="status" role="status" aria-live="polite">正在加载…</div><p id="backup"></p>
<ol id="commits" aria-label="提交执行顺序"></ol>
<div class="toolbar"><button id="start" disabled>开始整理</button><button id="continue" hidden>继续 rebase</button><button id="abort" hidden>中止 rebase</button><button id="refresh">刷新状态</button></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),list=document.getElementById('commits'),status=document.getElementById('status');
const start=document.getElementById('start'),next=document.getElementById('continue'),abort=document.getElementById('abort'),refresh=document.getElementById('refresh');
const actions=[['pick','保留'],['reword','修改消息'],['edit','暂停编辑'],['squash','Squash · 合并消息'],['fixup','Fixup · 保留前一条消息'],['drop','丢弃提交']];
let steps=[],commits=[],token,busy=false,canStart=false,paused=false,canResume=false;
function send(type,extra={}){vscode.postMessage({type,token,...extra})}
function button(text,label,handler){const node=document.createElement('button');node.type='button';node.textContent=text;node.setAttribute('aria-label',label);node.addEventListener('click',handler);return node}
function toggle(){start.disabled=busy||paused||!canStart;next.hidden=abort.hidden=!paused;next.disabled=abort.disabled=busy||!canResume;refresh.disabled=busy;for(const node of list.querySelectorAll('button,select,textarea'))node.disabled=busy||paused||!canStart}
function draw(focusIndex,focusAction){list.replaceChildren();steps.forEach((step,index)=>{
  const commit=commits.find(item=>item.hash===step.hash),row=document.createElement('li'),top=document.createElement('div');top.className='row-top';row.className=step.action==='drop'?'drop':'';
  const number=document.createElement('span');number.className='number';number.textContent=String(index+1);top.append(number);
  const hash=button(step.hash.slice(0,8),'查看提交 '+step.hash,()=>send('showCommit',{hash:step.hash}));hash.className='hash';top.append(hash);
  const subject=document.createElement('span');subject.className='subject';subject.textContent=commit.subject;top.append(subject);
  const select=document.createElement('select');select.setAttribute('aria-label','提交 '+(index+1)+' 的操作');actions.forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option)});select.value=step.action;select.addEventListener('change',()=>{step.action=select.value;if(step.action==='reword'&&step.message===undefined)step.message=commit.message;draw(index,'select')});top.append(select);
  const up=button('↑','上移提交 '+(index+1),()=>{if(index>0){[steps[index-1],steps[index]]=[steps[index],steps[index-1]];draw(index-1,'up')}});up.dataset.move='up';up.hidden=index===0;top.append(up);
  const down=button('↓','下移提交 '+(index+1),()=>{if(index<steps.length-1){[steps[index],steps[index+1]]=[steps[index+1],steps[index]];draw(index+1,'down')}});down.dataset.move='down';down.hidden=index===steps.length-1;top.append(down);row.append(top);
  if(step.action==='reword'||step.action==='squash'){const text=document.createElement('textarea');text.maxLength=20000;text.setAttribute('aria-label',step.action==='reword'?'新的提交消息':'合并后的消息（可选）');text.placeholder=step.action==='squash'?'留空时保留 Git 组合后的消息':'输入新的提交消息';text.value=step.message||'';text.addEventListener('input',()=>{step.message=text.value});row.append(text)}
  list.append(row);
});toggle();if(focusIndex!==undefined){const row=list.children[focusIndex];row?.querySelector(focusAction==='select'?'select':'[data-move="'+focusAction+'"]')?.focus()}}
start.addEventListener('click',()=>send('start',{steps:steps.map(step=>({hash:step.hash,action:step.action,...((step.action==='reword'||step.action==='squash')&&step.message?{message:step.message}:{})}))}));
next.addEventListener('click',()=>send('continue'));abort.addEventListener('click',()=>send('abort'));refresh.addEventListener('click',()=>send('refresh'));
window.addEventListener('message',event=>{const message=event.data;
  if(message.type==='plan'){token=message.token;commits=message.plan?.commits||[];steps=commits.map(commit=>({hash:commit.hash,action:'pick'}));document.getElementById('repo').textContent=message.repo+(message.plan?' · '+message.plan.branch+' · '+commits.length+' 个提交':'');draw()}
  if(message.type==='state'){busy=message.busy;canStart=message.canStart;paused=message.state?.status==='paused';canResume=message.canResume;
    status.textContent=busy?'正在处理，请稍候…':message.detail||message.state?.message||(paused?'rebase 已暂停。冲突请解决并暂存；暂停编辑请在源代码管理中修改、暂存并 Amend 后继续。':message.state?.status==='completed'?'提交整理已完成。':message.state?.status==='aborted'?'已中止并恢复原分支。':'调整顺序和操作后点击“开始整理”，执行前会再次确认。');
    document.getElementById('backup').textContent=message.state?.backupRef?'原历史备份：'+message.state.backupRef:'';toggle();
  }
});vscode.postMessage({type:'ready'});
</script></body></html>`;
}
