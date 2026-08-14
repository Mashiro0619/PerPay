import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  API_SIGNATURE_VERSION,
  ApiSignatureError,
  canonicalizeApiRequestTarget,
  createApiRequestNonce,
  signApiRequest,
  verifyApiRequestSignature,
  type ApiRequestAuthentication,
  type ApiSignatureErrorCode,
} from "../src/security/api-signature.ts";

const secret = Buffer.from("6be74796a45948e654921cb70b7a8db38ab78cf7c1d5cb206a8e6a3a50427c8d", "hex");
const now = new Date("2026-08-14T12:00:00.000Z");
const timestamp = String(Math.floor(now.getTime() / 1000));
const nonce = Buffer.alloc(32, 0xa5).toString("base64url");
const body = Buffer.from('{"amount":"10.00","note":"\u6536\u6b3e\\u0000"}', "utf8");
const target = "/v1/orders/%E6%94%B6%E6%AC%BE?order_id=A-1&note=%E6%B5%8B%E8%AF%95";

function authentication(
  overrides: Partial<Omit<ApiRequestAuthentication, "version">> & { version?: string } = {},
): ApiRequestAuthentication {
  return {
    ...signApiRequest({
      secret,
      method: "post",
      target,
      body,
      clientId: "client_test_01",
      timestamp,
      nonce,
    }),
    ...overrides,
  };
}

function expectApiError(action: () => unknown, code: ApiSignatureErrorCode): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof ApiSignatureError && error.code === code,
  );
}

describe("API request signatures", () => {
  it("signs and verifies all canonical request material", () => {
    const signed = authentication();
    const verified = verifyApiRequestSignature({
      secret,
      method: "POST",
      target,
      body,
      authentication: signed,
      now,
    });

    assert.equal(signed.version, API_SIGNATURE_VERSION);
    assert.match(signed.signature, /^[0-9a-f]{64}$/);
    assert.deepEqual(verified, {
      version: "v1",
      clientId: "client_test_01",
      timestamp: Number(timestamp),
      nonce,
      method: "POST",
      canonicalTarget:
        "/v1/orders/%E6%94%B6%E6%AC%BE?note=%E6%B5%8B%E8%AF%95&order_id=A-1",
      bodySha256: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("matches the fixed v1 signature vector", () => {
    const signed = authentication();

    assert.equal(signed.signature, "8a71e37ddfaa23364e2610478b15ead1b4de71a43293c31a270b6e001594cbc2");
  });

  it("rejects changes to the body, path, query, method, or client ID", () => {
    const signed = authentication();
    const cases = [
      { body: Buffer.concat([body, Buffer.from([0])]) },
      { target: target.replace("/orders/", "/payments/") },
      { target: target.replace("order_id=A-1", "order_id=A-2") },
      { method: "PUT" },
      { authentication: { ...signed, clientId: "client_test_02" } },
    ];

    for (const changed of cases) {
      expectApiError(
        () =>
          verifyApiRequestSignature({
            secret,
            method: "POST",
            target,
            body,
            authentication: signed,
            now,
            ...changed,
          }),
        "INVALID_SIGNATURE",
      );
    }
  });

  it("binds the timestamp and nonce into the MAC", () => {
    const signed = authentication();
    const changedTimestamp = String(Number(timestamp) + 1);
    const changedNonce = Buffer.alloc(32, 0xa6).toString("base64url");

    for (const changed of [
      { ...signed, timestamp: changedTimestamp },
      { ...signed, nonce: changedNonce },
    ]) {
      expectApiError(
        () =>
          verifyApiRequestSignature({
            secret,
            method: "POST",
            target,
            body,
            authentication: changed,
            now,
          }),
        "INVALID_SIGNATURE",
      );
    }
  });

  it("rejects the wrong secret and secrets shorter than 256 bits", () => {
    const signed = authentication();
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret: Buffer.alloc(32, 0xff),
          method: "POST",
          target,
          body,
          authentication: signed,
          now,
        }),
      "INVALID_SIGNATURE",
    );
    expectApiError(
      () =>
        signApiRequest({
          secret: Buffer.alloc(31),
          method: "POST",
          target,
          body,
          clientId: "client_test_01",
          timestamp,
          nonce,
        }),
      "INVALID_SECRET",
    );
    assert.doesNotThrow(() =>
      signApiRequest({
        secret: Buffer.alloc(32),
        method: "POST",
        target,
        body: Buffer.alloc(0),
        clientId: "client_test_01",
        timestamp,
        nonce,
      }),
    );
  });

  it("hashes exact binary body bytes", () => {
    const binaryBody = Buffer.from([0x00, 0xff, 0xc3, 0x28]);
    const signed = signApiRequest({
      secret,
      method: "POST",
      target: "/v1/orders",
      body: binaryBody,
      clientId: "client_test_01",
      timestamp,
      nonce,
    });
    const verified = verifyApiRequestSignature({
      secret,
      method: "POST",
      target: "/v1/orders",
      body: binaryBody,
      authentication: signed,
      now,
    });

    assert.equal(verified.bodySha256, createHash("sha256").update(binaryBody).digest("hex"));
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target: "/v1/orders",
          body: Buffer.from([0x00, 0xff, 0xef, 0xbf, 0xbd, 0x28]),
          authentication: signed,
          now,
        }),
      "INVALID_SIGNATURE",
    );
  });

  it("requires canonical lowercase hexadecimal signatures and base64url nonces", () => {
    const signed = authentication();
    for (const invalidSignature of [signed.signature.toUpperCase(), `${signed.signature}=`, "A".repeat(64)]) {
      expectApiError(
        () =>
          verifyApiRequestSignature({
            secret,
            method: "POST",
            target,
            body,
            authentication: { ...signed, signature: invalidSignature },
            now,
          }),
        "INVALID_SIGNATURE",
      );
    }

    for (const invalidNonce of ["short", `${nonce}=`, `${nonce.slice(0, -1)}B`]) {
      expectApiError(
        () =>
          signApiRequest({
            secret,
            method: "POST",
            target,
            body,
            clientId: "client_test_01",
            timestamp,
            nonce: invalidNonce,
          }),
        "INVALID_NONCE",
      );
    }
    assert.match(createApiRequestNonce(), /^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects stale and future requests outside the default five-minute window", () => {
    for (const offsetSeconds of [-301, 301]) {
      const changedTimestamp = String(Number(timestamp) + offsetSeconds);
      const signed = signApiRequest({
        secret,
        method: "POST",
        target,
        body,
        clientId: "client_test_01",
        timestamp: changedTimestamp,
        nonce,
      });
      expectApiError(
        () =>
          verifyApiRequestSignature({
            secret,
            method: "POST",
            target,
            body,
            authentication: signed,
            now,
          }),
        "TIMESTAMP_OUT_OF_RANGE",
      );
    }
  });

  it("accepts timestamps exactly five minutes from the verification clock", () => {
    for (const offsetSeconds of [-300, 300]) {
      const signed = signApiRequest({
        secret,
        method: "POST",
        target,
        body,
        clientId: "client_test_01",
        timestamp: String(Number(timestamp) + offsetSeconds),
        nonce,
      });
      assert.doesNotThrow(() =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target,
          body,
          authentication: signed,
          now,
        }),
      );
    }
  });

  it("allows a stricter window but never one wider than five minutes", () => {
    const sixtyOneSecondsOld = signApiRequest({
      secret,
      method: "POST",
      target,
      body,
      clientId: "client_test_01",
      timestamp: String(Number(timestamp) - 61),
      nonce,
    });
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target,
          body,
          authentication: sixtyOneSecondsOld,
          now,
          maxClockSkewSeconds: 60,
        }),
      "TIMESTAMP_OUT_OF_RANGE",
    );
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target,
          body,
          authentication: authentication(),
          now,
          maxClockSkewSeconds: 301,
        }),
      "INVALID_VERIFICATION_CLOCK",
    );
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target,
          body,
          authentication: authentication(),
          now: new Date(Number.NaN),
        }),
      "INVALID_VERIFICATION_CLOCK",
    );
  });

  it("rejects non-canonical timestamps and unsupported signature versions", () => {
    expectApiError(
      () =>
        signApiRequest({
          secret,
          method: "POST",
          target,
          body,
          clientId: "client_test_01",
          timestamp: `0${timestamp}`,
          nonce,
        }),
      "INVALID_TIMESTAMP",
    );
    expectApiError(
      () =>
        verifyApiRequestSignature({
          secret,
          method: "POST",
          target,
          body,
          authentication: authentication({ version: "v2" }),
          now,
        }),
      "UNSUPPORTED_VERSION",
    );
  });

  it("rejects duplicate query names, including equivalent percent encodings", () => {
    for (const ambiguousTarget of ["/v1/orders?a=1&a=2", "/v1/orders?a=1&%61=2"]) {
      expectApiError(() => canonicalizeApiRequestTarget(ambiguousTarget), "INVALID_TARGET");
    }
  });

  it("normalizes safe percent encodings and query order deterministically", () => {
    const first = canonicalizeApiRequestTarget(
      "/v1/%e6%94%b6%e6%ac%be?z=%7e&name=%e6%b5%8b%e8%af%95",
    );
    const second = canonicalizeApiRequestTarget(
      "/v1/%E6%94%B6%E6%AC%BE?name=%E6%B5%8B%E8%AF%95&z=~",
    );

    assert.equal(first, second);
    assert.equal(first, "/v1/%E6%94%B6%E6%AC%BE?name=%E6%B5%8B%E8%AF%95&z=~");
  });

  it("rejects raw Unicode, malformed UTF-8, encoded separators, and non-NFC text", () => {
    const invalidTargets = [
      "/v1/\u6536\u6b3e",
      "/v1/%E6%94",
      "/v1/a%2Fb",
      "/v1/orders?name=e%CC%81",
      "/v1/orders?name=a+b",
      "/v1/../orders",
    ];
    for (const invalidTarget of invalidTargets) {
      expectApiError(() => canonicalizeApiRequestTarget(invalidTarget), "INVALID_TARGET");
    }
  });

  it("does not merge percent-encoded path reserved characters with literal forms", () => {
    const reservedCharacters = "!$&'()*+,;=:@";
    for (const character of reservedCharacters) {
      const encoded = `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
      expectApiError(
        () => canonicalizeApiRequestTarget(`/v1/a${encoded}b`),
        "INVALID_TARGET",
      );
      assert.equal(canonicalizeApiRequestTarget(`/v1/a${character}b`), `/v1/a${character}b`);
    }
  });
});
