const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, sep } = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'gitpeek-graph-view-'));
  const originalLoad = Module._load;
  try {
    const outfile = join(directory, 'view.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'commitGraph.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile });
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return {};
      return originalLoad.call(this, request, parent, isMain);
    };
    const { graphHtml } = require(outfile);
    const html = graphHtml();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script, 'graph webview script is present');
    new vm.Script(script, { filename: 'GitPeek graph webview' });
    assert.match(html, /script-src 'nonce-/);
    assert.match(html, /切换分支/);
    assert.match(script, /dataset\.actionsHash=row\.hash/);
    assert.match(script, /type:'actions',hash:commitActions\.dataset\.actionsHash/);
    assert.match(script, /type:'commit',hash:commit\.dataset\.hash/);
    assert.match(html, /继续 Cherry-pick/);
    assert.match(html, /中止 Cherry-pick/);

    // Exercise the actual webview script without adding a DOM dependency.
    class Element {
      constructor(name) { this.name = name; this.children = []; this.attributes = {}; this.dataset = {}; this.style = { setProperty: (name, value) => { this.style[name] = value; } }; }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      setAttribute(name, value) { this.attributes[name] = value; }
      addEventListener(type, listener) { this[type] = listener; }
      scrollIntoView(options) { this.scrollOptions = options; }
    }
    const elements = Object.fromEntries(['rows', 'status', 'more', 'branch', 'cherryContinue', 'cherryAbort', 'search', 'searchKind', 'searchText', 'searchScope', 'searchPath', 'searchSince', 'searchUntil'].map(id => [id, new Element('div')]));
    elements.rows.parentElement = new Element('main');
    const messages = [];
    let receive, click;
    const context = vm.createContext({
      acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
      document: {
        getElementById: id => elements[id],
        createElement: name => new Element(name),
        createElementNS: (_namespace, name) => new Element(name),
        querySelector: selector => elements[/data-action="([^"]+)"/.exec(selector)[1]],
        addEventListener: (_type, listener) => { click = listener; },
      },
      window: { addEventListener: (_type, listener) => { receive = listener; } },
    });
    vm.runInContext(script, context);
    assert.equal(messages[0].type, 'ready');
    const merge = { graph: '* ', hash: 'a'.repeat(40), parents: ['b'.repeat(40), 'c'.repeat(40)], subject: '<script>literal text</script>', author: '作者', refs: 'HEAD -> main, origin/main, tag: v1' };
    const root = { graph: '* ', hash: 'b'.repeat(40), parents: [], author: '作者' };
    const snapshot = { branch: 'main', rows: [merge, { graph: '|\\' }, { graph: '| * ', hash: 'c'.repeat(40), parents: [root.hash] }, { graph: '|/' }, root], hasMore: true };
    receive({ data: { type: 'render', data: snapshot, cherryInProgress: true, repoId: 'graph-repo', generation: 7 } });
    assert.equal(elements.rows.children.length, 3, 'ASCII connector rows do not add gaps between commits');
    assert.equal(elements.rows.children[0].className, 'row current');
    assert.deepEqual(JSON.parse(elements.rows.children[0].dataset.vscodeContext), {
      webviewSection: 'commit', gitpeekCommitHash: merge.hash,
      gitpeekGraphRepoId: 'graph-repo', gitpeekGraphGeneration: 7, preventDefaultContextMenuItems: true,
    });
    assert.equal(elements.status.textContent, '已显示 3 条提交 · 可加载更多');
    assert.equal(elements.more.hidden, false);
    assert.equal(elements.cherryContinue.hidden, false);
    const detail = elements.rows.children[0].children[0];
    assert.equal(detail.dataset.hash, merge.hash);
    assert.equal(detail.children[1].children[1].textContent, merge.subject, 'subjects stay plain text');
    assert.deepEqual(detail.children[1].children[0].children.map(ref => ref.textContent), ['main', 'origin/main', 'v1']);
    assert.equal(detail.children[0].attributes.height, '44');
    assert.equal(detail.children[0].children.at(-1).attributes.class, 'node merge-node');
    assert.equal(detail.children[0].children[1].attributes.d, 'M 16 22 V 22 C 16 33 36 33 36 44', 'merge splits into its second parent lane');
    assert.equal(elements.rows.children[1].children[0].children[0].children[2].attributes.d, 'M 36 22 V 22 C 36 33 16 33 16 44', 'side branch joins its existing parent lane');
    assert.equal(elements.rows.children[2].children[0].children[0].children[0].attributes.d, 'M 16 0 V 22', 'root does not continue to a nonexistent parent');
    const complex = context.graphCells([
      { hash: 'tip', parents: ['m', 'f'] }, { hash: 'm', parents: ['d', 'b', 'c'] },
      { hash: 'f', parents: ['d', 'e'] }, { hash: 'c', parents: ['base'] },
      { hash: 'd', parents: ['a'] }, { hash: 'e', parents: ['b'] },
      { hash: 'a', parents: ['base'] }, { hash: 'b', parents: ['base'] }, { hash: 'base', parents: [] },
    ]).cells;
    const paths = cell => cell.children.filter(child => child.name === 'path').map(child => child.attributes.d);
    assert.equal(paths(complex[1]).filter(d => d.startsWith('M 16 22')).length, 3, 'octopus merge retains all three parents');
    for (let index = 1; index < complex.length; index++) {
      const ends = new Set(paths(complex[index - 1]).map(d => / (\d+) 44$/.exec(d)?.[1]).filter(Boolean));
      const starts = new Set(paths(complex[index]).map(d => /^M (\d+) 0 /.exec(d)?.[1]).filter(Boolean));
      assert.deepEqual(starts, ends, 'all lanes stay connected across row ' + index);
    }
    assert.equal(paths(complex.at(-1)).some(d => d.endsWith(' 44')), false);
    assert.equal(paths(context.graphCells([{ hash: 'tip', parents: ['outside-page'] }]).cells[0]).length, 1, 'pagination keeps the outgoing parent lane');
    for (const [selector, target, type] of [
      ['[data-action]', { dataset: { action: 'switch' } }, 'switch'],
      ['[data-hash]', detail, 'commit'],
      ['[data-actions-hash]', elements.rows.children[0].children[1], 'actions'],
    ]) {
      click({ target: { closest: value => value === selector ? target : null } });
      assert.equal(messages.at(-1).type, type);
      if (type !== 'switch') assert.equal(messages.at(-1).hash, merge.hash);
    }
    receive({ data: { type: 'render', data: { branch: '', rows: [], hasMore: false }, cherryInProgress: false } });
    assert.equal(elements.branch.textContent, '分离 HEAD');
    assert.equal(elements.rows.children[0].className, 'empty');
    assert.equal(elements.more.hidden, true);
    assert.equal(elements.cherryContinue.hidden, true);
    elements.searchKind.value = 'author'; elements.searchText.value = 'Ancient'; elements.searchScope.value = 'all';
    elements.search.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'search', kind: 'author', text: 'Ancient', scope: 'all' });
    receive({ data: { type: 'render', data: { branch: 'main', rows: [root], hasMore: false }, query: { kind: 'author', text: 'Ancient', scope: 'all' } } });
    assert.match(elements.status.textContent, /全部分支 · 作者: Ancient/);
    click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'clearSearch' } } : null } });
    assert.equal(messages.at(-1).type, 'search'); assert.equal(messages.at(-1).text, '');
    const renderSearch = (query, commits = [], hasMore = false, repoId = 'search-repo') => receive({ data: {
      type: 'render', data: { branch: 'main', rows: commits, hasMore }, query, repoId, generation: 8,
    } });
    renderSearch({ kind: 'message', text: '', scope: 'all' }, [root]);
    elements.searchText.value = 'first'; elements.search.submit({ preventDefault() {} });
    elements.searchText.value = 'second'; elements.search.input();
    elements.searchKind.value = 'author'; elements.searchScope.value = 'current'; elements.search.change();
    renderSearch({ kind: 'message', text: 'first', scope: 'all' });
    assert.equal(elements.searchText.value, 'second', 'a completed query does not erase newer draft input');
    assert.equal(elements.searchKind.value, 'author'); assert.equal(elements.searchScope.value, 'current');
    assert.match(elements.status.textContent, /消息: first/);
    assert.match(elements.rows.children[0].textContent, /没有匹配的提交/);
    assert.doesNotMatch(elements.rows.children[0].textContent, /还没有提交/);
    elements.search.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'search', kind: 'author', text: 'second', scope: 'current' });
    const hits = Array.from({ length: 100 }, (_, index) => ({
      hash: index.toString(16).padStart(40, '0'), parents: [(index + 100).toString(16).padStart(40, '0')], subject: 'second',
    }));
    renderSearch({ kind: 'author', text: 'second', scope: 'current' }, hits, true);
    assert.equal(elements.rows.parentElement.style['--graph-width'], '56px', 'skipped ancestors do not widen the search graph');
    assert.equal(elements.rows.children[0].children[0].children[0].children.some(child => child.name === 'path'), false, 'filtered results do not draw unverifiable parent edges');
    assert.equal(elements.more.hidden, false);
    click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'loadMore' } } : null } });
    assert.equal(messages.at(-1).type, 'loadMore');
    receive({ data: { type: 'select', hash: hits[37].hash, repoId: 'search-repo', generation: 8 } });
    assert.equal(elements.rows.children[37].className, 'row selected');
    assert.equal(elements.rows.children[37].scrollOptions.block, 'nearest', 'detail navigation locates the commit in the graph');
    receive({ data: { type: 'select', hash: hits[42].hash, repoId: 'another-repo', generation: 8 } });
    assert.equal(elements.rows.children[37].className, 'row selected', 'selection from another repository is discarded');
    receive({ data: { type: 'select', hash: hits[42].hash, repoId: 'search-repo', generation: 7 } });
    assert.equal(elements.rows.children[37].className, 'row selected', 'stale graph selections are discarded');
    click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'clearSearch' } } : null } });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'search', kind: 'author', text: '', scope: 'current' });
    renderSearch({ kind: 'author', text: '', scope: 'current' }, [merge, root]);
    assert.equal(elements.rows.children[0].children[0].children[0].children.some(child => child.name === 'path'), true, 'clearing search restores normal graph edges');
    elements.searchText.value = 'unsent draft'; elements.search.input();
    renderSearch({ kind: 'message', text: '', scope: 'all' }, [root], false, 'other-repo');
    assert.equal(elements.searchText.value, '', 'repository changes reset draft queries');
    assert.equal(elements.searchScope.value, 'all');
    elements.searchKind.value = 'code'; elements.searchText.value = ' 中文 [.*] ';
    elements.searchPath.value = 'src/[x].txt'; elements.searchSince.value = '2024-03-01'; elements.searchUntil.value = '2024-03-02';
    elements.search.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'search', kind: 'code', text: ' 中文 [.*] ', scope: 'all', path: 'src/[x].txt', since: '2024-03-01', until: '2024-03-02' });
    renderSearch({ kind: 'message', text: '', scope: 'all', path: 'src/[x].txt', since: '2024-03-01', until: '2024-03-02' }, [merge, root], true, 'other-repo');
    assert.match(elements.status.textContent, /路径: src\/\[x\]\.txt · 从 2024-03-01 · 至 2024-03-02/);
    assert.equal(elements.rows.children[0].children[0].children[0].children.some(child => child.name === 'path'), false, 'path/date filters also omit unverifiable graph edges');
    elements.searchPath.value = 'draft.txt'; elements.searchUntil.value = '2024-03-03'; elements.search.input();
    renderSearch({ kind: 'message', text: '', scope: 'all', path: 'src/[x].txt', until: '2024-03-02' }, [root], false, 'other-repo');
    assert.equal(elements.searchPath.value, 'draft.txt'); assert.equal(elements.searchUntil.value, '2024-03-03', 'new filter drafts survive earlier responses');
    click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'clearSearch' } } : null } });
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'search', kind: 'message', text: '', scope: 'all' }, 'clear removes every extra filter');
    assert.equal(elements.searchPath.value, ''); assert.equal(elements.searchSince.value, ''); assert.equal(elements.searchUntil.value, '');
    renderSearch({ kind: 'message', text: '', scope: 'all', since: '2024-03-01' }, [], false, 'other-repo');
    assert.match(elements.rows.children[0].textContent, /没有匹配的提交/, 'date-only no-results is not an empty repository');
    receive({ data: { type: 'loading' } });
    assert.equal(elements.rows.children.length, 0, 'loading hides inactive rows from the previous query');
    assert.equal(elements.more.hidden, true);
    receive({ data: { type: 'error', message: 'Hash 查询失败' } });
    assert.equal(elements.rows.children[0].textContent, 'Hash 查询失败');
    assert.equal(elements.more.hidden, true, 'failed queries do not keep the previous load-more action');
    renderSearch({ kind: 'message', text: '', scope: 'all' }, [root]);
    assert.equal(elements.rows.children.length, 1, 'a corrected query recovers after errors');
    console.log('Commit graph Webview passed (CSP, SVG lanes, refs, empty state, actions and search regressions).');
  } finally {
    Module._load = originalLoad;
    if (!directory.startsWith(tmpdir() + sep)) throw new Error('Temporary graph view escaped temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
