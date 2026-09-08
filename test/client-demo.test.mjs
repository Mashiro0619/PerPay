// SPDX-License-Identifier: MIT
// All credentials, orders and provider health here are isolated test fixtures.
import '../examples/node-client/test/demo.test.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/http/app.ts';
import { assessWebhookAck, webhookSignature } from '../src/notifications/model.ts';
import { signApiRequest } from '../src/security/api-signature.ts';
import { PerPayClient, orderSnapshot, signRequest } from '../examples/node-client/perpay.mjs';
import { createDemoServer, orderPayload } from '../examples/node-client/server.mjs';
import { DemoStore } from '../examples/node-client/store.mjs';
import { createConfiguredHttpServices } from './http-fixture.ts';

const secret = Buffer.alloc(32, 0x54);
const origin = 'http://127.0.0.1:6190';
const config = { url: origin, secret: secret.toString('base64url'), database: ':memory:', notifyUrl: null, webhookSecret: secret };
const input = { merchant_order_no: 'DEMO-integration-001', amount: '0.29', product_name: '中文商品 🍵', note: '逐字节签名', confirm_real_payment: true };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'perpay-client-demo-'));
  let services;
  t.after(() => {
    services?.database.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('perpay-client-demo-')) throw new Error('unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  services = await createConfiguredHttpServices({ directory, apiSecret: config.secret, collectionCodePayload: 'https://qr.alipay.com/demo-isolated-fixture', publicUrl: origin });
  const health = () => ({ enabled: true, state: 'healthy', inFlight: false, lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastErrorCode: null, consecutiveFailures: 0 });
  const app = createApp({ ...services, startedAt: new Date(), ledgerHealth: health, reconciliationHealth: () => ({ ...health(), pendingOrders: 0, continuationPending: false }) });
  const requests = [];
  // Exercise the real Hono router and authentication without any provider transport.
  const client = new PerPayClient({ ...config, fetchImpl: async (url, options) => {
    const response = await app.request(url, options);
    requests.push({ url, options, status: response.status });
    return response;
  } });
  return { ...services, app, client, requests };
}

describe('caller demo compatibility with PerPay', () => {
  it('matches the server signer for UTF-8 order bodies and empty GET bodies', () => {
    for (const [method, target, bytes] of [
      ['POST', '/api/v1/orders', Buffer.from(JSON.stringify(orderPayload(input, config)))],
      ['GET', '/api/v1/orders/by-merchant-no/' + input.merchant_order_no, Buffer.alloc(0)],
    ]) {
      const headers = signRequest(secret, method, target, bytes);
      const server = signApiRequest({ secret, method, target, body: bytes, clientId: 'default', timestamp: headers['x-perpay-timestamp'], nonce: headers['x-perpay-nonce'] });
      assert.equal(headers['x-perpay-signature'], server.signature);
      assert.equal(headers['x-perpay-signature-version'], server.version);
    }
  });

  it('creates, retries and queries the same actual order without changing business parameters', async t => {
    const { client, requests, app } = await fixture(t);
    const payload = orderPayload(input, config);
    const created = await client.createOrder(payload);
    assert.equal(requests[0].status, 201);
    assert.equal(created.requested_amount_cents, 29);
    assert.equal(created.product_name, input.product_name);
    assert.equal(orderSnapshot(created, origin).checkout_status, 'OPEN');
    assert.equal((await client.createOrder(payload)).order_id, created.order_id);
    assert.equal(requests[1].status, 200);
    assert.notEqual(requests[0].options.headers['x-perpay-nonce'], requests[1].options.headers['x-perpay-nonce']);
    assert.equal((await client.getOrder(created.order_id)).order_id, created.order_id);
    assert.equal((await client.getByMerchantNo(input.merchant_order_no)).order_id, created.order_id);
    await assert.rejects(client.createOrder({ ...payload, amount_cents: 30 }), /409/);
    // The server must reject the demo's signature if the transmitted bytes change.
    const bytes = Buffer.from(JSON.stringify(payload));
    const tampered = await app.request('/api/v1/orders', { method: 'POST', headers: signRequest(secret, 'POST', '/api/v1/orders', bytes), body: Buffer.concat([bytes, Buffer.from(' ')]) });
    assert.equal(tampered.status, 401);
  });

  it('recovers a lost create response by business number and safely retries the original request', async t => {
    const { app, client } = await fixture(t);
    let loseResponse = true;
    const lossyClient = new PerPayClient({ ...config, fetchImpl: async (url, options) => {
      const response = await app.request(url, options);
      if (loseResponse) { loseResponse = false; throw new Error('synthetic connection loss after commit'); }
      return response;
    } });
    const store = new DemoStore(':memory:', origin);
    t.after(() => store.close());
    store.prepare(orderPayload(input, config));
    await assert.rejects(lossyClient.createOrder(store.get(input.merchant_order_no).request));
    const found = await client.getByMerchantNo(input.merchant_order_no);
    store.apply(orderSnapshot(found, origin), 'api');
    const retried = await lossyClient.createOrder(store.get(input.merchant_order_no).request);
    assert.equal(retried.order_id, found.order_id);
    assert.equal(store.list().length, 1);
  });

  it('accepts the backend webhook signer and returns an ACK accepted by the backend', async t => {
    const { client } = await fixture(t);
    const created = await client.createOrder(orderPayload(input, config));
    const store = new DemoStore(':memory:', origin);
    store.prepare(orderPayload(input, config));
    store.apply(orderSnapshot(created, origin), 'api');
    const { server } = createDemoServer({ config, client, store });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await new Promise(done => server.close(done)); store.close(); });
    const eventId = randomUUID();
    const body = Buffer.from(JSON.stringify({
      schema: 'perpay:outbox-event:v2', event_id: eventId, event_type: 'PAYMENT_CONFIRMED',
      order_id: created.order_id, merchant_order_no: created.merchant_order_no, product_name: created.product_name,
      currency: 'CNY', requested_amount_cents: created.requested_amount_cents,
      payable_amount_cents: created.payable_amount_cents, received_amount_cents: created.payable_amount_cents,
      payment_status: 'CONFIRMED', refund_status: 'NONE', order_version: created.version + 1,
    }));
    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber++) {
      const keyId = randomUUID(), deliveryId = randomUUID(), timestamp = Date.now();
      const headers = {
        'content-type': 'application/json; charset=utf-8', 'x-perpay-webhook-version': '1',
        'x-perpay-webhook-key-id': keyId, 'x-perpay-webhook-timestamp': String(timestamp),
        'x-perpay-webhook-delivery-id': deliveryId, 'x-perpay-webhook-event-id': eventId,
        'x-perpay-webhook-attempt': String(attemptNumber),
        'x-perpay-webhook-signature': webhookSignature({ secret: config.secret, keyId, timestamp, deliveryId, eventId, attemptNumber, body }),
      };
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhooks/perpay', { method: 'POST', headers, body });
      const result = assessWebhookAck({ status: response.status, contentType: response.headers.get('content-type'), contentEncoding: response.headers.get('content-encoding'), body: new Uint8Array(await response.arrayBuffer()), eventId, deliveryId });
      assert.deepEqual(result, { acknowledged: true, code: 'acknowledged' });
    }
    assert.equal(store.events().length, 1);
    assert.equal(store.get(created.merchant_order_no).snapshot.payment_status, 'CONFIRMED');
  });
});
