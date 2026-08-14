import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  CHECKOUT_TOKEN_DERIVATION_VERSION,
  CHECKOUT_TOKEN_KEY_BYTES,
  CHECKOUT_TOKEN_PREFIX,
  deriveCheckoutToken,
  digestCheckoutToken,
  isCanonicalCheckoutToken,
} from "../src/orders/checkout-token.ts";

const vectorKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const vectorCheckoutId = "018f47d2-c921-7b6a-a1f4-1c9b31c48f45";
const vectorToken = "pct1_YraBS6NVdSsDVC8FIpBxXw5f-YzujXN6gW-ptdzHSZA";
const vectorDigest = "a92b7cf7d97915e6de657256234fce80c852db4525d713a2252f7e076abb5f48";

describe("public checkout token derivation", () => {
  it("matches the fixed versioned HMAC-SHA256 vector deterministically", () => {
    assert.equal(CHECKOUT_TOKEN_DERIVATION_VERSION, 1);
    assert.equal(deriveCheckoutToken(vectorKey, vectorCheckoutId), vectorToken);
    assert.equal(deriveCheckoutToken(vectorKey, vectorCheckoutId), vectorToken);
  });

  it("separates different keys and checkout IDs", () => {
    const changedKey = Buffer.from(vectorKey);
    changedKey[0] = changedKey[0]! ^ 0xff;

    const tokens = new Set([
      deriveCheckoutToken(vectorKey, vectorCheckoutId),
      deriveCheckoutToken(changedKey, vectorCheckoutId),
      deriveCheckoutToken(vectorKey, "018f47d2-c921-7b6a-a1f4-1c9b31c48f46"),
    ]);
    assert.equal(tokens.size, 3);
  });

  it("emits exactly one versioned prefix and 32 canonical base64url bytes", () => {
    const token = deriveCheckoutToken(vectorKey, vectorCheckoutId);
    const payload = token.slice(CHECKOUT_TOKEN_PREFIX.length);

    assert.equal(CHECKOUT_TOKEN_KEY_BYTES, 32);
    assert.equal(CHECKOUT_TOKEN_PREFIX, "pct1_");
    assert.equal(token.length, 48);
    assert.match(token, /^pct1_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(payload, "base64url").byteLength, 32);
    assert.equal(Buffer.from(payload, "base64url").toString("base64url"), payload);
    assert.equal(isCanonicalCheckoutToken(token), true);
  });

  it("rejects keys that are not exactly 32 bytes", () => {
    assert.throws(
      () => deriveCheckoutToken(Buffer.alloc(31), vectorCheckoutId),
      RangeError,
    );
    assert.throws(
      () => deriveCheckoutToken(Buffer.alloc(33), vectorCheckoutId),
      RangeError,
    );
    assert.throws(
      () =>
        deriveCheckoutToken(
          "not-key-bytes" as unknown as Uint8Array,
          vectorCheckoutId,
        ),
      TypeError,
    );
  });

  it("rejects malformed and noncanonical checkout UUIDs", () => {
    const invalidCheckoutIds: readonly unknown[] = [
      "",
      vectorCheckoutId.toUpperCase(),
      vectorCheckoutId.replaceAll("-", ""),
      `{${vectorCheckoutId}}`,
      `${vectorCheckoutId} `,
      "018f47d2-c921-7b6a-a1f4-1c9b31c48f4z",
      "018f47d2-c921-7b6a-a1f4-1c9b31c48f450",
      undefined,
    ];

    for (const checkoutId of invalidCheckoutIds) {
      assert.throws(
        () => deriveCheckoutToken(vectorKey, checkoutId as string),
        TypeError,
        String(checkoutId),
      );
    }
  });
});

describe("public checkout token validation and lookup digest", () => {
  it("strictly rejects malformed and noncanonical tokens", () => {
    const payload = vectorToken.slice(CHECKOUT_TOKEN_PREFIX.length);
    const invalidTokens: readonly unknown[] = [
      "",
      undefined,
      null,
      1,
      vectorToken.slice(0, -1),
      `${vectorToken}A`,
      `${vectorToken}=`,
      `PCT1_${payload}`,
      `pct2_${payload}`,
      `pct1_${payload.slice(0, -1)}*`,
      `pct1_${payload.slice(0, -1)}B`,
    ];

    for (const token of invalidTokens) {
      assert.equal(isCanonicalCheckoutToken(token), false, String(token));
      if (typeof token === "string") {
        assert.throws(() => digestCheckoutToken(token), TypeError, token);
      }
    }
  });

  it("returns the fixed lowercase SHA-256 digest used for database lookup", () => {
    const independentlyCalculated = createHash("sha256")
      .update(vectorToken, "ascii")
      .digest("hex");

    assert.equal(digestCheckoutToken(vectorToken), vectorDigest);
    assert.equal(digestCheckoutToken(vectorToken), independentlyCalculated);
    assert.match(vectorDigest, /^[0-9a-f]{64}$/);
    assert.equal(vectorDigest.includes(vectorToken), false);
  });
});
