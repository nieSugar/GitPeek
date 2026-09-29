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
    console.log('Commit graph Webview script and CSP check passed.');
  } finally {
    Module._load = originalLoad;
    if (!directory.startsWith(tmpdir() + sep)) throw new Error('Temporary graph view escaped temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
