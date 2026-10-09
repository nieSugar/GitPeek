// Read-only baseline: npm run benchmark -- [repository] [file] [base] [rounds]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const esbuild = require('esbuild');

async function main() {
  const [directory = '.', file = 'README.md', base = 'HEAD~1', repetitions = '10'] = process.argv.slice(2);
  const rounds = Number(repetitions);
  assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 100, 'rounds must be an integer from 3 to 100');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-benchmark-'));
  try {
    await esbuild.build({ entryPoints: ['git/GitService', 'features/commitGraphData', 'features/gitContent'].map(name => path.join(__dirname, '../src', `${name}.ts`)),
      bundle: true, platform: 'node', format: 'cjs', outdir: temp, outExtension: { '.js': '.cjs' }, logLevel: 'silent' });
    const { GitService } = require(path.join(temp, 'git/GitService.cjs'));
    const { loadGraph } = require(path.join(temp, 'features/commitGraphData.cjs'));
    const { loadCommitDetail, loadCommitDiffContents } = require(path.join(temp, 'features/gitContent.cjs'));
    const git = new GitService();
    const root = (await git.run(path.resolve(directory), ['rev-parse', '--show-toplevel'])).trim();
    const repo = { id: root, root };
    const relative = path.relative(root, path.resolve(root, file));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'file must be inside the repository');
    const filePath = relative.replaceAll(path.sep, '/');
    const head = (await git.run(repo, ['rev-parse', '--verify', 'HEAD'])).trim();
    const baseHash = (await git.run(repo, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
    const latest = (await git.history(repo, filePath, 1))[0];
    assert.ok(latest, 'file must have committed history');
    const detail = await loadCommitDetail(git, repo, latest.hash);
    const environment = {
      repository: root, head, commits: Number((await git.run(repo, ['rev-list', '--count', 'HEAD'])).trim()),
      dirty: Boolean(await git.run(repo, ['status', '--porcelain'])), file: filePath, base: baseHash,
      git: (await git.run(repo, ['--version'])).trim(), node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    };
    let calls = 0, bytes = 0;
    const run = git.run.bind(git);
    git.run = async (...args) => { calls++; const output = await run(...args); bytes += Buffer.byteLength(output, 'utf8'); return output; };
    const scenarios = [
      ['file-history-20', () => git.history(repo, filePath, 20)],
      ['line-blame', () => git.blame(repo, filePath, 1)],
      ['graph-100', () => loadGraph(git, repo, 100)],
      ['search-message', () => loadGraph(git, repo, 100, { kind: 'message', text: 'fix', scope: 'all' })],
      ['commit-file-diff', () => loadCommitDiffContents(git, repo, detail, latest.filePath)],
      ['branch-compare', () => git.compare(repo, baseHash, head)],
    ];
    const results = [];
    for (const [name, operation] of scenarios) {
      const first = performance.now(); await operation();
      const firstObservedMs = performance.now() - first;
      const samples = []; calls = 0; bytes = 0;
      for (let i = 0; i < rounds; i++) { const start = performance.now(); await operation(); samples.push(performance.now() - start); }
      samples.sort((a, b) => a - b);
      const ms = value => Number(value.toFixed(2));
      results.push({ name, firstObservedMs: ms(firstObservedMs), minMs: ms(samples[0]),
        p50Ms: ms(samples[Math.ceil(rounds * .5) - 1]), p95Ms: ms(samples[Math.ceil(rounds * .95) - 1]),
        maxMs: ms(samples.at(-1)), gitCallsPerRun: calls / rounds, stdoutBytesPerRun: Math.round(bytes / rounds) });
    }
    assert.equal((await run(repo, ['rev-parse', '--verify', 'HEAD'])).trim(), head, 'HEAD changed during the benchmark; rerun for a consistent baseline');
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), environment, rounds,
      scope: 'GitPeek data operations only; first observed is not cold-cache latency. Excludes editor rendering, GitLens comparison and process-tree resource usage.', results }, null, 2));
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
