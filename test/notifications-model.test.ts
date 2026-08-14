import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  assessWebhookAck,
  isValidWebhookReason,
  prepareWebhookTarget,
  WebhookTargetError,
  webhookBodyFingerprint,
  webhookRetryDelayMilliseconds,
  webhookSignature,
} from "../src/notifications/model.ts";

describe("webhook protocol model", () => {
  it("normalizes one allowed HTTPS target and binds the complete URL", () => {
    const target = prepareWebhookTarget(
      "https://hooks.example.test/payments/receive?tenant=a%26b&mode=1",
      "https://hooks.example.test",
    );
    assert.equal(target.format, "NATIVE_JSON_V1");
    assert.equal(
      target.url,
      "https://hooks.example.test/payments/receive?tenant=a%26b&mode=1",
    );
    assert.match(target.urlFingerprint, /^[0-9a-f]{64}$/);
    assert.match(target.requestFingerprint, /^[0-9a-f]{64}$/);

    const changedQuery = prepareWebhookTarget(
      "https://hooks.example.test/payments/receive?tenant=a%26b&mode=2",
      "https://hooks.example.test",
    );
    assert.notEqual(changedQuery.urlFingerprint, target.urlFingerprint);
    assert.notEqual(changedQuery.requestFingerprint, target.requestFingerprint);
  });

  it("rejects origin confusion, credentials, fragments, controls, and oversized URLs", () => {
    for (const value of [
      "http://hooks.example.test/callback",
      "https://hooks.example.test.evil.test/callback",
      "https://user@hooks.example.test/callback",
      "https://hooks.example.test/callback#fragment",
      "https://hooks.example.test/callback#",
      "https://hooks.example.test/callback?",
      "https://hooks.example.test./callback",
      " https://hooks.example.test/callback",
      "https://hooks.example.test/callback%0aheader",
      `https://hooks.example.test/${"a".repeat(4_100)}`,
      `https://hooks.example.test/${"\u4f60".repeat(1_300)}`,
    ]) {
      assert.throws(
        () => prepareWebhookTarget(value, "https://hooks.example.test"),
        (error: unknown) => error instanceof WebhookTargetError,
        value,
      );
    }

    const oversizedLabelOrigin = `https://${"a".repeat(64)}.example.test`;
    assert.throws(
      () => prepareWebhookTarget(`${oversizedLabelOrigin}/callback`, oversizedLabelOrigin),
      (error: unknown) => error instanceof WebhookTargetError,
    );
  });

  it("signs exact bytes and every delivery coordinate", () => {
    const input = {
      secret: Buffer.alloc(32, 17).toString("base64url"),
      keyId: "c45fbe13-bb39-4d31-a8b4-708bfe8fd9c3",
      timestamp: 2_000_000_000_123,
      deliveryId: "c9b3f2e7-5e8e-4ebd-b8e3-bf45c613eacb",
      eventId: "8c5fa229-bd49-482d-a40e-52f475fefcc0",
      attemptNumber: 3,
      body: Buffer.from('{"event_id":"exact","amount":100}', "utf8"),
    } as const;
    const signature = webhookSignature(input);
    assert.equal(
      signature,
      "v1=cb7b71c26ba48608b813fb3f473caf66e2adde1a04e7cfc6157deb2c826562e6",
    );
    assert.equal(
      webhookBodyFingerprint(input.body),
      "71d1d27b61f4949ff3b5775faa7a4e1a26b6dbcfe1c1a218d275acf867d584ec",
    );
    assert.notEqual(
      webhookSignature({ ...input, body: Buffer.from('{"amount":100,"event_id":"exact"}') }),
      signature,
    );
    assert.notEqual(webhookSignature({ ...input, attemptNumber: 4 }), signature);
  });

  it("accepts only the strict, matching JSON acknowledgement", () => {
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const validBody = Buffer.from(JSON.stringify({
      schema: "perpay:webhook-ack:v1",
      ack: true,
      event_id: eventId,
      delivery_id: deliveryId,
    }));
    assert.deepEqual(
      assessWebhookAck({
        status: 200,
        contentType: "application/json; charset=UTF-8",
        contentEncoding: null,
        body: validBody,
        eventId,
        deliveryId,
      }),
      { acknowledged: true, code: "acknowledged" },
    );

    const cases = [
      {
        expected: "http_status_not_ack",
        input: { status: 204, contentType: "application/json", body: validBody },
      },
      {
        expected: "ack_content_type_invalid",
        input: { status: 200, contentType: "text/json", body: validBody },
      },
      {
        expected: "ack_json_invalid",
        input: {
          status: 200,
          contentType: "application/json",
          body: Buffer.from(
            `{"schema":"perpay:webhook-ack:v1","ack":true,"ack":true,"event_id":"${eventId}","delivery_id":"${deliveryId}"}`,
          ),
        },
      },
      {
        expected: "ack_shape_invalid",
        input: {
          status: 200,
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ ack: true })),
        },
      },
      {
        expected: "ack_event_mismatch",
        input: {
          status: 200,
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({
            schema: "perpay:webhook-ack:v1",
            ack: true,
            event_id: randomUUID(),
            delivery_id: deliveryId,
          })),
        },
      },
    ] as const;
    for (const entry of cases) {
      const result = assessWebhookAck({
        ...entry.input,
        contentEncoding: null,
        eventId,
        deliveryId,
      });
      assert.equal(result.acknowledged, false);
      assert.equal(result.code, entry.expected);
    }
  });

  it("uses deterministic bounded retry jitter and one Unicode reason policy", () => {
    const deliveryId = randomUUID();
    const first = webhookRetryDelayMilliseconds({
      deliveryId,
      attemptNumber: 1,
      baseMilliseconds: 1_000,
      maximumMilliseconds: 60_000,
    });
    assert.equal(first >= 800 && first <= 1_200, true);
    assert.equal(
      webhookRetryDelayMilliseconds({
        deliveryId,
        attemptNumber: 1,
        baseMilliseconds: 1_000,
        maximumMilliseconds: 60_000,
      }),
      first,
    );
    assert.equal(webhookRetryDelayMilliseconds({
      deliveryId,
      attemptNumber: 100,
      baseMilliseconds: 1_000,
      maximumMilliseconds: 60_000,
    }) <= 60_000, true);
    assert.equal(isValidWebhookReason("😀".repeat(500)), true);
    assert.equal(isValidWebhookReason("😀".repeat(501)), false);
    assert.equal(isValidWebhookReason("\ud800"), false);
  });
});
