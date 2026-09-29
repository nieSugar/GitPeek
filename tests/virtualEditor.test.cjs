const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'gitpeek-virtual-editor-'));
  const vscode = {
    TabInputText: class { constructor(uri) { this.uri = uri; } },
    TabInputTextDiff: class { constructor(original, modified) { this.original = original; this.modified = modified; } },
    TabInputWebview: class { constructor(viewType) { this.viewType = viewType; } },
    window: { tabGroups: { activeTabGroup: { activeTab: undefined } } },
  };
  const originalLoad = Module._load;
  try {
    const outfile = join(directory, 'virtualEditor.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'virtualEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile });
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    const { isGitPeekEditor } = require(outfile);
    const uri = (scheme) => ({ scheme });
    const tab = (input) => { vscode.window.tabGroups.activeTabGroup.activeTab = { input }; };
    tab(new vscode.TabInputTextDiff(uri('gitpeek-commit'), uri('gitpeek-commit')));
    assert.equal(isGitPeekEditor(undefined), true, 'transient undefined editor during GitPeek diff preserves context');
    assert.equal(isGitPeekEditor({ document: { uri: uri('gitpeek-review') } }), true);
    assert.equal(isGitPeekEditor({ document: { uri: uri('file') } }), false, 'real file takes precedence over previous diff tab');
    tab(new vscode.TabInputTextDiff(uri('file'), uri('file')));
    assert.equal(isGitPeekEditor(undefined), false);
    tab(new vscode.TabInputText(uri('gitpeek-branch')));
    assert.equal(isGitPeekEditor(undefined), true);
    tab(new vscode.TabInputWebview('gitpeek.commitGraph'));
    assert.equal(isGitPeekEditor(undefined), true, 'graph tab preserves repository context');
    tab(new vscode.TabInputWebview('unrelated.view'));
    assert.equal(isGitPeekEditor(undefined), false);
    vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
    assert.equal(isGitPeekEditor(undefined), false, 'closing the last editor clears context');
    console.log('Virtual editor transition check passed.');
  } finally {
    Module._load = originalLoad;
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
