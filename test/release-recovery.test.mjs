import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { recoverLatest } from '../scripts/recover-release-promotion.mjs';

const image = 'ghcr.io/mashiro0619/perpay';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
function fixture(change = {}) {
  const revision = 'a'.repeat(40);
  const tagObject = 'b'.repeat(40);
  const objects = new Map();
  function index(version) {
    return encode({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: ['amd64', 'arm64'].map(architecture => {
      const config = encode({ os: 'linux', architecture, config: { Labels: {
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.revision': version === '0.2.0' && change.wrongRevision ? 'c'.repeat(40) : revision,
      } } });
      objects.set('blobs/' + sha(config), config);
      const manifest = encode({ schemaVersion: 2, config: { digest: sha(config) }, layers: [] });
      objects.set('manifests/' + sha(manifest), manifest);
      return { digest: sha(manifest), platform: { os: 'linux', architecture } };
    }) });
  }
  const oldIndex = index('0.1.0');
  const targetIndex = index('0.2.0');
  const oldDigests = JSON.parse(oldIndex).manifests.map(item => item.digest);
  const oldDigest = sha(oldIndex);
  const targetDigest = sha(targetIndex);
  const steps = [
    'Build the untagged amd64 image', 'Build the untagged arm64 image', 'Select the platform image digests',
    'Scan the amd64 image for high-risk vulnerabilities', 'Scan the arm64 image for high-risk vulnerabilities',
    'Publish or verify the fixed version image', 'Require the fixed version image to be public',
    'Render and validate the latest-channel release Compose', 'Exercise Linux Compose, backup, restore, and persistence',
  ].map(name => ({ name, conclusion: 'success' }));
  steps.push({ name: 'Promote the validated image to latest', conclusion: 'failure' });
  steps.push({ name: 'Publish the GitHub Release', conclusion: 'skipped' });
  if (change.failedScan) steps.find(step => step.name.startsWith('Scan the arm64')).conclusion = 'failure';
  const run = { name: 'Release', path: '.github/workflows/release.yml', event: 'push', head_branch: 'v0.2.0', repository: { full_name: 'Mashiro0619/PerPay' }, status: 'completed', conclusion: 'failure', head_sha: revision };
  const api = new Map([
    ['actions/runs/123', run],
    ['actions/runs/123/jobs?filter=latest&per_page=100', { total_count: 2, jobs: [{ name: 'verify', conclusion: change.failedChecks ? 'failure' : 'success' }, { name: 'publish', conclusion: 'failure', steps }] }],
    ['git/ref/tags/v0.2.0', { ref: 'refs/tags/v0.2.0', object: { type: 'tag', sha: tagObject } }],
    ['git/tags/' + tagObject, { tag: 'v0.2.0', message: change.unsignedTag ? 'unsigned' : '发布 v0.2.0\n-----BEGIN SSH SIGNATURE-----', object: { type: 'commit', sha: change.movedTag ? 'd'.repeat(40) : revision } }],
    ['releases/latest', { draft: false, prerelease: false, tag_name: change.newerRelease ? 'v0.3.0' : 'v0.1.0', body: change.unattested ? 'no digest' : image + ':0.1.0@' + oldDigest }],
  ]);
  const calls = [];
  let latestReads = 0;
  let promoted = false;
  const options = { version: '0.2.0', sourceRunId: '123', targetDigest, expectedLatestDigest: oldDigest, githubToken: 'test-only-github-token', actor: 'test-actor' };
  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });
    const prefix = 'https://api.github.com/repos/Mashiro0619/PerPay/';
    if (url.startsWith(prefix)) {
      const value = api.get(url.slice(prefix.length));
      assert.ok(value, 'Unexpected GitHub API request');
      return Response.json(value);
    }
    if (url.startsWith('https://ghcr.io/token?')) return Response.json({ token: 'test-only-registry-token' });
    const registryPrefix = 'https://ghcr.io/v2/mashiro0619/perpay/';
    assert.ok(url.startsWith(registryPrefix));
    const ref = url.slice(registryPrefix.length);
    if (method === 'PUT') {
      assert.equal(ref, 'manifests/latest');
      assert.deepEqual(init.body, targetIndex);
      promoted = true;
      if (change.uncertainWrite) throw new Error('uncertain network response');
      return new Response(null, { status: 201, headers: { 'docker-content-digest': targetDigest } });
    }
    let bytes;
    if (ref === 'manifests/latest') {
      latestReads++;
      bytes = promoted || (change.changedLatest && latestReads > 1) ? targetIndex : oldIndex;
    } else if (ref === 'manifests/0.1.0') bytes = oldIndex;
    else if (ref === 'manifests/0.2.0') bytes = targetIndex;
    else if (oldDigests.some(digest => ref === 'manifests/' + digest) && !change.intactLatest) {
      return new Response(null, { status: change.registryUnavailable ? 503 : 404 });
    } else bytes = objects.get(ref);
    assert.ok(bytes, 'Unexpected registry request: ' + ref);
    return new Response(bytes, { headers: { 'docker-content-digest': sha(bytes) } });
  }
  return { options, calls, fetchImpl, revision, targetDigest };
}

test('recovery promotes only the exact scanned image and leaves fixed version tags untouched', async () => {
  const state = fixture();
  assert.deepEqual(await recoverLatest(state.options, state.fetchImpl), { version: '0.2.0', revision: state.revision, previous: '0.1.0', digest: state.targetDigest });
  const writes = state.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, 'https://ghcr.io/v2/mashiro0619/perpay/manifests/latest');
});

for (const [name, change] of [
  ['failed security scanning', { failedScan: true }],
  ['failed release tests', { failedChecks: true }],
  ['an unsigned release tag', { unsignedTag: true }],
  ['a moved release tag', { movedTag: true }],
  ['a newer published release', { newerRelease: true }],
  ['an unattested previous digest', { unattested: true }],
  ['an intact latest image', { intactLatest: true }],
  ['a registry outage instead of authoritative absence', { registryUnavailable: true }],
  ['a target image with the wrong source revision', { wrongRevision: true }],
  ['a latest digest changed before promotion', { changedLatest: true }],
]) {
  test('recovery refuses ' + name + ' before writing', async () => {
    const state = fixture(change);
    await assert.rejects(recoverLatest(state.options, state.fetchImpl));
    assert.equal(state.calls.filter(call => call.method !== 'GET').length, 0);
  });
}

test('recovery refuses malformed inputs and mismatching operator-confirmed digests', async () => {
  for (const overrides of [
    { version: '0.2.0; echo unsafe' }, { sourceRunId: '../123' },
    { targetDigest: 'sha256:' + 'e'.repeat(64) }, { expectedLatestDigest: 'sha256:' + 'f'.repeat(64) },
  ]) {
    const state = fixture();
    await assert.rejects(recoverLatest({ ...state.options, ...overrides }, state.fetchImpl));
    assert.equal(state.calls.filter(call => call.method !== 'GET').length, 0);
  }
});

test('recovery never repeats a promotion after an uncertain network response', async () => {
  const state = fixture({ uncertainWrite: true });
  await assert.rejects(recoverLatest(state.options, state.fetchImpl), /uncertain network response/);
  assert.equal(state.calls.filter(call => call.method !== 'GET').length, 1);
});

test('release recovery is manual, serialized with releases, and uses only the ephemeral job token', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release-recovery.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', packages: 'write' });
  assert.deepEqual(workflow.concurrency, { group: 'release', 'cancel-in-progress': false });
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) assert.equal(input.required, true);
  const job = workflow.jobs.recover;
  assert.equal(job['timeout-minutes'], 10);
  const step = job.steps.find(step => step.run);
  assert.equal(step.run, 'node scripts/recover-release-promotion.mjs');
  assert.match(step.env.GITHUB_TOKEN, /secrets\.GITHUB_TOKEN/);
  assert.equal(job.steps[0].with['persist-credentials'], false);
});
