// npm run benchmark:large -- [main-branch commits] [rounds] [Code.exe]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const esbuild = require('esbuild');

async function main() {
  const [commits = '20000', repetitions = '3', executable] = process.argv.slice(2);
  const count = Number(commits), rounds = Number(repetitions);
  assert.ok(Number.isInteger(count) && count >= 10000 && count <= 100000, 'commits must be 10000..100000');
  assert.ok(Number.isInteger(rounds) && rounds >= 3 && rounds <= 20, 'rounds must be 3..20');
  const code = executable || (process.platform === 'win32'
    ? path.resolve(path.dirname(execFileSync('where.exe', ['code'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]), '..', 'Code.exe')
    : 'code');
  if (process.platform === 'win32') assert.ok(fs.existsSync(code), `Code.exe not found: ${code}`);
  const directory = path.resolve(__dirname, '../.vscode-test/large-benchmark', String(Date.now()));
  const repo = path.join(directory, 'repo'), extension = path.join(directory, 'extension');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(extension);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).trim();
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  const stream = [];
  let mark = 0;
  const add = (branch, index, from) => {
    const text = Array.from({ length: 20 }, (_, line) => line === 10 ? `revision ${index} ${index % 2 ? 'needle' : 'absent'}\n` : `stable context ${line}\n`).join('');
    const blob = ++mark;
    stream.push(`blob\nmark :${blob}\ndata ${Buffer.byteLength(text)}\n${text}\n`);
    const commit = ++mark;
    const message = `fix: revision ${index}`;
    stream.push(`commit refs/heads/${branch}\nmark :${commit}\ncommitter GitPeek Benchmark <benchmark@example.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${from ? `from :${from}\n` : ''}M 100644 :${blob} history.txt\n\n`);
    return commit;
  };
  const marks = [];
  for (let index = 0; index < count; index++) marks.push(add('main', index));
  for (let index = 0; index < 64; index++) add(`branch-${String(index).padStart(3, '0')}`, count + index,
    marks[Math.floor(count * (index + 1) / 65)]);
  const imported = execFileSync('git', ['-C', repo, 'fast-import', '--quiet'], {
    input: stream.join(''), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(imported, '');
  git('reset', '--hard', 'main');
  assert.equal(Number(git('rev-list', '--count', 'main')), count);
  assert.equal(Number(git('for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n').length), 65);
  assert.equal(git('status', '--porcelain'), '');
  fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ repo, rounds, count, head: git('rev-parse', 'HEAD'), totalCommits: count + 64 }), 'utf8');
  const source = names => names.map(name => `...require(${JSON.stringify(path.resolve(__dirname, '../src', name + '.ts'))})`).join(',');
  await esbuild.build({ stdin: { contents: `exports.activate=()=>({${source(['git/GitService', 'features/commitGraphData', 'features/commitGraph', 'features/gitContent', 'features/branchCompare'])}});`, resolveDir: __dirname },
    bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'extension.cjs'), logLevel: 'silent' });
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'gitpeek-benchmark', publisher: 'gitpeek',
    version: '0.0.1', engines: { vscode: '^1.96.0' }, activationEvents: ['*'], main: './extension.cjs' }), 'utf8');
  console.log(`Measuring ${count + 64} commits, 65 branches and ${count} file revisions in an isolated VS Code profile.`);
  const args = ['--user-data-dir', path.join(directory, 'profile'), '--extensions-dir', path.join(directory, 'extensions'),
    '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + path.join(__dirname, 'benchmark-large-host.cjs'),
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', repo];
  const env = { ...process.env, GITPEEK_BENCH_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(code, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(directory, 'host.log'), { encoding: 'utf8' });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const timer = setTimeout(() => { child.kill(); }, 240000);
  try {
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(exit, 0, `VS Code benchmark exited ${exit}; see ${path.join(directory, 'host.log')}`);
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(result.status, 'PASS', JSON.stringify(result));
    console.log(JSON.stringify({ ...result, artifacts: directory }, null, 2));
  } finally { clearTimeout(timer); log.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
