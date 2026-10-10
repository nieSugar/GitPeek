const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { load } = require('js-yaml');

const workflow = load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
const { release, marketplace, open_vsx: openVsx } = workflow.jobs;
const releaseScript = release.steps.find(step => step.name === 'Publish GitHub Release').run;
const bash = process.platform === 'win32'
  ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';

test('store publishers are independent and share the final release artifact', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(release.permissions, { contents: 'write' });
  assert.deepEqual(marketplace.permissions, { contents: 'read' });
  assert.deepEqual(openVsx.permissions, { 'id-token': 'write' });
  assert.equal(release.steps.at(-1).uses, 'actions/upload-artifact@v7.0.2');
  for (const [job, input] of [[marketplace, 'publish_marketplace'], [openVsx, 'publish_openvsx']]) {
    assert.equal(job.needs, 'release', 'one store failure must not block the other store');
    assert.equal(job.if, `github.event_name == 'push' || inputs.${input}`);
    assert.equal(workflow.on.workflow_dispatch.inputs[input].default, false);
    const download = job.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, release.steps.at(-1).with.name);
    assert.equal(job.env.RELEASE_TAG, release.env.RELEASE_TAG);
  }
  const script = openVsx.steps.at(-1).run;
  assert.match(script, /ovsx@1\.2\.0 publish "\$vsix" --trusted-publishing --skip-duplicate/);
  assert.doesNotMatch(script, /OVSX_PAT|--pat|continue-on-error|\|\| true/);
});

const fakeGh = `
gh() {
  printf '%s\\n' "$*" >> calls.txt
  case "$2" in
    view)
      [[ "$SCENARIO" != new ]] || return 1
      if [[ "$*" == *"--json assets"* && "$SCENARIO" != missing ]]; then
        printf '%s\\n' "gitpeek-0.8.0.vsix"
      fi
      ;;
    download)
      [[ "$SCENARIO" != download_failure ]] || return 1
      printf official > gitpeek-0.8.0.vsix
      ;;
    upload|create) ;;
    *) return 1 ;;
  esac
}
`;

for (const [scenario, event] of [['existing', 'workflow_dispatch'], ['missing', 'workflow_dispatch'], ['new', 'workflow_dispatch'], ['new', 'push'], ['download_failure', 'workflow_dispatch']]) {
  test(`release ${scenario} (${event}) preserves published packages and fails on download errors`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitpeek-release-'));
    try {
      fs.writeFileSync(path.join(temp, 'gitpeek-0.8.0.vsix'), 'rebuilt', 'utf8');
      const result = spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', fakeGh + releaseScript], {
        cwd: temp, encoding: 'utf8', env: { ...process.env, SCENARIO: scenario, EVENT_NAME: event, RELEASE_TAG: 'v0.8.0' },
      });
      assert.ifError(result.error);
      const calls = fs.readFileSync(path.join(temp, 'calls.txt'), 'utf8');
      assert.equal(result.status, scenario === 'download_failure' ? 1 : 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(temp, 'gitpeek-0.8.0.vsix'), 'utf8'), scenario === 'existing' ? 'official' : 'rebuilt');
      if (scenario === 'existing' || scenario === 'download_failure') assert.doesNotMatch(calls, /release (upload|create)/);
      if (scenario === 'missing') assert.match(calls, /release upload v0\.8\.0 gitpeek-0\.8\.0\.vsix/);
      if (scenario === 'new') {
        assert.match(calls, /release create v0\.8\.0 gitpeek-0\.8\.0\.vsix --verify-tag/);
        assert.equal(calls.includes('--latest=false'), event === 'workflow_dispatch');
      }
    } finally {
      assert.ok(temp.startsWith(os.tmpdir() + path.sep));
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
