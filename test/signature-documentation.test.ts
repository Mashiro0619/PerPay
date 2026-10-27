import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalizeApiRequestTarget, signApiRequest, verifyApiRequestSignature } from "../src/security/api-signature.ts";
import { webhookSignature } from "../src/notifications/model.ts";

type CommonVector = { secret_base64url: string; body_utf8: string; body_hex: string; body_sha256: string; canonical_utf8: string; signature: string };
type ApiVector = CommonVector & { method: string; target: string; canonical_target: string; client_id: string; timestamp: string; nonce: string };
type WebhookVector = CommonVector & { key_id: string; timestamp: number; delivery_id: string; event_id: string; attempt: number };
const source = readFileSync(new URL("../docs/signature-vectors.md", import.meta.url), "utf8");
const blocks = [...source.matchAll(/^```json\r?\n([\s\S]*?)\r?\n```/gm)];
assert.equal(blocks.length, 1, "the document must expose one machine-readable vector block");
const vectors = JSON.parse(blocks[0]![1]!) as { api: ApiVector; webhook: WebhookVector };

function bytes(vector: CommonVector) {
  const body = Buffer.from(vector.body_hex, "hex");
  assert.equal(body.toString("hex"), vector.body_hex);
  assert.deepEqual(body, Buffer.from(vector.body_utf8, "utf8"));
  assert.equal(createHash("sha256").update(body).digest("hex"), vector.body_sha256);
  const key = Buffer.from(vector.secret_base64url, "base64url");
  assert.equal(key.length, 32);
  assert.equal(key.toString("base64url"), vector.secret_base64url);
  return { body, key };
}

describe("published signature vectors", () => {
  it("matches the documented API bytes, canonical target and signature", () => {
    const vector = vectors.api;
    const { body, key } = bytes(vector);
    assert.equal(canonicalizeApiRequestTarget(vector.target), vector.canonical_target);
    assert.equal(vector.canonical_utf8, ["PERPAY-HMAC-SHA256", "v1", vector.method, vector.canonical_target,
      vector.timestamp, vector.nonce, vector.client_id, vector.body_sha256].join("\n"));
    assert.equal(createHmac("sha256", key).update(vector.canonical_utf8).digest("hex"), vector.signature);
    const input = { secret: key, method: vector.method, target: vector.target, body, clientId: vector.client_id, timestamp: vector.timestamp, nonce: vector.nonce };
    assert.equal(signApiRequest(input).signature, vector.signature);
    const verified = verifyApiRequestSignature({ ...input, authentication: { version: "v1", clientId: vector.client_id,
      timestamp: vector.timestamp, nonce: vector.nonce, signature: vector.signature }, now: new Date(Number(vector.timestamp) * 1000) });
    assert.equal(verified.bodySha256, vector.body_sha256);
  });

  it("matches the documented webhook bytes, millisecond timestamp and prefixed signature", () => {
    const vector = vectors.webhook;
    const { body, key } = bytes(vector);
    assert.equal(vector.canonical_utf8, ["perpay:webhook:v1", vector.key_id, String(vector.timestamp),
      vector.delivery_id, vector.event_id, String(vector.attempt), vector.body_sha256].join("\n"));
    assert.equal("v1=" + createHmac("sha256", key).update(vector.canonical_utf8).digest("hex"), vector.signature);
    assert.equal(webhookSignature({ secret: vector.secret_base64url, keyId: vector.key_id, timestamp: vector.timestamp,
      deliveryId: vector.delivery_id, eventId: vector.event_id, attemptNumber: vector.attempt, body }), vector.signature);
  });
});
