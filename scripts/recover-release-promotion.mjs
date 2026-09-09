// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const REPOSITORY = 'Mashiro0619/PerPay';
const IMAGE = 'ghcr.io/mashiro0619/perpay';
const REGISTRY = 'https://ghcr.io/v2/mashiro0619/perpay';
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACCEPT = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
const REQUIRED_STEPS = [
  'Build the untagged amd64 image',
  'Build the untagged arm64 image',
  'Select the platform image digests',
  'Scan the amd64 image for high-risk vulnerabilities',
  'Scan the arm64 image for high-risk vulnerabilities',
  'Publish or verify the fixed version image',
  'Require the fixed version image to be public',
  'Render and validate the latest-channel release Compose',
  'Exercise Linux Compose, backup, restore, and persistence',
];
const digestOf = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export function validateRecoverySource(run, jobs, version) {
  assert.equal(run.name, 'Release');
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'v' + version);
  assert.equal(run.repository.full_name, REPOSITORY);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'failure');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.equal(jobs.length, 2);
  const verify = jobs.find(job => job.name === 'verify');
  const publish = jobs.find(job => job.name === 'publish');
  assert.equal(verify?.conclusion, 'success');
  assert.equal(publish?.conclusion, 'failure');
  assert.deepEqual(publish.steps.filter(step => step.conclusion === 'failure').map(step => step.name), [
    'Promote the validated image to latest',
  ]);
  for (const name of REQUIRED_STEPS) {
    assert.equal(publish.steps.filter(step => step.name === name && step.conclusion === 'success').length, 1, name + ' did not pass');
  }
  assert.equal(publish.steps.find(step => step.name === 'Publish the GitHub Release')?.conclusion, 'skipped');
  return run.head_sha;
}

export function validatePreviousRelease(release, version, expectedDigest) {
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  const previous = release.tag_name?.replace(/^v/, '');
  assert.equal(release.tag_name, 'v' + previous);
  assert.match(previous, VERSION);
  const left = previous.split('.').map(BigInt);
  const right = version.split('.').map(BigInt);
  const firstDifference = left.findIndex((part, index) => part !== right[index]);
  assert.ok(firstDifference !== -1 && left[firstDifference] < right[firstDifference], 'Recovery cannot downgrade or replace the same release');
  assert.ok(release.body.includes(IMAGE + ':' + previous + '@' + expectedDigest), 'Previous release does not attest the expected latest digest');
  return previous;
}

export function validateIndex(index) {
  assert.deepEqual(index.manifests.map(item => item.platform.os + '/' + item.platform.architecture).sort(), ['linux/amd64', 'linux/arm64']);
  for (const manifest of index.manifests) assert.match(manifest.digest, DIGEST);
  return index.manifests;
}

export async function recoverLatest(options, fetchImpl = fetch) {
  const { version, sourceRunId, targetDigest, expectedLatestDigest, githubToken, actor } = options;
  assert.match(version, VERSION);
  assert.match(sourceRunId, /^[1-9][0-9]*$/);
  assert.match(targetDigest, DIGEST);
  assert.match(expectedLatestDigest, DIGEST);
  assert.notEqual(targetDigest, expectedLatestDigest);
  assert.ok(githubToken && actor, 'GitHub Actions credentials are required');
  async function request(url, init = {}) {
    return fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(45000), ...init });
  }
  async function github(path) {
    const response = await request('https://api.github.com/repos/' + REPOSITORY + '/' + path, {
      headers: { authorization: 'Bearer ' + githubToken, accept: 'application/vnd.github+json', 'user-agent': 'PerPay-release-recovery' },
    });
    assert.equal(response.status, 200, 'GitHub verification request failed: ' + path);
    return response.json();
  }
  const run = await github('actions/runs/' + sourceRunId);
  const jobs = await github('actions/runs/' + sourceRunId + '/jobs?filter=latest&per_page=100');
  assert.equal(jobs.total_count, jobs.jobs.length);
  const revision = validateRecoverySource(run, jobs.jobs, version);
  const tagRef = await github('git/ref/tags/v' + version);
  assert.equal(tagRef.ref, 'refs/tags/v' + version);
  assert.equal(tagRef.object.type, 'tag', 'A signed annotated release tag is required');
  assert.match(tagRef.object.sha, /^[a-f0-9]{40}$/);
  const tag = await github('git/tags/' + tagRef.object.sha);
  assert.equal(tag.tag, 'v' + version);
  assert.ok(tag.message.includes('-----BEGIN SSH SIGNATURE-----'), 'The existing release tag must remain signed');
  assert.equal(tag.object.type, 'commit');
  assert.equal(tag.object.sha, revision);
  const previous = validatePreviousRelease(await github('releases/latest'), version, expectedLatestDigest);
  async function token(write) {
    const response = await request('https://ghcr.io/token?service=ghcr.io&scope=repository:mashiro0619/perpay:pull' + (write ? ',push' : ''), {
      headers: write ? { authorization: 'Basic ' + Buffer.from(actor + ':' + githubToken).toString('base64') } : {},
    });
    assert.equal(response.status, 200, 'Registry authentication failed');
    const data = await response.json();
    assert.ok(typeof data.token === 'string' && data.token.length > 0);
    return data.token;
  }
  const readToken = await token(false);
  async function registry(kind, reference, allowMissing = false) {
    // Only public blobs may follow CDN redirects; privileged requests never redirect.
    const response = await request(REGISTRY + '/' + kind + '/' + reference, { redirect: kind === 'blobs' ? 'follow' : 'error', headers: { authorization: 'Bearer ' + readToken, accept: ACCEPT } });
    if (allowMissing && response.status === 404) return null;
    assert.equal(response.status, 200, 'Registry verification failed: ' + reference);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = digestOf(bytes);
    if (reference.startsWith('sha256:')) assert.equal(digest, reference);
    if (response.headers.has('docker-content-digest')) assert.equal(response.headers.get('docker-content-digest'), digest);
    return { bytes, digest, data: JSON.parse(bytes.toString()) };
  }
  const oldLatest = await registry('manifests', 'latest');
  assert.equal(oldLatest.digest, expectedLatestDigest, 'The latest channel changed; stop and inspect it again');
  assert.equal((await registry('manifests', previous)).digest, expectedLatestDigest);
  const oldPlatforms = validateIndex(oldLatest.data);
  const oldImages = await Promise.all(oldPlatforms.map(item => registry('manifests', item.digest, true)));
  assert.ok(oldImages.some(image => image === null), 'An intact latest image must use the normal release workflow');
  const target = await registry('manifests', version);
  assert.equal(target.digest, targetDigest);
  const newPlatforms = validateIndex(target.data);
  for (const platform of newPlatforms) {
    const manifest = await registry('manifests', platform.digest);
    assert.match(manifest.data.config.digest, DIGEST);
    const config = await registry('blobs', manifest.data.config.digest);
    assert.equal(config.data.os, platform.platform.os);
    assert.equal(config.data.architecture, platform.platform.architecture);
    assert.equal(config.data.config.Labels['org.opencontainers.image.version'], version);
    assert.equal(config.data.config.Labels['org.opencontainers.image.revision'], revision);
  }
  const writeToken = await token(true);
  assert.equal((await registry('manifests', version)).digest, targetDigest);
  assert.equal((await registry('manifests', 'latest')).digest, expectedLatestDigest);
  // Write only latest, once; never rewrite either fixed version or repeat an uncertain write.
  const response = await request(REGISTRY + '/manifests/latest', {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + writeToken, 'content-type': target.data.mediaType },
    body: target.bytes,
  });
  assert.equal(response.status, 201, 'Registry promotion failed; inspect the current digest before any retry');
  assert.equal(response.headers.get('docker-content-digest'), targetDigest);
  assert.equal((await registry('manifests', 'latest')).digest, targetDigest);
  return { version, revision, previous, digest: targetDigest };
}

if (import.meta.main) {
  try {
    const result = await recoverLatest({
      version: process.env.RELEASE_VERSION,
      sourceRunId: process.env.SOURCE_RUN_ID,
      targetDigest: process.env.TARGET_IMAGE_DIGEST,
      expectedLatestDigest: process.env.EXPECTED_LATEST_DIGEST,
      githubToken: process.env.GITHUB_TOKEN,
      actor: process.env.GITHUB_ACTOR,
    });
    console.log('已将 latest 恢复为通过验收的固定版本：' + JSON.stringify(result));
  } catch (error) {
    console.error('发布恢复失败：' + (error instanceof Error ? error.message : '未知错误'));
    process.exitCode = 1;
  }
}
