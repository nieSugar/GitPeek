import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { findGitRepositoryByRoot, generateCommitCandidates } from '../src/features/smartCommit.ts';

const require = createRequire(import.meta.url);
const { run: runHostProbe } = require('./extension-host.cjs');

const staged = 'M\0src/device/config.ts\0A\0src/device/new.ts\0';
const conventional = generateCommitCandidates(staged, true, 'fix');
assert.equal(conventional.length, 8);
assert.equal(conventional[0].label, 'fix(device): 更新 device');
assert.ok(conventional.every(({ label }) => label.trim().length > 0));
assert.equal(new Set(conventional.map(({ label }) => label)).size, conventional.length);
assert.deepEqual(conventional.map(({ description }) => description.split(' · ')[1]), [
  'fix', 'feat', 'refactor', 'perf', 'docs', 'test', 'style', 'chore',
]);

const renamed = generateCommitCandidates('R100\0old/old-name.ts\0new/new-name.ts\0', true, 'chore');
assert.equal(renamed[0].label, 'chore(new): 重命名 new-name');
assert.ok(!renamed[0].label.includes('old-name'));

const specialPath = generateCommitCandidates('A\0目录 & 名/特殊\t文件.ts\0', true, 'bogus');
assert.equal(specialPath[0].label, 'chore(目录-名): 新增 特殊 文件');
assert.ok(specialPath.every(({ label }) => !/[\r\n\0]/.test(label) && label.trim().length > 0));

const plain = generateCommitCandidates('A\0README.md\0', false, 'chore');
assert.deepEqual(plain.map(({ label }) => label), ['更新 README', '修改 README', '优化 README']);
assert.equal(new Set(plain.map(({ label }) => label)).size, plain.length);
assert.deepEqual(generateCommitCandidates('', true, 'chore'), []);
assert.equal(generateCommitCandidates('M\0.env\0', true, 'chore')[0].label, 'chore: 更新 .env');

const first = { rootUri: { fsPath: 'C:\\repo-one' }, inputBox: { value: '' } };
const second = { rootUri: { fsPath: 'C:\\Work\\repo-two\\' }, inputBox: { value: 'draft' } };
assert.equal(findGitRepositoryByRoot([first, second], 'C:/Work/repo-two'), second);
assert.equal(findGitRepositoryByRoot([first, second], 'c:/work/repo-two'), process.platform === 'win32' ? second : undefined);
assert.equal(findGitRepositoryByRoot([first, second], 'C:/missing'), undefined);

const scmInput = { value: 'keep this draft' };
const repository = { rootUri: { fsPath: 'C:/workspace/project' }, inputBox: scmInput };
const extensions = {
  'gitpeek.gitpeek': {
    isActive: false,
    async activate() { this.isActive = true; },
  },
  'vscode.git': {
    isActive: false,
    async activate() {
      this.isActive = true;
      return { getAPI(version) { assert.equal(version, 1); return { repositories: [repository] }; } };
    },
  },
};
const hostVscode = {
  extensions: { getExtension(id) { return extensions[id]; } },
  commands: { async getCommands(filterInternal) { assert.equal(filterInternal, true); return [...PUBLIC_COMMANDS, '_internal']; } },
  workspace: { workspaceFolders: [{ uri: { fsPath: 'C:/workspace' } }] },
};
const PUBLIC_COMMANDS = [
  'gitpeek.interactiveRebase', 'gitpeek.continueRebase', 'gitpeek.abortRebase',
  'gitpeek.toggleFileBlame', 'gitpeek.previousFileRevision', 'gitpeek.nextFileRevision',
  'gitpeek.fileHistory', 'gitpeek.showCommitGraph', 'gitpeek.stash', 'gitpeek.blameCurrentLine', 'gitpeek.selectionOrigins', 'gitpeek.compareWithBase',
  'gitpeek.showBranchChanges', 'gitpeek.reviewChanges', 'gitpeek.generateCommitMessage', 'gitpeek.refresh', 'gitpeek.selectionHistory',
];
const hostResult = await runHostProbe({ vscode: hostVscode });
assert.equal(hostResult.publicCommands, PUBLIC_COMMANDS.length);
assert.equal(hostResult.repositories[0].root, repository.rootUri.fsPath);
assert.equal(scmInput.value, 'keep this draft', 'the host probe must not change the SCM draft');
await assert.rejects(runHostProbe({
  vscode: { ...hostVscode, commands: { async getCommands() { return []; } } },
}), /commands are missing/);

console.log('Smart commit candidate and multi-repository checks passed.');
