const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, sep } = require('node:path');
const esbuild = require('esbuild');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'gitpeek-graph-'));
  try {
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    const graphFile = join(root, 'graph.cjs');
    const gitFile = join(root, 'git.cjs');
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'features', 'commitGraphData.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: graphFile });
    await esbuild.build({ entryPoints: [join(__dirname, '..', 'src', 'git', 'GitService.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: gitFile });
    const graph = require(graphFile);
    const service = new (require(gitFile).GitService)();
    const repo = { root: repoPath, id: repoPath };

    git(repoPath, 'init', '-b', 'main');
    git(repoPath, 'config', 'user.name', 'GitPeek Graph Test');
    git(repoPath, 'config', 'user.email', 'graph@example.invalid');
    writeFileSync(join(repoPath, 'common.txt'), 'base\n', 'utf8');
    git(repoPath, 'add', '--', 'common.txt');
    git(repoPath, 'commit', '-m', 'base');
    git(repoPath, 'switch', '-c', 'feature');
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    git(repoPath, 'add', '--', 'feature.txt');
    git(repoPath, 'commit', '-m', 'feature change');
    git(repoPath, 'switch', 'main');
    writeFileSync(join(repoPath, 'main.txt'), 'main\n', 'utf8');
    git(repoPath, 'add', '--', 'main.txt');
    git(repoPath, 'commit', '-m', 'main change');
    git(repoPath, 'merge', '--no-ff', '-m', 'merge feature', 'feature');

    const loaded = await graph.loadGraph(service, repo, 100);
    assert.equal(loaded.branch, 'main');
    assert.deepEqual(loaded.branches.sort(), ['feature', 'main']);
    assert.equal(loaded.rows.filter(row => row.hash).length, 4);
    assert.equal(loaded.rows.find(row => row.subject === 'merge feature').parents.length, 2);
    assert.ok(loaded.rows.some(row => /[|\\/]/.test(row.graph)), 'Git graph retains merge lanes');
    assert.equal((await graph.loadGraph(service, repo, 2)).hasMore, true);

    assert.deepEqual(graph.parseGitHubRemote('https://github.com/owner/project.git'), { owner: 'owner', repo: 'project' });
    assert.deepEqual(graph.parseGitHubRemote('git@github.com:owner/project.git'), { owner: 'owner', repo: 'project' });
    assert.equal(graph.parseGitHubRemote('https://example.com/owner/project'), undefined);
    assert.deepEqual(graph.avatarByEmail([{ commit: { author: { email: 'A@EXAMPLE.COM' } }, author: { avatar_url: 'https://avatars.githubusercontent.com/u/1' } }]), { 'a@example.com': 'https://avatars.githubusercontent.com/u/1' });

    await graph.createAndSwitchBranch(service, repo, 'test/new');
    assert.equal(git(repoPath, 'branch', '--show-current'), 'test/new');
    await assert.rejects(graph.createAndSwitchBranch(service, repo, 'bad name'));
    await graph.switchLocalBranch(service, repo, 'main');
    await assert.rejects(graph.switchLocalBranch(service, repo, 'missing'));
    git(repoPath, 'switch', '-c', 'another');
    writeFileSync(join(repoPath, 'another.txt'), 'another\n', 'utf8');
    git(repoPath, 'add', '--', 'another.txt');
    git(repoPath, 'commit', '-m', 'another branch');
    git(repoPath, 'switch', 'main');
    await graph.mergeLocalBranch(service, repo, 'another');
    assert.equal(git(repoPath, 'show', 'HEAD:another.txt'), 'another');
    writeFileSync(join(repoPath, 'dirty.txt'), 'dirty\n', 'utf8');
    await assert.rejects(graph.mergeLocalBranch(service, repo, 'feature'), /工作区更改/);
    console.log('Commit graph check passed (merge lanes, avatars, branch switch/create/merge).');
  } finally {
    if (!root.startsWith(tmpdir() + sep)) throw new Error('Temporary repository escaped temp directory');
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
