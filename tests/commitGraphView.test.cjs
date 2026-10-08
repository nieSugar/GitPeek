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
      constructor(name) { this.name = name; this.children = []; this.attributes = {}; this.dataset = {}; this.style = { setProperty() {} }; }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      setAttribute(name, value) { this.attributes[name] = value; }
    }
    const elements = Object.fromEntries(['rows', 'status', 'more', 'branch', 'cherryContinue', 'cherryAbort'].map(id => [id, new Element('div')]));
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
    console.log('Commit graph Webview passed (CSP, SVG lanes, refs, empty state and actions).');
  } finally {
    Module._load = originalLoad;
    if (!directory.startsWith(tmpdir() + sep)) throw new Error('Temporary graph view escaped temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
