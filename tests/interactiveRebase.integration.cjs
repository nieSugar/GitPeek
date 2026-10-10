const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative, isAbsolute } = require('node:path');
const esbuild = require('esbuild');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

function commitFile(root, name, content, message) {
  writeFileSync(join(root, name), content, 'utf8');
  git(root, 'add', '--', name);
  git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function initRepo(root) {
  mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GitPeek Rebase Test');
  git(root, 'config', 'user.email', 'rebase@example.invalid');
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.hooksPath', join(root, 'no-hooks'));
  return commitFile(root, 'base.txt', 'base\n', 'base');
}

const repository = root => ({ root, id: root });
const pickSteps = plan => plan.commits.map(commit => ({ hash: commit.hash, action: 'pick' }));
const subjects = root => git(root, 'log', '--reverse', '--format=%s').split('\n');
const head = root => git(root, 'rev-parse', 'HEAD');
const tree = root => git(root, 'rev-parse', 'HEAD^{tree}');

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'gitpeek-rebase-'));
  try {
    const bundle = join(tempRoot, 'rebase.cjs');
    const gitBundle = join(tempRoot, 'git-service.cjs');
    await Promise.all([
      esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'interactiveRebase.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle }),
      esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitBundle }),
    ]);
    const api = require(bundle);
    const { GitService } = require(gitBundle);
    const service = new GitService();
    const load = (root, hash) => api.loadRebasePlan(service, repository(root), hash);
    const read = root => api.readRebaseState(service, repository(root));
    const resume = root => api.continueRebase(service, repository(root));
    const abort = root => api.abortRebase(service, repository(root));
    const run = (plan, steps) => api.startRebase(service, plan, steps);

    function fixture(name) {
      const root = join(tempRoot, `仓库 ${name}`);
      const base = initRepo(root);
      const first = commitFile(root, 'first.txt', 'first\n', 'first');
      const second = commitFile(root, 'second.txt', 'second\n', 'second');
      const third = commitFile(root, 'third.txt', 'third\n', 'third');
      return { root, base, first, second, third };
    }

    async function check(name, fn) {
      await fn();
      console.log(`Interactive rebase: ${name} passed.`);
    }

    await check('reorder, published metadata, and recovery ref', async () => {
      const { root, base, first, second, third } = fixture('reorder');
      const plan = await load(root, first);
      assert.equal(plan.head, third);
      assert.equal(plan.base, base);
      assert.equal(plan.branch, 'main');
      assert.equal(plan.published, false);
      assert.deepEqual(plan.commits.map(commit => commit.hash), [first, second, third]);
      assert.equal(plan.commits[0].subject, 'first');
      assert.equal(plan.commits[0].message.trim(), 'first');
      const originalTree = tree(root);
      const result = await run(plan, [
        { hash: third, action: 'pick' },
        { hash: first, action: 'pick' },
        { hash: second, action: 'pick' },
      ]);
      assert.equal(result.status, 'completed');
      assert.deepEqual(subjects(root), ['base', 'third', 'first', 'second']);
      assert.equal(tree(root), originalTree);
      assert.equal(await read(root), undefined);
      assert.ok(result.backupRef);
      assert.equal(git(root, 'rev-parse', result.backupRef), third);
      git(root, 'branch', 'recovered', result.backupRef);
      assert.equal(git(root, 'rev-parse', 'recovered'), third);
      git(root, 'update-ref', 'refs/remotes/origin/main', head(root));
      const published = await load(root, git(root, 'rev-parse', 'HEAD~2'));
      assert.equal(published.published, true);
      await assert.rejects(async () => resume(root));
      await assert.rejects(async () => abort(root));
    });

    await check('Unicode and multiline reword', async () => {
      const { root, first } = fixture('reword');
      const plan = await load(root, first);
      const originalTree = tree(root);
      const message = 'feat: 整理提交 🚀\n\n保留第二段。\n# 这是正文，不是 Git 注释。\n包含 "引号"、$HOME、`命令` 与 %PATH%。';
      const steps = pickSteps(plan);
      steps[1] = { ...steps[1], action: 'reword', message };
      assert.equal((await run(plan, steps)).status, 'completed');
      assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD~1'), message);
      assert.equal(tree(root), originalTree);
      assert.equal(await read(root), undefined);
    });

    await check('squash custom message, fixup, and drop', async () => {
      const { root, first, second, third } = fixture('squash');
      const fourth = commitFile(root, 'fourth.txt', 'fourth\n', 'fourth');
      const plan = await load(root, first);
      const message = 'feat: 合并后的提交\n\n# 正文标题也要保留\n说明来自自定义编辑器。';
      const result = await run(plan, [
        { hash: first, action: 'pick' },
        { hash: second, action: 'squash', message },
        { hash: third, action: 'fixup' },
        { hash: fourth, action: 'drop' },
      ]);
      assert.equal(result.status, 'completed');
      assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '2');
      assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD'), message);
      assert.deepEqual(git(root, 'ls-tree', '--name-only', 'HEAD').split('\n'), ['base.txt', 'first.txt', 'second.txt', 'third.txt']);

      const defaults = fixture('default squash');
      const defaultPlan = await load(defaults.root, defaults.first);
      const defaultSteps = pickSteps(defaultPlan);
      defaultSteps[1].action = 'squash';
      assert.equal((await run(defaultPlan, defaultSteps)).status, 'completed');
      assert.equal(git(defaults.root, 'show', '-s', '--format=%B', 'HEAD~1'), 'first\n\nsecond');
    });

    await check('later squash appends its message after an earlier custom squash', async () => {
      const { root, first, second, third } = fixture('squash chain');
      const plan = await load(root, first);
      const originalTree = tree(root);
      assert.equal((await run(plan, [
        { hash: first, action: 'pick' },
        { hash: second, action: 'squash', message: 'AB\n\n# 自定义正文' },
        { hash: third, action: 'squash' },
      ])).status, 'completed');
      assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD'), 'AB\n\n# 自定义正文\n\nthird');
      assert.equal(tree(root), originalTree);
      assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '2');
    });

    await check('default squash preserves hash-prefixed body under comment and verbose settings', async () => {
      for (const commentChar of ['#', 'auto']) {
        const root = join(tempRoot, `仓库 squash comments ${commentChar === '#' ? 'hash' : commentChar}`);
        initRepo(root);
        const firstMessage = 'first\n\n# first body';
        const secondMessage = 'second\n\n# second body';
        const first = commitFile(root, 'first.txt', 'first\n', firstMessage);
        const second = commitFile(root, 'second.txt', 'second\n', secondMessage);
        git(root, 'config', 'core.commentChar', commentChar);
        git(root, 'config', 'commit.verbose', 'true');
        const plan = await load(root, first);
        assert.deepEqual(plan.commits.map(commit => commit.message.trim()), [firstMessage, secondMessage]);
        assert.equal((await run(plan, [{ hash: first, action: 'pick' }, { hash: second, action: 'squash' }])).status, 'completed');
        assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD'), `${firstMessage}\n\n${secondMessage}`);
      }
    });

    await check('legacy commit encoding loads as UTF-8 and accepts Unicode replacement messages', async () => {
      const root = join(tempRoot, '仓库 legacy encoding');
      initRepo(root);
      git(root, 'config', 'i18n.commitEncoding', 'ISO-8859-1');
      git(root, 'config', 'i18n.logOutputEncoding', 'ISO-8859-1');
      const legacyMessage = 'café source\n\nhéritage';
      const messageFile = join(git(root, 'rev-parse', '--absolute-git-dir'), 'legacy-message');
      writeFileSync(messageFile, `${legacyMessage}\n`, 'latin1');
      writeFileSync(join(root, 'legacy.txt'), 'legacy\n', 'utf8');
      git(root, 'add', '--', 'legacy.txt');
      git(root, 'commit', '-F', messageFile);
      const original = head(root);
      const plan = await load(root, original);
      assert.equal(plan.commits[0].subject, 'café source');
      assert.equal(plan.commits[0].message.trim(), legacyMessage);
      const message = 'feat: 中文提交 🚀\n\n# 保留 UTF-8 正文';
      assert.equal((await run(plan, [{ hash: original, action: 'reword', message }])).status, 'completed');
      assert.equal(git(root, 'show', '--encoding=UTF-8', '-s', '--format=%B', 'HEAD'), message);
      assert.equal((await load(root, head(root))).commits[0].message.trim(), message);
      assert.equal(git(root, 'config', '--get', 'i18n.commitEncoding'), 'ISO-8859-1');
      assert.equal(git(root, 'config', '--get', 'i18n.logOutputEncoding'), 'ISO-8859-1');
    });

    await check('edit pause survives reload, amend, and subsequent squash', async () => {
      const { root, first } = fixture('edit');
      const plan = await load(root, first);
      const steps = pickSteps(plan);
      steps[0].action = 'edit';
      steps[1].action = 'squash';
      const paused = await run(plan, steps);
      assert.equal(paused.status, 'paused');
      assert.equal((await read(root)).status, 'paused');
      assert.ok(paused.backupRef);
      await assert.rejects(async () => load(root, head(root)));
      writeFileSync(join(root, 'first.txt'), 'amended\n', 'utf8');
      git(root, 'add', '--', 'first.txt');
      const editedMessage = 'edited\n\n# 最新 amend 正文';
      git(root, 'commit', '--amend', '-m', editedMessage);
      const resumed = await api.continueRebase(new GitService(), repository(root));
      assert.equal(resumed.status, 'completed');
      assert.equal(git(root, 'show', 'HEAD:first.txt'), 'amended');
      assert.deepEqual(subjects(root), ['base', 'edited', 'third']);
      assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD~1'), `${editedMessage}\n\nsecond`);
      assert.equal(await read(root), undefined);
      assert.equal(git(root, 'rev-parse', paused.backupRef), plan.head);
    });

    async function conflictFixture(name) {
      const root = join(tempRoot, `仓库 ${name}`);
      initRepo(root);
      const first = commitFile(root, 'shared.txt', 'first\n', 'first shared');
      const second = commitFile(root, 'shared.txt', 'second\n', 'second shared');
      const plan = await load(root, first);
      const result = await run(plan, [{ hash: second, action: 'pick' }, { hash: first, action: 'pick' }]);
      assert.equal(result.status, 'paused');
      assert.equal((await read(root)).status, 'paused');
      assert.ok(git(root, 'ls-files', '--unmerged'));
      return { root, plan, result };
    }

    await check('conflict remains recoverable and continues after resolution', async () => {
      const { root, plan } = await conflictFixture('conflict continue');
      assert.equal((await resume(root)).status, 'paused');
      assert.equal((await read(root)).status, 'paused');
      writeFileSync(join(root, 'shared.txt'), 'resolved second\n', 'utf8');
      git(root, 'add', '--', 'shared.txt');
      const next = await resume(root);
      assert.equal(next.status, 'paused');
      assert.ok(git(root, 'ls-files', '--unmerged'));
      writeFileSync(join(root, 'shared.txt'), 'resolved final\n', 'utf8');
      git(root, 'add', '--', 'shared.txt');
      assert.equal((await resume(root)).status, 'completed');
      assert.equal(git(root, 'show', 'HEAD:shared.txt'), 'resolved final');
      assert.deepEqual(subjects(root), ['base', 'second shared', 'first shared']);
      assert.equal(await read(root), undefined);
      assert.notEqual(head(root), plan.head);
    });

    await check('abort restores original branch, HEAD, and contents', async () => {
      const { root, plan, result } = await conflictFixture('conflict abort');
      assert.equal((await abort(root)).status, 'aborted');
      assert.equal(head(root), plan.head);
      assert.equal(git(root, 'branch', '--show-current'), 'main');
      assert.equal(git(root, 'show', 'HEAD:shared.txt'), 'second');
      assert.equal(git(root, 'status', '--porcelain'), '');
      assert.equal(await read(root), undefined);
      assert.equal(git(root, 'rev-parse', result.backupRef), plan.head);
    });

    await check('root commit can be reworded', async () => {
      const { root, base } = fixture('root');
      const plan = await load(root, base);
      assert.ok(!plan.base);
      const originalTree = tree(root);
      const steps = pickSteps(plan);
      steps[0] = { ...steps[0], action: 'reword', message: '根提交\n\n从第一笔历史开始整理。' };
      assert.equal((await run(plan, steps)).status, 'completed');
      assert.equal(git(root, 'show', '-s', '--format=%B', 'HEAD~3'), steps[0].message);
      assert.equal(tree(root), originalTree);
      assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '4');
    });

    await check('dirty worktree, stale HEAD, published commits, and changed branch guards', async () => {
      const { root, first } = fixture('guards');
      const plan = await load(root, first);
      const steps = pickSteps(plan);
      git(root, 'update-ref', 'refs/remotes/origin/main', plan.head);
      await assert.rejects(async () => run(plan, steps), /发布状态已改变/);
      assert.equal(head(root), plan.head);
      assert.equal(await read(root), undefined);
      git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
      const publishingService = {
        async run(repo, args, options) {
          const result = await service.run(repo, args, options);
          if (args[0] === 'update-ref' && args[1].startsWith('refs/gitpeek/rebase/')) {
            git(root, 'update-ref', 'refs/remotes/origin/main', plan.head);
          }
          return result;
        },
      };
      await assert.rejects(async () => api.startRebase(publishingService, plan, steps), /发布状态已改变/);
      assert.equal(head(root), plan.head);
      assert.equal(await read(root), undefined);
      git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
      writeFileSync(join(root, 'untracked.txt'), 'keep me\n', 'utf8');
      await assert.rejects(async () => run(plan, steps));
      assert.equal(head(root), plan.head);
      assert.equal(readFileSync(join(root, 'untracked.txt'), 'utf8'), 'keep me\n');
      rmSync(join(root, 'untracked.txt'));
      writeFileSync(join(root, 'first.txt'), 'unstaged\n', 'utf8');
      await assert.rejects(async () => run(plan, steps));
      git(root, 'add', '--', 'first.txt');
      await assert.rejects(async () => run(plan, steps));
      git(root, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'first.txt');
      git(root, 'switch', '-c', 'different');
      await assert.rejects(async () => run(plan, steps));
      assert.equal(head(root), plan.head);
      git(root, 'switch', 'main');
      const newer = commitFile(root, 'newer.txt', 'newer\n', 'newer');
      await assert.rejects(async () => run(plan, steps));
      assert.equal(head(root), newer);
      assert.equal(await read(root), undefined);
      git(root, 'switch', '--detach', 'HEAD');
      await assert.rejects(async () => load(root, first));
    });

    await check('untrusted steps are rejected before changing Git', async () => {
      const { root, first } = fixture('invalid steps');
      const plan = await load(root, first);
      const valid = pickSteps(plan);
      const invalid = [
        null,
        {},
        [],
        valid.map(step => ({ ...step, action: 'drop' })),
        valid.slice(1),
        [valid[0], valid[0], valid[2]],
        [{ ...valid[0], hash: 'a'.repeat(40) }, ...valid.slice(1)],
        [{ ...valid[0], hash: valid[0].hash.slice(0, 8) }, ...valid.slice(1)],
        [{ ...valid[0], action: 'exec', message: 'echo must-not-run' }, ...valid.slice(1)],
        [{ ...valid[0], action: 'squash', message: 'no predecessor' }, ...valid.slice(1)],
        [{ ...valid[0], action: 'fixup' }, ...valid.slice(1)],
        [{ ...valid[0], action: 'drop' }, { ...valid[1], action: 'squash', message: 'no predecessor' }, valid[2]],
        [{ ...valid[0], action: 'reword', message: '' }, ...valid.slice(1)],
        [{ ...valid[0], action: 'reword', message: 'bad\0message' }, ...valid.slice(1)],
      ];
      for (const steps of invalid) {
        await assert.rejects(async () => api.validateRebaseSteps(plan, steps));
        await assert.rejects(async () => run(plan, steps));
        assert.equal(head(root), plan.head);
        assert.equal(await read(root), undefined);
      }
      assert.deepEqual(api.validateRebaseSteps(plan, valid).map(step => [step.hash, step.action]), valid.map(step => [step.hash, step.action]));
      await assert.rejects(async () => load(root, '--all'));
      await assert.rejects(async () => load(root, first.slice(0, 8)));
    });

    await check('merge history and nonancestor guards', async () => {
      const { root, first } = fixture('merge');
      git(root, 'switch', '-c', 'side');
      const side = commitFile(root, 'side.txt', 'side\n', 'side');
      git(root, 'switch', 'main');
      await assert.rejects(async () => load(root, side));
      commitFile(root, 'main.txt', 'main\n', 'main');
      git(root, 'merge', '--no-ff', '-m', 'merge commit', 'side');
      const before = head(root);
      await assert.rejects(async () => load(root, first));
      await assert.rejects(async () => load(root, before));
      assert.equal(head(root), before);
      assert.equal(await read(root), undefined);
    });

    await check('linked worktrees keep independent rebase state', async () => {
      const { root, first } = fixture('worktree primary');
      const linked = join(tempRoot, '仓库 linked worktree');
      git(root, 'worktree', 'add', '-b', 'linked', linked, 'HEAD');
      const mainPlan = await load(root, first);
      const linkedPlan = await load(linked, first);
      const mainSteps = pickSteps(mainPlan);
      mainSteps[0].action = 'edit';
      assert.equal((await run(mainPlan, mainSteps)).status, 'paused');
      assert.equal(await read(linked), undefined);
      const linkedSteps = pickSteps(linkedPlan);
      linkedSteps[1] = { ...linkedSteps[1], action: 'reword', message: 'linked only' };
      assert.equal((await run(linkedPlan, linkedSteps)).status, 'completed');
      assert.equal((await read(root)).status, 'paused');
      assert.equal(await read(linked), undefined);
      assert.equal(git(linked, 'show', '-s', '--format=%s', 'HEAD~1'), 'linked only');
      assert.equal((await abort(root)).status, 'aborted');
      assert.equal(head(root), mainPlan.head);
      assert.equal(git(linked, 'show', '-s', '--format=%s', 'HEAD~1'), 'linked only');
    });

    await check('external rebase is detected without taking ownership of a stale plan', async () => {
      const { root, first, second } = fixture('external rebase');
      const before = head(root);
      const plan = await load(root, second);
      const steps = pickSteps(plan);
      steps[0].action = 'edit';
      assert.equal((await run(plan, steps)).status, 'paused');
      const gitDirectory = git(root, 'rev-parse', '--absolute-git-dir');
      const storedPath = join(gitDirectory, 'gitpeek-rebase', 'plan.json');
      const stored = readFileSync(storedPath, 'utf8');
      git(root, 'rebase', '--abort');
      assert.equal(head(root), before);
      assert.equal(await read(root), undefined);
      assert.equal(readFileSync(storedPath, 'utf8'), stored);
      const editor = join(tempRoot, 'external-sequence-editor.cjs');
      writeFileSync(editor, "const fs = require('node:fs'); const file = process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^pick /m, 'edit '), 'utf8');\n", 'utf8');
      const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
      git(root, '-c', `sequence.editor=${quote(process.execPath)} ${quote(editor)}`, 'rebase', '--interactive', 'HEAD~2');
      assert.equal(readFileSync(join(gitDirectory, 'rebase-merge', 'orig-head'), 'utf8').trim(), plan.head);
      assert.equal(readFileSync(join(gitDirectory, 'rebase-merge', 'head-name'), 'utf8').trim(), `refs/heads/${plan.branch}`);
      const external = await read(root);
      assert.equal(external.status, 'paused');
      assert.equal(external.backupRef, undefined);
      const pausedHead = head(root);
      await assert.rejects(async () => load(root, first));
      await assert.rejects(async () => resume(root));
      await assert.rejects(async () => abort(root));
      assert.equal(head(root), pausedHead);
      assert.equal((await read(root)).status, 'paused');
      assert.equal(readFileSync(storedPath, 'utf8'), stored);
      git(root, 'rebase', '--abort');
      assert.equal(head(root), before);
      assert.equal(await read(root), undefined);
    });

    await check('recovery compares immutable trees and only creates a branch, preserving dirty files and index', async () => {
      const { root, first } = fixture('recovery branch');
      const plan = await load(root, first);
      const steps = pickSteps(plan); steps[1].action = 'drop';
      const result = await run(plan, steps);
      const backups = await api.listRebaseBackups(service, repository(root));
      const backup = backups.find(entry => entry.ref === result.backupRef);
      assert.equal(backup.head, plan.head);
      const comparison = await api.compareRebaseBackup(service, repository(root), backup);
      assert.deepEqual(comparison.files.map(file => [file.status, file.path]), [['A', 'second.txt']]);
      writeFileSync(join(root, 'first.txt'), 'staged change\n', 'utf8');
      git(root, 'add', '--', 'first.txt');
      writeFileSync(join(root, 'first.txt'), 'unstaged change\n', 'utf8');
      writeFileSync(join(root, 'untracked.txt'), 'keep me\n', 'utf8');
      const branch = git(root, 'branch', '--show-current'), beforeHead = head(root);
      const beforeStatus = git(root, 'status', '--porcelain'), beforeIndex = git(root, 'write-tree');
      await api.createRecoveryBranch(service, comparison, 'recovery/原历史');
      assert.equal(git(root, 'rev-parse', 'recovery/原历史'), plan.head);
      assert.equal(git(root, 'branch', '--show-current'), branch);
      assert.equal(head(root), beforeHead); assert.equal(git(root, 'write-tree'), beforeIndex);
      assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
      assert.equal(readFileSync(join(root, 'first.txt'), 'utf8'), 'unstaged change\n');
      assert.equal(readFileSync(join(root, 'untracked.txt'), 'utf8'), 'keep me\n');
      await assert.rejects(api.createRecoveryBranch(service, comparison, 'recovery/原历史'), /already exists|已经存在/);
      await assert.rejects(api.createRecoveryBranch(service, comparison, '--force'));
      git(root, 'update-ref', result.backupRef, comparison.head);
      await assert.rejects(api.createRecoveryBranch(service, comparison, 'recovery/stale'), /已变化/);
      assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
    });

    await check('current conflict operations and literal conflict paths are visible without taking ownership', async () => {
      const { root, plan } = await conflictFixture('operation state');
      const rebase = await api.readGitOperation(service, repository(root));
      assert.equal(rebase.kind, 'rebase'); assert.deepEqual(rebase.conflicts, ['shared.txt']);
      assert.ok(rebase.rebase.backupRef);
      await abort(root);
      const base = head(root);
      git(root, 'switch', '-c', 'side');
      commitFile(root, '冲突 [x].txt', 'side\n', 'side conflict');
      const side = head(root);
      git(root, 'switch', 'main');
      commitFile(root, '冲突 [x].txt', 'main\n', 'main conflict');
      try { git(root, 'merge', 'side') } catch {}
      const merge = await api.readGitOperation(service, repository(root));
      assert.equal(merge.kind, 'merge'); assert.deepEqual(merge.conflicts, ['冲突 [x].txt']);
      assert.equal(merge.rebase, undefined);
      const before = head(root);
      await assert.rejects(resume(root)); await assert.rejects(abort(root));
      assert.equal(head(root), before);
      git(root, 'merge', '--abort');
      try { git(root, 'cherry-pick', side) } catch {}
      const cherry = await api.readGitOperation(service, repository(root));
      assert.equal(cherry.kind, 'cherry-pick'); assert.deepEqual(cherry.conflicts, ['冲突 [x].txt']);
      assert.equal(cherry.rebase, undefined);
      git(root, 'cherry-pick', '--abort');
      assert.equal(await api.readGitOperation(service, repository(root)), undefined);
      assert.ok(base && plan.head);
    });

    console.log('Interactive rebase integration checks passed.');
  } finally {
    const child = relative(tmpdir(), tempRoot);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Temporary repository escaped temp directory');
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
