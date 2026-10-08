const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-search-'));
  try {
    const repo = { id: 'search', root: path.join(temp, 'repo') };
    fs.mkdirSync(repo.root);
    const git = (...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Search Test');
    git('config', 'user.email', 'search@example.invalid');
    fs.writeFileSync(path.join(repo.root, 'file.txt'), 'base\n', 'utf8');
    git('add', '--all');
    git('commit', '-m', '根提交');
    const root = git('rev-parse', 'HEAD');
    git('switch', '-c', 'side');
    git('commit', '--allow-empty', '-m', '隐藏消息 [.*]', '--author=Unique Side <side@example.invalid>');
    const hidden = git('rev-parse', 'HEAD');
    git('switch', 'main');
    for (let index = 1; index <= 3; index++) git('commit', '--allow-empty', '-m', `ordinary ${index}`);
    const tip = git('rev-parse', 'HEAD');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '../src/features/commitGraphData.ts'), path.join(__dirname, '../src/git/GitService.ts')],
      bundle: true, platform: 'node', format: 'cjs', outdir: temp, outExtension: { '.js': '.cjs' },
    });
    const { loadGraph } = require(path.join(temp, 'features/commitGraphData.cjs'));
    const service = new (require(path.join(temp, 'git/GitService.cjs')).GitService)();
    const hashes = result => result.rows.filter(row => row.hash).map(row => row.hash);
    for (const [kind, text] of [['message', '隐藏消息 [.*]'], ['author', 'unique side'], ['hash', hidden.slice(0, 9)]]) {
      assert.deepEqual(hashes(await loadGraph(service, repo, 100, { kind, text, scope: 'all' })), [hidden], kind + ' all scope');
      assert.deepEqual(hashes(await loadGraph(service, repo, 100, { kind, text, scope: 'current' })), []);
    }
    for (const scope of ['all', 'current']) {
      const result = await loadGraph(service, repo, 1, { kind: 'hash', text: tip.slice(0, 9), scope });
      assert.deepEqual(hashes(result), [tip], 'non-root Hash search never includes ancestors');
      assert.equal(result.hasMore, false, 'exact Hash search has no additional page');
    }
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { kind: 'hash', text: root, scope: 'current' })), [root]);
    for (const [limit, hasMore] of [[1, true], [2, true], [3, false]]) {
      const result = await loadGraph(service, repo, limit, { kind: 'message', text: 'ordinary', scope: 'current' });
      assert.equal(hashes(result).length, limit);
      assert.equal(result.hasMore, hasMore);
    }
    console.log('Search regressions passed (non-root Hash, literal Chinese messages, case-insensitive author, branch scopes and pagination).');
  } finally {
    const resolved = path.resolve(temp);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Search check escaped temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
