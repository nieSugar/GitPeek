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
    const { loadGraph, normalizeGraphQuery } = require(path.join(temp, 'features/commitGraphData.cjs'));
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
    const targetPath = 'src/[x].txt';
    fs.mkdirSync(path.join(repo.root, 'src'));
    const literal = ' 中文 [.*] Needle ';
    const datedCommit = (date, content, subject) => {
      fs.writeFileSync(path.join(repo.root, targetPath), content, 'utf8');
      git('add', '--all');
      execFileSync('git', ['-C', repo.root, 'commit', '-m', subject], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T12:00:00Z', GIT_COMMITTER_DATE: new Date(date).toISOString() },
      });
      return git('rev-parse', 'HEAD');
    };
    const added = datedCommit('2024-03-01T00:00:00', `start\n${literal}\nend\n`, 'added code');
    fs.writeFileSync(path.join(repo.root, 'src/x.txt'), 'another file\n', 'utf8');
    const moved = datedCommit('2024-02-28T12:00:00', `${literal}\nstart\nend\n`, 'moved code with an older committer date');
    const removed = datedCommit('2024-03-01T23:59:59', 'start\nend\n', 'removed code');
    const after = datedCommit('2024-03-02T00:00:00', 'outside date range\n', 'after range');
    const codeQuery = { kind: 'code', text: literal, scope: 'current', path: targetPath };
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, codeQuery)), [removed, added], 'literal -S detects count changes, not moves with the same count');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...codeQuery, text: literal.toUpperCase() })), []);
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...codeQuery, text: '中文 .*' })), [], 'code search does not enable regular expressions');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...codeQuery, text: '中文 [.*] Needle  ' })), [], 'code search retains meaningful spaces');
    const pathQuery = { kind: 'message', text: '', scope: 'current', path: targetPath };
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, pathQuery)), [after, removed, moved, added], 'path brackets stay literal');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...pathQuery, path: 'src/x.txt' })), [moved]);
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...pathQuery, path: ':(glob)**' })), [], 'pathspec magic stays literal');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...pathQuery, path: '--all' })), [], 'path options stay literal');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...pathQuery, path: 'src' })), [after, removed, moved, added], 'directory filters include contained files');
    const datedQuery = { ...pathQuery, since: '2024-03-01', until: '2024-03-01' };
    const dated = await loadGraph(service, repo, 100, datedQuery);
    assert.equal(dated.rows.find(row => row.hash === removed).time, new Date('2024-03-01T23:59:59').getTime() / 1000, 'displayed date matches the filtered committer date');
    assert.deepEqual(hashes(dated), [removed, added], 'local date boundaries are inclusive and older-dated children do not hide matching ancestors');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...datedQuery, ...codeQuery })), [removed, added], 'code, path and dates combine');
    for (const query of [codeQuery, datedQuery]) {
      const first = await loadGraph(service, repo, 1, query);
      const expanded = await loadGraph(service, repo, 2, query);
      assert.deepEqual(hashes(first), [removed]); assert.equal(first.hasMore, true);
      assert.deepEqual(hashes(expanded), [removed, added]); assert.equal(expanded.hasMore, false);
    }
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...datedQuery, kind: 'hash', text: added })), [added], 'exact hash supports date and path filters');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { ...datedQuery, kind: 'hash', text: after })), []);
    for (const bad of [
      { since: '2024-02-30' }, { until: 'tomorrow' }, { since: '2024-03-02', until: '2024-03-01' },
      { path: '../outside' }, { path: 'src/../outside' }, { path: '/outside' }, { path: 'C:\\outside' }, { path: 'C:outside' },
      { path: '\0' }, { path: 12 }, { text: '\0' }, { text: 'x'.repeat(501) }, { kind: 'unknown' }, { scope: 'unknown' },
    ]) await assert.rejects(loadGraph(service, repo, 100, { ...pathQuery, ...bad }));
    assert.equal(normalizeGraphQuery({ ...pathQuery, path: 'src\\[x].txt' }).path, targetPath, 'Windows relative paths normalize once');
    git('switch', 'side');
    fs.writeFileSync(path.join(repo.root, 'side.txt'), 'SideOnlyNeedle\n', 'utf8');
    git('add', '--all'); git('commit', '-m', 'side code');
    const sideCode = git('rev-parse', 'HEAD');
    git('switch', 'main');
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { kind: 'code', text: 'SideOnlyNeedle', scope: 'all', path: 'side.txt' })), [sideCode]);
    assert.deepEqual(hashes(await loadGraph(service, repo, 100, { kind: 'code', text: 'SideOnlyNeedle', scope: 'current', path: 'side.txt' })), []);
    console.log('Search regressions passed (Hash, literal code/path, inclusive local dates, unordered dates, invalid inputs, scopes and pagination).');
  } finally {
    const resolved = path.resolve(temp);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Search check escaped temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
