// SPDX-License-Identifier: MIT
// Synthetic keys and orders below are test vectors, never live credentials.
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DemoError, PerPayClient, decodeKey, orderSnapshot, perpayOrigin, signRequest, verifyWebhook } from '../perpay.mjs';
import { DemoStore } from '../store.mjs';
import { createDemoServer, orderPayload, readConfig } from '../server.mjs';

const secret = Buffer.alloc(32, 0x51);
const origin = 'http://127.0.0.1:6190';
const orderId = '11111111-1111-4111-8111-111111111111';
const keyId = '22222222-2222-4222-8222-222222222222';
const no = 'DEMO-test-001';
const input = { merchant_order_no: no, amount: '0.01', product_name: '示例商品', note: '', confirm_real_payment: true };
const config = { url: origin, secret: secret.toString('base64url'), port: 6196, database: ':memory:', notifyUrl: 'https://shop.example.com/webhooks/perpay', webhookSecret: secret };
const payload = () => orderPayload(input, config);
const snapshot = (version = 1, status = 'UNPAID') => ({ order_id: orderId, merchant_order_no: no, requested_amount_cents: 1, payable_amount_cents: 2, received_amount_cents: status === 'UNPAID' ? null : 2, currency: 'CNY', payment_status: status, refund_status: 'NONE', version });
function webhook({ eventId = randomUUID(), deliveryId = randomUUID(), version = 2, status = 'CONFIRMED', timestamp = Date.now(), extra = {} } = {}) {
  const data = snapshot(version, status);
  const event = { schema: 'perpay:outbox-event:v2', event_id: eventId, event_type: status === 'DISPUTED' ? 'PAYMENT_DISPUTED' : 'PAYMENT_CONFIRMED', ...data, order_version: version, ...extra };
  const bytes = Buffer.from(JSON.stringify(event));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signature = 'v1=' + createHmac('sha256', secret).update(['perpay:webhook:v1', keyId, timestamp, deliveryId, eventId, 1, digest].join('\n')).digest('hex');
  const headers = new Headers({ 'content-type': 'application/json', 'x-perpay-webhook-version': '1', 'x-perpay-webhook-key-id': keyId, 'x-perpay-webhook-timestamp': String(timestamp), 'x-perpay-webhook-delivery-id': deliveryId, 'x-perpay-webhook-event-id': eventId, 'x-perpay-webhook-attempt': '1', 'x-perpay-webhook-signature': signature });
  return { bytes, headers, event };
}
async function serverFixture(t, overrides = {}) {
  const store = new DemoStore(':memory:', origin);
  const client = overrides.client ?? { createOrder: async () => { throw new DemoError(502, 'synthetic network failure'); } };
  const app = createDemoServer({ config: { ...config, ...overrides }, store, client });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolveClose => app.server.close(resolveClose)); store.close(); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const state = await fetch(base + '/demo/state').then(response => response.json());
  return { ...app, base, csrf: state.csrf, headers: { origin: base, 'content-type': 'application/json', 'x-demo-csrf': state.csrf } };
}

describe('standalone PerPay caller demo', () => {
  it('signs exact UTF-8 bytes with second timestamps and fresh nonces', () => {
    const body = Buffer.from(JSON.stringify(payload()));
    const first = signRequest(secret, 'POST', '/api/v1/orders', body, 2000000000123);
    const second = signRequest(secret, 'POST', '/api/v1/orders', body, 2000000000123);
    const text = ['PERPAY-HMAC-SHA256', 'v1', 'POST', '/api/v1/orders', '2000000000', first['x-perpay-nonce'], 'default', createHash('sha256').update(body).digest('hex')].join('\n');
    assert.equal(first['x-perpay-signature'], createHmac('sha256', secret).update(text).digest('hex'));
    assert.notEqual(first['x-perpay-nonce'], second['x-perpay-nonce']);
    assert.equal(Buffer.from(first['x-perpay-nonce'], 'base64url').length, 32);
  });
  it('rejects placeholder keys, unsafe URLs and arbitrary request targets', () => {
    assert.throws(() => decodeKey('replace-me', 'API'));
    for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/admin', 'https://example.com/?x=1']) assert.throws(() => perpayOrigin(url));
    assert.equal(perpayOrigin(origin), origin);
    assert.throws(() => signRequest(secret, 'GET', 'https://evil.example', Buffer.alloc(0)));
  });
  it('requires explicit real-order confirmation and parses decimal amounts without floats', () => {
    assert.throws(() => orderPayload({ ...input, confirm_real_payment: false }, config));
    assert.equal(orderPayload({ ...input, amount: '0.29' }, config).amount_cents, 29);
    for (const amount of ['0', '1e2', '1.001', '100.01', '-1']) assert.throws(() => orderPayload({ ...input, amount }, config));
  });
  it('requires callbacks by default rather than silently switching to manual queries', () => {
    const env = { PERPAY_URL: origin, PERPAY_API_SECRET: secret.toString('base64url') };
    for (const incomplete of [env, { ...env, DEMO_NOTIFY_URL: config.notifyUrl }, { ...env, PERPAY_WEBHOOK_SECRET: secret.toString('base64url') }]) {
      assert.throws(() => readConfig(incomplete), /DEMO_NOTIFY_URL.*PERPAY_WEBHOOK_SECRET/);
    }
    const configured = readConfig({ ...env, DEMO_NOTIFY_URL: config.notifyUrl, PERPAY_WEBHOOK_SECRET: secret.toString('base64url') });
    assert.equal(configured.notifyUrl, config.notifyUrl); assert.deepEqual(configured.webhookSecret, secret);
    assert.equal(orderPayload(input, configured).notify_url, config.notifyUrl);
    for (const notifyUrl of ['http://127.0.0.1/webhooks/perpay', 'https://shop.example.com:8443/webhooks/perpay', 'https://shop.example.com/wrong-path', 'https://shop.example.com/webhooks/perpay?x=1']) {
      assert.throws(() => readConfig({ ...env, DEMO_NOTIFY_URL: notifyUrl, PERPAY_WEBHOOK_SECRET: secret.toString('base64url') }));
    }
  });
  it('disables redirects and signs exactly the body passed to fetch', async () => {
    let observed;
    const client = new PerPayClient({ ...config, fetchImpl: async (url, options) => { observed = { url, options }; return Response.json({ data: { ok: true } }); } });
    await client.createOrder(payload());
    assert.equal(observed.url, origin + '/api/v1/orders');
    assert.equal(observed.options.redirect, 'error');
    assert.equal(observed.options.body.toString(), JSON.stringify(payload()));
    assert.equal(observed.options.headers['x-perpay-client-id'], 'default');
  });
  it('keeps network exceptions and key material out of public errors', async () => {
    const client = new PerPayClient({ ...config, fetchImpl: async () => { throw new Error(secret.toString('base64url')); } });
    await assert.rejects(client.createOrder(payload()), error => error instanceof DemoError && !error.message.includes(secret.toString('base64url')));
  });
  it('persists immutable parameters before retries and rejects changes to the same business number', () => {
    const store = new DemoStore(':memory:', origin);
    try { store.prepare(payload()); assert.deepEqual(store.prepare(payload()).request, payload()); assert.throws(() => store.prepare({ ...payload(), amount_cents: 99 })); assert.equal(store.list().length, 1); }
    finally { store.close(); }
  });
  it('accepts signed raw bytes but rejects tampering, stale seconds and header/body ID mismatch', () => {
    const signed = webhook(); assert.equal(verifyWebhook(signed.headers, signed.bytes, secret).event.event_id, signed.event.event_id);
    assert.throws(() => verifyWebhook(signed.headers, Buffer.concat([signed.bytes, Buffer.from(' ')]), secret));
    const seconds = webhook({ timestamp: Math.floor(Date.now() / 1000) }); assert.throws(() => verifyWebhook(seconds.headers, seconds.bytes, secret));
    const old = webhook({ timestamp: Date.now() - 300001 }); assert.throws(() => verifyWebhook(old.headers, old.bytes, secret));
    const mismatch = webhook({ extra: { event_id: randomUUID() } }); assert.throws(() => verifyWebhook(mismatch.headers, mismatch.bytes, secret));
  });
  it('deduplicates events, rejects conflicting event bodies and ignores lower versions', () => {
    const store = new DemoStore(':memory:', origin);
    try {
      store.prepare(payload()); const signed = webhook(); const verified = verifyWebhook(signed.headers, signed.bytes, secret);
      assert.equal(store.receive(verified), 'updated'); assert.equal(store.receive(verified), 'duplicate');
      assert.throws(() => store.receive({ ...verified, digest: '0'.repeat(64) }));
      const newer = webhook({ version: 3, status: 'DISPUTED' }); store.receive(verifyWebhook(newer.headers, newer.bytes, secret));
      const older = webhook({ version: 2 }); assert.equal(store.receive(verifyWebhook(older.headers, older.bytes, secret)), 'ignored_older_version');
      assert.equal(store.get(no).snapshot.payment_status, 'DISPUTED'); assert.equal(store.events().length, 3);
    } finally { store.close(); }
  });
  it('does not apply a valid signature to an order with a mismatched amount', () => {
    const store = new DemoStore(':memory:', origin);
    try { store.prepare(payload()); const signed = webhook({ extra: { requested_amount_cents: 2 } }); assert.throws(() => store.receive(verifyWebhook(signed.headers, signed.bytes, secret))); assert.equal(store.events().length, 0); assert.equal(store.get(no).snapshot, null); }
    finally { store.close(); }
  });
  it('preserves receipt deduplication and pending orders after a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'perpay-demo-test-'));
    let store = new DemoStore(join(directory, 'demo.sqlite3'), origin);
    try {
      store.prepare(payload()); const signed = webhook(); const verified = verifyWebhook(signed.headers, signed.bytes, secret); store.receive(verified); store.close();
      store = new DemoStore(join(directory, 'demo.sqlite3'), origin);
      assert.equal(store.receive(verified), 'duplicate'); assert.equal(store.get(no).snapshot.version, 2);
      assert.throws(() => new DemoStore(join(directory, 'demo.sqlite3'), 'https://other.example'));
    } finally { store.close(); if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('perpay-demo-test-')) throw new Error('unsafe cleanup'); rmSync(directory, { recursive: true }); }
  });
  it('rejects off-origin checkout URLs', () => {
    assert.throws(() => orderSnapshot({ checkout: { checkout_url: 'https://evil.example/checkout/pct1_' + 'a'.repeat(43) } }, origin));
  });
  it('requires local host, same origin and an anti-CSRF token for order creation', async t => {
    const { base, headers, store } = await serverFixture(t);
    const denied = await fetch(base + '/demo/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); assert.equal(denied.status, 403);
    // Undici controls Host itself; use node:http to actually send a foreign Host.
    const foreignStatus = await new Promise((resolveStatus, reject) => {
      const request = httpRequest(base + '/demo/state', { headers: { host: 'evil.example' } }, response => {
        response.resume(); resolveStatus(response.statusCode);
      });
      request.on('error', reject); request.end();
    });
    assert.equal(foreignStatus, 403);
    const submitted = await fetch(base + '/demo/orders', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(submitted.status, 502);
    assert.deepEqual(store.get(no).request, payload());
    const state = await fetch(base + '/demo/state').then(response => response.text()); assert.equal(state.includes(secret.toString('base64url')), false);
    const hidden = await fetch(base + '/.env'); assert.equal(hidden.status, 404);
  });
  it('updates local state from a verified callback without querying PerPay', async t => {
    const requests = [];
    const created = { ...snapshot(), checkout: { status: 'OPEN', expires_at: new Date(Date.now() + 60_000).toISOString() }, payment: { status: 'UNPAID', received_amount_cents: null }, refund: { status: 'NONE' } };
    const { base, headers } = await serverFixture(t, { client: {
      createOrder: async request => { requests.push(request); return created; },
      getOrder: async () => { throw new Error('automatic upstream query is forbidden'); },
      getByMerchantNo: async () => { throw new Error('automatic upstream query is forbidden'); },
    } });
    const submitted = await fetch(base + '/demo/orders', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(submitted.status, 200); assert.equal(requests[0].notify_url, config.notifyUrl);
    const before = await fetch(base + '/demo/state').then(response => response.json());
    assert.equal(before.notifications, true); assert.equal(before.orders[0].notifications, true); assert.equal(before.orders[0].snapshot.payment_status, 'UNPAID');
    const signed = webhook();
    const rejected = await fetch(base + '/webhooks/perpay', { method: 'POST', headers: signed.headers, body: Buffer.concat([signed.bytes, Buffer.from(' ')]) });
    assert.equal(rejected.status, 401);
    const stillWaiting = await fetch(base + '/demo/state').then(response => response.json()); assert.equal(stillWaiting.orders[0].snapshot.payment_status, 'UNPAID');
    const received = await fetch(base + '/webhooks/perpay', { method: 'POST', headers: signed.headers, body: signed.bytes });
    assert.equal(received.status, 200);
    const after = await fetch(base + '/demo/state').then(response => response.json());
    assert.equal(after.orders[0].snapshot.payment_status, 'CONFIRMED'); assert.equal(after.orders[0].snapshot.source, 'webhook'); assert.equal(after.events.length, 1);
    assert.equal(requests.length, 1);
  });
  it('keeps the original callback parameters when retrying an old order', async t => {
    const requests = [];
    const { base, headers, store } = await serverFixture(t, { client: { createOrder: async request => { requests.push(request); throw new DemoError(502, 'synthetic failure'); } } });
    const { notify_url: _notify, ...original } = payload(); store.prepare(original);
    const result = await fetch(base + '/demo/orders/' + no + '/retry', { method: 'POST', headers, body: '{}' });
    assert.equal(result.status, 502); assert.deepEqual(requests, [original]); assert.equal(store.list()[0].notifications, false);
  });
  it('returns the exact protocol ACK after durable receipt, including duplicate deliveries', async t => {
    const { base, store } = await serverFixture(t); store.prepare(payload());
    const signed = webhook();
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(base + '/webhooks/perpay', { method: 'POST', headers: signed.headers, body: signed.bytes });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { schema: 'perpay:webhook-ack:v1', ack: true, event_id: signed.event.event_id, delivery_id: signed.headers.get('x-perpay-webhook-delivery-id') });
    }
    assert.equal(store.events().length, 1);
  });
});
