import assert from 'node:assert/strict';
import path from 'node:path';
import { FileHistoryService, relativeHistoryPath } from '../src/features/history.ts';

const repo = { id: 'repo-1', root: path.resolve('历史 工作区') };
const file = relativeHistoryPath(repo.root, path.join(repo.root, '中文 目录', 'a & b;[x].ts'));
assert.equal(file, '中文 目录/a & b;[x].ts');

let head = 'first-head';
let now = 10_000;
const queries = [];
const git = {
  async run(_repo, args) {
    assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD']);
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

  head = 'second-head';
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
