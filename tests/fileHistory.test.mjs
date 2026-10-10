import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { build } from 'esbuild';

const temp = mkdtempSync(path.join(tmpdir(), 'gitpeek-history-'));
const outfile = path.join(temp, 'history.cjs');
await build({ entryPoints: [path.join(import.meta.dirname, '..', 'src', 'features', 'history.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile });
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { FileHistoryService, relativeHistoryPath } = createRequire(import.meta.url)(outfile);
Module._load = originalLoad;
rmSync(temp, { recursive: true, force: true });

const repo = { id: 'repo-1', root: path.resolve('历史 工作区') };
const file = relativeHistoryPath(repo.root, path.join(repo.root, '中文 目录', 'a & b;[x].ts'));
assert.equal(file, '中文 目录/a & b;[x].ts');

let head = 'a'.repeat(40);
let now = 10_000;
const queries = [];
const git = {
  async run(_repo, args) {
    assert.deepEqual(args, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
    return head;
  },
  async history(_repo, requestedFile, limit) {
    queries.push({ file: requestedFile, limit });
    return Array.from({ length: limit }, (_, index) => ({ subject: `commit ${index}` }));
  },
};
const originalNow = Date.now;
Date.now = () => now;
try {
  const history = new FileHistoryService(git);
  assert.equal((await history.load(repo, file)).commits.length, 20);
  assert.equal((await history.load(repo, file)).commits.length, 20);
  assert.deepEqual(queries, [{ file, limit: 21 }]);

  assert.equal((await history.load(repo, file, 40)).commits.length, 40);
  assert.deepEqual(queries.at(-1), { file, limit: 41 });
  const smallerPage = await history.load(repo, file, 20);
  assert.equal(smallerPage.commits.length, 20);
  assert.equal(smallerPage.hasMore, true);
  assert.equal(queries.length, 2);

  head = 'b'.repeat(40);
  await history.load(repo, file, 20);
  assert.equal(queries.length, 3, 'HEAD changes invalidate cached history');
  now += 60_001;
  await history.load(repo, file, 20);
  assert.equal(queries.length, 4, 'history cache expires after 60 seconds');

  history.invalidate();
  await history.load(repo, file, 20);
  assert.equal(queries.length, 5, 'explicit refresh invalidates cached history');
} finally {
  Date.now = originalNow;
}

const emptyRepositoryHistory = new FileHistoryService({
  async run() { throw new Error('HEAD does not exist'); },
  async history() { throw new Error('should not query log without a HEAD'); },
});
assert.deepEqual(await emptyRepositoryHistory.load(repo, file), { commits: [], hasMore: false });

console.log('File history cache and path checks passed.');
