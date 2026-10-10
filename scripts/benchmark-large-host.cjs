const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');

exports.run = async () => {
  const vscode = require('vscode');
  const directory = process.env.GITPEEK_BENCH_DIR;
  assert.ok(directory, 'Run through benchmark-large.cjs');
  const fixture = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
  const repo = { id: fixture.repo, root: fixture.repo }, result = { status: 'FAIL' };
  let panel;
  try {
    const api = await vscode.extensions.getExtension('gitpeek.gitpeek-benchmark').activate();
    const git = new api.GitService();
    const run = git.run.bind(git);
    let calls = 0, bytes = 0;
    git.run = async (...args) => { calls++; const output = await run(...args); bytes += Buffer.byteLength(output); return output; };
    const environment = { vscode: vscode.version, node: process.version, git: (await run(repo, ['--version'])).trim(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
      commits: fixture.totalCommits, branches: 65, fileRevisions: fixture.count, head: fixture.head };
    const waiters = new Map();
    let sequence = 0;
    const waitFor = key => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(key); reject(new Error('Webview response timed out: ' + key)); }, 30000);
      waiters.set(key, value => { clearTimeout(timer); resolve(value); });
    });
    panel = vscode.window.createWebviewPanel('gitpeek.commitGraph', 'GitPeek 大仓库测量', vscode.ViewColumn.One, { enableScripts: true });
    panel.webview.onDidReceiveMessage(message => {
      const key = message.type === 'ready' ? 'ready' : message.type === 'benchmarkPainted' ? message.id : undefined;
      if (key !== undefined) { waiters.get(key)?.(message); waiters.delete(key); }
    });
    const ready = waitFor('ready');
    const instrumentation = `window.addEventListener('message',event=>{const message=event.data;if(message.type==='render'){const received=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>vscode.postMessage({type:'benchmarkPainted',id:message.benchmarkId,paintWaitMs:performance.now()-received,commits:document.querySelectorAll('#rows > .row').length,domNodes:document.getElementsByTagName('*').length,rendererHeapBytes:performance.memory?.usedJSHeapSize??null})))}});`;
    panel.webview.html = api.graphHtml().replace('</script>', instrumentation + '</script>');
    await ready;
    const renderGraph = async (limit, query) => {
      const start = performance.now();
      const data = await api.loadGraph(git, repo, limit, query);
      const dataMs = performance.now() - start;
      const id = ++sequence, response = waitFor(id);
      await panel.webview.postMessage({ type: 'render', data, query: query || { kind: 'message', text: '', scope: 'all' },
        repoId: repo.id, generation: id, benchmarkId: id, cherryInProgress: false });
      const painted = await response;
      assert.equal(painted.commits, data.rows.filter(row => row.hash).length);
      assert.ok(painted.commits <= limit);
      return { dataMs, transportAndPaintMs: performance.now() - start - dataMs, ...painted };
    };
    const latest = (await git.history(repo, 'history.txt', 1))[0];
    const detail = await api.loadCommitDetail(git, repo, latest.hash);
    const scenarios = [
      ['graph-100-e2e', () => renderGraph(100)],
      ['graph-200-e2e', () => renderGraph(200)],
      ['code-search-100-e2e', () => renderGraph(100, { kind: 'code', text: 'needle', scope: 'all' })],
      ['message-search-100-e2e', () => renderGraph(100, { kind: 'message', text: 'revision', scope: 'all' })],
      ['file-history-20-data', async () => { assert.equal((await git.history(repo, 'history.txt', 20)).length, 20); }],
      ['file-history-1000-data', async () => { assert.equal((await git.history(repo, 'history.txt', 1000)).length, 1000); }],
      ['code-hit-files-and-location-data', async () => {
        const files = await api.loadCodeSearchFiles(git, repo, latest.hash, { kind: 'code', text: 'needle', scope: 'all' });
        assert.equal(files.length, 1);
        const hit = await api.loadCodeSearchLocation(git, repo, latest.hash, files[0], 'needle');
        assert.ok(hit.location, hit.reason);
      }],
      ['commit-diff-data', async () => { await api.loadCommitDiffContents(git, repo, detail, 'history.txt'); }],
      ['branch-snapshot-data', async () => { await api.loadBranchCompare(git, repo, 'branch-000'); }],
    ];
    const results = [];
    const ms = value => Number(value.toFixed(2));
    for (const [name, operation] of scenarios) {
      await operation();
      const samples = [], paints = [];
      calls = 0; bytes = 0;
      let peakRssBytes = process.memoryUsage().rss;
      const sampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
      const cpu = process.cpuUsage();
      try {
        for (let index = 0; index < fixture.rounds; index++) {
          const start = performance.now(), value = await operation();
          samples.push(performance.now() - start);
          if (value) paints.push({ dataMs: ms(value.dataMs), transportAndPaintMs: ms(value.transportAndPaintMs),
            twoFrameWaitMs: ms(value.paintWaitMs), domNodes: value.domNodes, rendererHeapBytes: value.rendererHeapBytes });
        }
      } finally { clearInterval(sampler); }
      const used = process.cpuUsage(cpu);
      samples.sort((a, b) => a - b);
      results.push({ name, p50Ms: ms(samples[Math.ceil(samples.length * .5) - 1]), p95Ms: ms(samples[Math.ceil(samples.length * .95) - 1]),
        gitCallsPerRun: calls / fixture.rounds, stdoutBytesPerRun: Math.round(bytes / fixture.rounds),
        extensionHostPeakRssBytes: peakRssBytes, extensionHostCpuMsPerRun: ms((used.user + used.system) / 1000 / fixture.rounds), paints });
      console.log(`[GitPeek benchmark] ${name}: P50 ${results.at(-1).p50Ms} ms`);
    }
    assert.equal((await run(repo, ['rev-parse', 'HEAD'])).trim(), fixture.head);
    assert.equal((await run(repo, ['status', '--porcelain'])).trim(), '');
    Object.assign(result, { status: 'PASS', measuredAt: new Date().toISOString(), environment, rounds: fixture.rounds, results,
      scope: 'Real Windows VS Code Extension Host + current graphHtml Webview; graph scenarios include query, postMessage and two animation frames after DOM draw. File history, Diff and branch scenarios measure data only. Memory/CPU cover Extension Host and Webview JS heap, not the Git process tree, VS Code chrome, avatars or startup. Warm samples, no GitLens comparison.' });
  } catch (error) { result.error = String(error.stack || error); throw error; }
  finally { panel?.dispose(); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), 'utf8'); }
};
