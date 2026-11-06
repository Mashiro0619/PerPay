// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppDatabase } from '../../../src/database/database.ts';
import { AlipayLedgerProvider } from '../../../test/fixtures/alipay-legacy-provider.ts';
import { AlipayProviderError } from '../../../src/infrastructure/alipay/errors.ts';
import { NodeV3Transport } from '../../../src/infrastructure/alipay/node-transport.ts';
import { LedgerIngestService } from '../../../src/ledger/service.ts';
import { LedgerStore } from '../../../src/ledger/store.ts';
import { parseProviderKeys } from '../../../src/settings/model.ts';
import { verifyProviderApplicationKey } from '../../../src/settings/provider-key-verification.ts';
import { createFixture } from './fixture.mjs';
import { SdkAlipayLedgerProvider } from '../../../src/infrastructure/alipay/sdk-provider.ts';
import { SdkLedgerProvider as PrototypeProvider } from './provider.mjs';

const SdkLedgerProvider = process.env.PERPAY_SDK_PROTOTYPE === 'true'
  ? PrototypeProvider
  : SdkAlipayLedgerProvider;

const NOW = Date.parse('2026-11-07T12:00:00+08:00');
const input = { startTime: '2026-11-07 11:00:00', endTime: '2026-11-07 12:00:00', pageNo: 1, pageSize: 1 };
const detail = { account_log_id: 'sdk-test-1', trans_dt: '2026-11-07 11:30:00',
  trans_amount: '10.03', direction: '收入', extra_field: '保留原始字段' };
const page = { page_no: 1, page_size: 1, total_size: 1, detail_list: [detail] };

async function fixture(t, options = {}) {
  const result = await createFixture({ clock: () => NOW, ...options });
  t.after(async () => { await result.close(); assert.deepEqual(result.errors, []); });
  return result;
}

function provider(f, options = {}) {
  return new SdkLedgerProvider({ ...f.sdkConfig, transport: f.transport, ...options });
}

async function rejected(operation, code, signatureVerified) {
  let caught;
  await assert.rejects(operation, error => {
    assert.ok(error instanceof AlipayProviderError);
    assert.equal(error.code, code);
    if (signatureVerified !== undefined) assert.equal(error.signatureVerified, signatureVerified);
    caught = error;
    return true;
  });
  return caught;
}

test('real SDK signs the transported request and preserves exact verified evidence', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const body = '\n ' + JSON.stringify(page, null, 2) + '\n';
  const reply = f.signedResponse(body, { 'x-repeated': ['first', 'second'] });
  f.enqueue(reply);
  const actual = await provider(f).queryPage({ ...input, requestId: 'sdk-ledger-query' });
  f.enqueue(reply);
  const legacy = await new AlipayLedgerProvider({ ...f.sdkConfig, transport: f.transport }).queryPage(input);
  assert.deepEqual(actual, legacy);
  assert.equal(actual.rawResponse.body, body);
  assert.equal(actual.details[0].amount, '10.03');
  assert.equal(actual.details[0].raw.extra_field, detail.extra_field);
  assert.deepEqual(actual.rawResponse.headers['x-repeated'], ['first', 'second']);
  assert.ok(f.requests.every(request => request.signatureValid));
  assert.match(f.requests[0].headers['user-agent'], /alipay-sdk-nodejs/);
  assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].headers['alipay-request-id'], 'sdk-ledger-query');
  assert.match(f.requests[0].headers.authorization, /app_id=2026000000000000,/);
  const url = new URL(f.requests[0].path, 'https://openapi.alipay.com');
  assert.equal(url.pathname, '/v3/alipay/data/bill/accountlog/query');
  const query = url.searchParams;
  assert.deepEqual(Object.fromEntries(query), {
    end_time: input.endTime, page_no: '1', page_size: '1', start_time: input.startTime,
  });
});

for (const [name, mutate, code, verified] of [
  ['wrong signature', r => { r.headers['alipay-signature'] = Buffer.alloc(256).toString('base64'); }, 'response_signature_invalid', false],
  ['missing signature', r => { delete r.headers['alipay-signature']; }, 'response_signature_missing', false],
  ['duplicate signature', r => { r.headers['alipay-signature'] = [r.headers['alipay-signature'], r.headers['alipay-signature']]; }, 'response_signature_missing', false],
  ['altered body', r => { r.body = Buffer.from(JSON.stringify({ ...page, total_size: 9 })); }, 'response_signature_invalid', false],
]) {
  test(name + ' is rejected before ledger parsing', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const reply = f.signedResponse(page);
    mutate(reply);
    f.enqueue(reply);
    const error = await rejected(provider(f).queryPage(input), code, verified);
    assert.equal(error.rawBody, reply.body.toString());
    assert.ok(error.responseHeaders);
  });
}

for (const body of ['{"invalid":', '{"page_no":1,"page_no":2,"page_size":1,"total_size":0}']) {
  test('signed invalid or duplicate-key JSON preserves verified failure evidence ' + body.slice(0, 18), { timeout: 10000 }, async t => {
    const f = await fixture(t);
    f.enqueue(f.signedResponse(body));
    const error = await rejected(provider(f).queryPage(input), 'response_invalid_json', true);
    assert.equal(error.rawBody, body);
  });
}

test('invalid UTF-8 is rejected with original bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const body = Buffer.from([123, 34, 0xff, 34, 58, 49, 125]);
  f.enqueue(f.signedResponse(body));
  const error = await rejected(provider(f).queryPage(input), 'response_invalid_utf8', null);
  assert.deepEqual(Buffer.from(error.rawBody), body);
});

test('empty first page and incomplete pagination follow existing parser rules', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.enqueue(f.signedResponse({ page_no: 0, page_size: 1, total_size: 0 }));
  assert.equal((await provider(f).queryPage(input)).pageNo, 1);
  f.enqueue(f.signedResponse({ page_no: 1, page_size: 1, total_size: 1, detail_list: [] }));
  await rejected(provider(f).queryPage(input), 'pagination_invalid', true);
});

for (const [status, code] of [[401, 'remote_authentication_failed'], [403, 'remote_authorization_failed'],
  [429, 'remote_rate_limited'], [500, 'remote_server_error'], [302, 'unexpected_http_status']]) {
  test('HTTP ' + status + ' retains unverified raw evidence and never redirects', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    f.enqueue({ status, body: '<html>error, not JSON</html>', headers: { 'retry-after': '17', location: 'https://example.com/' } });
    const error = await rejected(provider(f).queryPage({ ...input, requestId: 'error-request' }), code, null);
    assert.equal(error.status, status);
    assert.equal(Buffer.from(error.rawBody).toString(), '<html>error, not JSON</html>');
    assert.equal(error.traceId, 'error-request');
    if (status === 429 || status === 500) assert.equal(error.retryAfterSeconds, 17);
    assert.equal(f.requests.length, 1);
  });
}

test('already-aborted request opens no connection', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await rejected(provider(f).queryPage({ ...input, signal: AbortSignal.abort() }), 'transport_cancelled');
  assert.equal(f.requests.length, 0);
});

for (const reason of ['timeout', 'cancel']) {
  test(reason + ' while reading destroys the socket and retains partial evidence', { timeout: 10000 }, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const first = '{"page_no":1,';
    const reply = f.signedResponse(page);
    f.enqueue({ ...reply, chunks: [{ body: first }, { body: 'rest', delayMilliseconds: 1000 }] });
    const promise = provider(f, { timeoutMilliseconds: reason === 'timeout' ? 200 : 5000 })
      .queryPage({ ...input, signal: controller.signal });
    if (reason === 'cancel') {
      const timer = setTimeout(() => controller.abort(), 200);
      t.after(() => clearTimeout(timer));
    }
    const error = await rejected(promise, reason === 'timeout' ? 'transport_timeout' : 'transport_cancelled', null);
    assert.equal(Buffer.from(error.rawBody).toString(), first);
    await f.requests[0].socketClosedPromise;
    assert.equal(f.requests[0].cancelled, true);
  });
}

test('DNS shares the overall deadline and receives cancellation', { timeout: 10000 }, async () => {
  const f = await createFixture();
  try {
    let cancelled = 0;
    const transport = new NodeV3Transport({}, {
      startHostnameResolution() { return { result: new Promise(() => {}), cancel() { cancelled++; } }; },
      request() { assert.fail('DNS deadline must stop socket creation'); },
    });
    await rejected(provider(f, { transport, timeoutMilliseconds: 50 }).queryPage(input), 'transport_timeout');
    assert.equal(cancelled, 1);
  } finally { await f.close(); }
});

test('stream body limit stops at 2 MiB with bounded evidence', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.enqueue({ body: Buffer.alloc(2 * 1024 * 1024 + 100, 65) });
  const error = await rejected(provider(f).queryPage(input), 'response_body_too_large', null);
  assert.equal(Buffer.from(error.rawBody).length, 2 * 1024 * 1024);
});

test('oversized response headers fail before an account-log page is returned', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.enqueue(f.signedResponse(page, { 'x-oversized': 'a'.repeat(17000) }));
  await assert.rejects(provider(f).queryPage(input), error => error instanceof AlipayProviderError);
});

test('parallel SDK calls keep response evidence isolated', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const reply = request => request.headers['alipay-request-id'] === 'slow'
    ? { ...f.signedResponse(page, { 'alipay-trace-id': 'slow' }), delayMilliseconds: 70 }
    : f.signedResponse({ ...page, detail_list: [{ ...detail, account_log_id: 'second' }] }, { 'alipay-trace-id': 'fast' });
  f.enqueue(reply);
  f.enqueue(reply);
  const candidate = provider(f);
  const [first, second] = await Promise.all([
    candidate.queryPage({ ...input, requestId: 'slow' }),
    candidate.queryPage({ ...input, requestId: 'fast' }),
  ]);
  assert.equal(first.traceId, 'slow');
  assert.equal(second.traceId, 'fast');
  assert.equal(first.details[0].accountLogId, 'sdk-test-1');
  assert.equal(second.details[0].accountLogId, 'second');
});

test('cancelling one concurrent call does not cancel another', { timeout: 10000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { onRequest(request) {
    if (request.headers['alipay-request-id'] === 'cancel-me') setTimeout(() => controller.abort(), 30);
  } });
  const reply = request => ({ ...f.signedResponse(page),
    delayMilliseconds: request.headers['alipay-request-id'] === 'cancel-me' ? 1000 : 0 });
  f.enqueue(reply);
  f.enqueue(reply);
  const candidate = provider(f);
  const [cancelled, success] = await Promise.allSettled([
    candidate.queryPage({ ...input, requestId: 'cancel-me', signal: controller.signal }),
    candidate.queryPage({ ...input, requestId: 'complete-me' }),
  ]);
  assert.equal(cancelled.status, 'rejected');
  assert.equal(cancelled.reason.code, 'transport_cancelled');
  assert.equal(success.status, 'fulfilled');
  assert.equal(success.value.details[0].accountLogId, detail.account_log_id);
});

test('unsupported encoding retains evidence without automatic decompression', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const reply = f.signedResponse(page, { 'content-encoding': 'gzip' });
  f.enqueue(reply);
  const error = await rejected(provider(f).queryPage(input), 'response_invalid_shape', null);
  assert.equal(error.rawBody, reply.body.toString());
  assert.equal(error.responseHeaders['content-encoding'][0], 'gzip');
  f.enqueue(f.signedResponse(page, { 'content-encoding': 'identity' }));
  assert.equal((await provider(f).queryPage(input)).rawResponse.signatureVerified, true);
});

test('cancellation after transport completion preserves the received evidence', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reply = f.signedResponse(page);
  const transport = { async request() {
    queueMicrotask(() => controller.abort());
    return reply;
  } };
  const error = await rejected(provider(f, { transport }).queryPage({ ...input, signal: controller.signal }),
    'transport_cancelled', null);
  assert.equal(error.rawBody, reply.body.toString());
  assert.equal(error.status, 200);
  assert.equal(error.traceId, reply.headers['alipay-trace-id']);
});

test('certificate identity must be present and match when configured', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const candidate = provider(f, { expectedAlipayCertSn: 'expected' });
  f.enqueue(f.signedResponse(page));
  await rejected(candidate.queryPage(input), 'response_certificate_mismatch', false);
  f.enqueue(f.signedResponse(page, { 'alipay-sn': 'different' }));
  await rejected(candidate.queryPage(input), 'response_certificate_mismatch', false);
  f.enqueue(f.signedResponse(page, { 'alipay-sn': 'expected' }));
  assert.equal((await candidate.queryPage(input)).rawResponse.signatureVerified, true);
});

test('PKCS1 and KeyObject inputs use the same SDK signing identity', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const privateKey = createPrivateKey(f.sdkConfig.privateKey);
  const publicKey = createPublicKey(f.sdkConfig.alipayPublicKey);
  for (const key of [privateKey, privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()]) {
    f.enqueue(f.signedResponse(page));
    const result = await provider(f, { privateKey: key, alipayPublicKey: publicKey }).queryPage(input);
    assert.equal(result.rawResponse.signatureVerified, true);
  }
  assert.ok(f.requests.every(request => request.signatureValid));
});

test('SDK verifies a full 2000-entry page through dispatcher backpressure', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const details = Array.from({ length: 2000 }, (_, index) => ({ ...detail, account_log_id: 'entry-' + index }));
  const body = JSON.stringify({ page_no: 1, page_size: 2000, total_size: 2001, detail_list: details });
  f.enqueue(f.signedResponse(body));
  const result = await provider(f).queryPage({ ...input, pageSize: 2000 });
  assert.equal(result.hasMore, true);
  assert.equal(result.details.length, 2000);
  assert.equal(result.rawResponse.body, body);
});

test('the real application-key check consumes the SDK candidate', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const settings = parseProviderKeys({ environment: 'PRODUCTION', appId: f.sdkConfig.appId,
    privateKey: f.sdkConfig.privateKey, publicKey: f.sdkConfig.alipayPublicKey,
    timeoutMilliseconds: 120000, scanIntervalMilliseconds: 60000, activeScanIntervalMilliseconds: 8000,
    safetyLagMilliseconds: 10000, maximumSuccessAgeMilliseconds: 120000 });
  let creates = 0;
  await verifyProviderApplicationKey(settings, {}, {
    transport: f.transport, clock: () => NOW,
    createProvider(options) { creates++; assert.equal(options.timeoutMilliseconds, 8000); return new SdkLedgerProvider(options); },
  });
  assert.equal(creates, 1);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0].signatureValid);
  const query = new URL(f.requests[0].path, 'https://openapi.alipay.com').searchParams;
  assert.equal(query.get('page_size'), '1');
  assert.equal(query.get('page_no'), '1');
  assert.equal(query.get('start_time'), '2026-11-07 11:58:50');
  assert.equal(query.get('end_time'), '2026-11-07 11:59:50');
});

test('the real ingest service persists the SDK raw response in temporary SQLite', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'perpay-sdk-validation-'));
  const database = await AppDatabase.open(join(directory, 'database.sqlite3'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new LedgerStore(database);
  store.bindProviderIdentity({ providerAccountKey: 'sdk-account', providerKind: 'alipay',
    endpoint: 'https://openapi.alipay.com', externalAccountId: f.sdkConfig.appId }, NOW);
  const body = JSON.stringify(page, null, 2) + '\n';
  f.enqueue(f.signedResponse(body));
  const service = new LedgerIngestService({ provider: provider(f), store, providerAccountKey: 'sdk-account',
    pageSize: 1, windowMilliseconds: 3600000, safetyLagMilliseconds: 0,
    initialWindowStartMilliseconds: NOW - 3600000, clock: () => NOW });
  const result = await service.run('sdk-validation');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.createdEntries, 1);
  const evidence = database.read(connection => connection.prepare('SELECT raw_body, signature_verified FROM provider_raw_pages').get());
  assert.equal(Buffer.from(evidence.raw_body).toString(), body);
  assert.equal(Number(evidence.signature_verified), 1);
  assert.equal(createHash('sha256').update(evidence.raw_body).digest('hex'), createHash('sha256').update(body).digest('hex'));
});

test('the real ingest service persists SDK rejection evidence without creating ledger entries', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'perpay-sdk-failure-'));
  const database = await AppDatabase.open(join(directory, 'database.sqlite3'));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new LedgerStore(database);
  store.bindProviderIdentity({ providerAccountKey: 'sdk-rejection', providerKind: 'alipay',
    endpoint: 'https://openapi.alipay.com', externalAccountId: f.sdkConfig.appId }, NOW);
  const reply = f.signedResponse(page, { 'alipay-signature': Buffer.alloc(256).toString('base64') });
  f.enqueue(reply);
  const service = new LedgerIngestService({ provider: provider(f), store, providerAccountKey: 'sdk-rejection',
    pageSize: 1, windowMilliseconds: 3600000, safetyLagMilliseconds: 0,
    initialWindowStartMilliseconds: NOW - 3600000, clock: () => NOW });
  const result = await service.run('sdk-rejected-response');
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'response_signature_invalid');
  const evidence = database.read(connection => connection.prepare('SELECT raw_body, signature_verified, error_code FROM ingest_errors').get());
  assert.deepEqual(Buffer.from(evidence.raw_body), reply.body);
  assert.equal(Number(evidence.signature_verified), 0);
  assert.equal(store.listLedgerEntries().length, 0);
});
