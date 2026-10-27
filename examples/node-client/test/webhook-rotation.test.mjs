// SPDX-License-Identifier: MIT
// Synthetic signing keys and payloads, never live credentials or transactions.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { DemoError, verifyWebhook } from '../perpay.mjs';

const now = 2_000_000_000_000;
const oldKeyId = '11111111-1111-4111-8111-111111111111';
const newKeyId = '22222222-2222-4222-8222-222222222222';
const unknownKeyId = '33333333-3333-4333-8333-333333333333';
const oldSecret = Buffer.alloc(32, 0x61);
const newSecret = Buffer.alloc(32, 0x62);
const keys = new Map([[oldKeyId, oldSecret], [newKeyId, newSecret]]);

function signed({ keyId = oldKeyId, secret = oldSecret, timestamp = now } = {}) {
  const event = {
    schema: 'perpay:outbox-event:v2',
    event_id: '44444444-4444-4444-8444-444444444444',
    event_type: 'PAYMENT_CONFIRMED',
    order_id: '55555555-5555-4555-8555-555555555555',
    merchant_order_no: 'DEMO-rotation-test',
    currency: 'CNY', requested_amount_cents: 100, payable_amount_cents: 101,
    received_amount_cents: 101, payment_status: 'CONFIRMED', refund_status: 'NONE',
    order_version: 2,
  };
  const deliveryId = '66666666-6666-4666-8666-666666666666';
  const bytes = Buffer.from(JSON.stringify(event));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const material = ['perpay:webhook:v1', keyId, timestamp, deliveryId, event.event_id, 1, digest].join('\n');
  const signature = 'v1=' + createHmac('sha256', secret).update(material).digest('hex');
  const headers = new Headers({
    'x-perpay-webhook-version': '1', 'x-perpay-webhook-key-id': keyId,
    'x-perpay-webhook-timestamp': String(timestamp), 'x-perpay-webhook-delivery-id': deliveryId,
    'x-perpay-webhook-event-id': event.event_id, 'x-perpay-webhook-attempt': '1',
    'x-perpay-webhook-signature': signature,
  });
  return { headers, bytes, event };
}

const statusIs = status => error => error instanceof DemoError && error.status === status;

describe('caller webhook key selection and recoverable clock errors', () => {
  it('verifies both configured keys by the signed key ID', () => {
    for (const [keyId, secret] of keys) {
      const request = signed({ keyId, secret });
      const verified = verifyWebhook(request.headers, request.bytes, keys, now);
      assert.equal(verified.keyId, keyId);
      assert.deepEqual(verified.event, request.event);
    }
  });

  it('returns 503 for an unknown key ID even when another configured key signed it', () => {
    const request = signed({ keyId: unknownKeyId });
    assert.throws(() => verifyWebhook(request.headers, request.bytes, keys, now), statusIs(503));
  });

  it('rejects a known key ID signed by the other configured key', () => {
    const request = signed({ keyId: oldKeyId, secret: newSecret });
    assert.throws(() => verifyWebhook(request.headers, request.bytes, keys, now), statusIs(401));
  });

  it('rejects tampered raw bytes before parsing their otherwise valid JSON', () => {
    const request = signed();
    const changedBytes = Buffer.concat([request.bytes, Buffer.from(' ')]);
    assert.throws(() => verifyWebhook(request.headers, changedBytes, keys, now), statusIs(401));
  });

  for (const offset of [-300001, 300001]) {
    it(`returns 503 for a well-formed timestamp ${offset} ms from the local clock`, () => {
      const request = signed({ timestamp: now + offset });
      assert.throws(() => verifyWebhook(request.headers, request.bytes, oldSecret, now), statusIs(503));
    });
  }

  it('accepts the exact five-minute clock boundary', () => {
    for (const offset of [-300000, 300000]) {
      const request = signed({ timestamp: now + offset });
      assert.equal(verifyWebhook(request.headers, request.bytes, oldSecret, now).keyId, oldKeyId);
    }
  });

  it('keeps malformed protocol headers as 401 failures', () => {
    for (const [name, value] of [
      ['version', '2'], ['key-id', 'invalid-id'], ['timestamp', '0'],
      ['timestamp', '02000000000000'], ['timestamp', '9007199254740992'],
      ['delivery-id', 'invalid-id'], ['event-id', 'invalid-id'],
      ['attempt', '0'], ['signature', 'v1=invalid'],
    ]) {
      const request = signed();
      request.headers.set('x-perpay-webhook-' + name, value);
      assert.throws(() => verifyWebhook(request.headers, request.bytes, oldSecret, now), statusIs(401), name);
    }
  });

  it('preserves the existing single decoded Buffer key mode', () => {
    const request = signed();
    assert.deepEqual(verifyWebhook(request.headers, request.bytes, oldSecret, now).event, request.event);
    assert.throws(() => verifyWebhook(request.headers, request.bytes, newSecret, now), statusIs(401));
  });
});
