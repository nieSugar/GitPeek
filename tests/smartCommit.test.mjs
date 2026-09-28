import assert from 'node:assert/strict';
import { findGitRepositoryByRoot, generateCommitCandidates } from '../src/features/smartCommit.ts';

const staged = 'M\0src/device/config.ts\0A\0src/device/new.ts\0';
const conventional = generateCommitCandidates(staged, true, 'fix');
assert.equal(conventional.length, 8);
assert.equal(conventional[0].label, 'fix(device): update device');
assert.ok(conventional.every(({ label }) => label.trim().length > 0));
assert.equal(new Set(conventional.map(({ label }) => label)).size, conventional.length);
assert.deepEqual(conventional.map(({ description }) => description.split(' · ')[1]), [
  'fix', 'feat', 'refactor', 'perf', 'docs', 'test', 'style', 'chore',
]);

const renamed = generateCommitCandidates('R100\0old/old-name.ts\0new/new-name.ts\0', true, 'chore');
assert.equal(renamed[0].label, 'chore(new): rename new-name');
assert.ok(!renamed[0].label.includes('old-name'));

const specialPath = generateCommitCandidates('A\0目录 & 名/特殊\t文件.ts\0', true, 'bogus');
assert.equal(specialPath[0].label, 'chore(目录-名): add 特殊 文件');
assert.ok(specialPath.every(({ label }) => !/[\r\n\0]/.test(label) && label.trim().length > 0));

const plain = generateCommitCandidates('A\0README.md\0', false, 'chore');
assert.deepEqual(plain.map(({ label }) => label), ['Update README', 'Change README', 'Improve README']);
assert.equal(new Set(plain.map(({ label }) => label)).size, plain.length);
assert.deepEqual(generateCommitCandidates('', true, 'chore'), []);
assert.equal(generateCommitCandidates('M\0.env\0', true, 'chore')[0].label, 'chore: update .env');

const first = { rootUri: { fsPath: 'C:\\repo-one' }, inputBox: { value: '' } };
const second = { rootUri: { fsPath: 'C:\\Work\\repo-two\\' }, inputBox: { value: 'draft' } };
assert.equal(findGitRepositoryByRoot([first, second], 'c:/work/repo-two'), second);
assert.equal(findGitRepositoryByRoot([first, second], 'C:/missing'), undefined);

console.log('Smart commit candidate and multi-repository checks passed.');
