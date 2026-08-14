import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, it } from "node:test";

import {
  AlipayLedgerProvider,
  AlipayProviderError,
  FakeLedgerProvider,
  FakeV3Transport,
  NodeV3Transport,
  classifyHttpResponse,
  isPublicAddress,
  normalizeV3Headers,
  signV3Request,
  verifyV3Response,
  type AccountLogPage,
  type RawV3Response,
} from "../src/infrastructure/alipay/index.ts";

const {
  privateKey: applicationPrivateKey,
  publicKey: applicationPublicKey,
} = generateKeyPairSync("rsa", { modulusLength: 2048 });
const {
  privateKey: platformPrivateKey,
  publicKey: platformPublicKey,
} = generateKeyPairSync("rsa", { modulusLength: 2048 });
const applicationPrivateKeyPem = applicationPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
const platformPublicKeyPem = platformPublicKey.export({ type: "spki", format: "pem" }).toString();
const startTime = "2026-08-14 00:00:00";
const endTime = "2026-08-14 23:59:59";

describe("V3 signing boundary", () => {
  it("signs a deterministic path/query/body and exposes the exact transport request", () => {
    const request = signV3Request(
      {
        method: "GET",
        path: "/v3/example",
        query: { z: "last", a: "first value" },
        requestId: "request-1",
      },
      {
        appId: "2026000000000000",
        privateKey: applicationPrivateKeyPem,
        clock: () => 1_700_000_000_000,
        nonceFactory: () => "nonce-fixed",
      },
    );

    assert.equal(request.path, "/v3/example?a=first%20value&z=last");
    assert.equal(request.body, "");
    assert.equal(request.requestId, "request-1");
    const authorization = request.headers.authorization;
    assert.equal(typeof authorization, "string");
    if (typeof authorization !== "string") throw new Error("authorization header is not a string");
    assert.match(authorization, /^ALIPAY-SHA256withRSA /);
    const [, auth] = authorization.split(" ", 2);
    assert.ok(auth);
    const [authString, signPart] = auth.split(",sign=", 2);
    assert.equal(authString, "app_id=2026000000000000,nonce=nonce-fixed,timestamp=1700000000000");
    assert.ok(signPart);
    const signContent = `${authString}\nGET\n${request.path}\n\n`;
    assert.equal(
      verify("RSA-SHA256", Buffer.from(signContent), applicationPublicKey, Buffer.from(signPart, "base64")),
      true,
    );
  });

  it("rejects unsafe path and request values before any network call", () => {
    assert.throws(
      () => signV3Request(
        { method: "GET", path: "/v3/example#fragment" },
        { appId: "app", privateKey: applicationPrivateKeyPem },
      ),
      (error: unknown) => error instanceof AlipayProviderError && error.code === "request_signing_failed",
    );
  });

  it("rejects non-RSA and weak RSA signing keys", () => {
    const ecPrivateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const weakPrivateKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    for (const invalidKey of [ecPrivateKey, weakPrivateKey]) {
      assert.throws(
        () => signV3Request(
          { method: "GET", path: "/v3/example" },
          { appId: "app", privateKey: invalidKey },
        ),
        (error: unknown) =>
          error instanceof AlipayProviderError && error.code === "request_signing_failed",
      );
    }
  });
});

describe("Node V3 transport boundary", () => {
  it("accepts only official HTTPS gateway origins on the default port", () => {
    assert.doesNotThrow(() => new NodeV3Transport());
    assert.doesNotThrow(() => new NodeV3Transport({
      endpoint: "https://openapi-sandbox.dl.alipaydev.com",
    }));
    for (const endpoint of [
      "http://openapi.alipay.com",
      "https://openapi.alipay.com:444",
      "https://openapi.alipay.com/path",
      "https://user@openapi.alipay.com",
      "https://example.com",
    ]) {
      assert.throws(
        () => new NodeV3Transport({ endpoint }),
        (error: unknown) =>
          error instanceof AlipayProviderError && error.code === "configuration_invalid",
      );
    }
  });

  it("rejects special-use IPv4 and IPv6 results before a socket is opened", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
    ]) {
      assert.equal(isPublicAddress(address, 4), false, address);
    }
    assert.equal(isPublicAddress("8.8.8.8", 4), true);
    for (const address of [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "100::1",
      "2001:db8::1",
      "2002::1",
      "3fff::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
    ]) {
      assert.equal(isPublicAddress(address, 6), false, address);
    }
    assert.equal(isPublicAddress("2606:4700:4700::1111", 6), true);
    assert.equal(isPublicAddress("::ffff:8.8.8.8", 6), false);
    assert.equal(isPublicAddress("8.8.8.8", 6), false);
  });

  it("validates timeout, path, and an already-aborted request before DNS", async () => {
    const transport = new NodeV3Transport();
    const request = {
      method: "GET" as const,
      path: "/v3/example",
      body: "",
      headers: {},
      requestId: "transport-test",
    };
    await assert.rejects(
      transport.request(request, { timeoutMilliseconds: 0 }),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    await assert.rejects(
      transport.request({ ...request, path: "/v3/example\r\nunsafe" }, { timeoutMilliseconds: 1_000 }),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    await assert.rejects(
      transport.request({
        ...request,
        headers: { Authorization: "one", authorization: "two" },
      }, { timeoutMilliseconds: 1_000 }),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    await assert.rejects(
      transport.request({
        ...request,
        headers: { "transfer-encoding": "chunked" },
      }, { timeoutMilliseconds: 1_000 }),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      transport.request(request, { timeoutMilliseconds: 1_000, signal: controller.signal }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  });

  it("deeply freezes normalized headers and preserves duplicate values for rejection", () => {
    const headers = normalizeV3Headers({
      "Alipay-Timestamp": ["one", "two"],
      "X-Trace": "trace",
    });
    assert.deepEqual(headers["alipay-timestamp"], ["one", "two"]);
    assert.equal(Object.isFrozen(headers), true);
    assert.equal(Object.isFrozen(headers["alipay-timestamp"]), true);
    assert.throws(
      () => normalizeV3Headers({ Authorization: "one", authorization: "two" }),
      TypeError,
    );
  });
});

describe("V3 response verification", () => {
  it("verifies the raw body before parsing and preserves whitespace exactly", () => {
    const body = '{"page_no":1, "detail_list":[]}\n';
    const timestamp = "1700000000123";
    const nonce = "response-nonce";
    const response: RawV3Response = {
      status: 200,
      headers: {
        "alipay-timestamp": timestamp,
        "alipay-nonce": nonce,
        "alipay-signature": responseSignature(body, timestamp, nonce),
        "alipay-trace-id": "trace-1",
      },
      body: Buffer.from(body, "utf8"),
    };
    const verified = verifyV3Response(response, platformPublicKeyPem, { requestId: "request-1" });
    assert.equal(verified.body, body);
    assert.equal(verified.bodyBytes.toString("utf8"), body);
    assert.equal(verified.traceId, "trace-1");
    assert.equal(verified.signatureVerified, true);
  });

  it("rejects a response forged with the application signing key", () => {
    const body = "{}";
    const timestamp = "1700000000123";
    const nonce = "wrong-key-role";
    const response: RawV3Response = {
      status: 200,
      headers: {
        "alipay-timestamp": timestamp,
        "alipay-nonce": nonce,
        "alipay-signature": responseSignature(body, timestamp, nonce, applicationPrivateKey),
      },
      body: Buffer.from(body, "utf8"),
    };

    assert.throws(
      () => verifyV3Response(response, platformPublicKeyPem),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "response_signature_invalid",
    );
  });

  it("classifies missing, mismatched, and invalid signatures distinctly", () => {
    const body = "{}";
    const timestamp = "1700000000123";
    const nonce = "response-nonce";
    const signature = responseSignature(body, timestamp, nonce);
    const base: RawV3Response = {
      status: 200,
      headers: {
        "alipay-timestamp": timestamp,
        "alipay-nonce": nonce,
        "alipay-signature": signature,
      },
      body: Buffer.from(body, "utf8"),
    };
    assert.throws(
      () => verifyV3Response({ ...base, headers: {} }, platformPublicKeyPem),
      (error: unknown) => error instanceof AlipayProviderError && error.code === "response_signature_missing",
    );
    assert.throws(
      () => verifyV3Response(base, platformPublicKeyPem, { expectedAlipayCertSn: "expected-sn" }),
      (error: unknown) => error instanceof AlipayProviderError && error.code === "response_certificate_mismatch",
    );
    assert.throws(
      () => verifyV3Response(
        { ...base, body: Buffer.from('{"tampered":true}', "utf8") },
        platformPublicKeyPem,
      ),
      (error: unknown) => error instanceof AlipayProviderError && error.code === "response_signature_invalid",
    );
  });

  it("rejects incompatible verification keys and freezes copied response headers", () => {
    const body = Buffer.from("{}", "utf8");
    const timestamp = "1700000000123";
    const nonce = "response-nonce";
    const mutableHeaders: Record<string, string> = {
      "alipay-timestamp": timestamp,
      "alipay-nonce": nonce,
      "alipay-signature": responseSignature(body, timestamp, nonce),
      "alipay-trace-id": "trace-original",
    };
    const response: RawV3Response = { status: 200, headers: mutableHeaders, body };
    const verified = verifyV3Response(response, platformPublicKeyPem);
    mutableHeaders["alipay-trace-id"] = "trace-mutated";
    assert.equal(verified.traceId, "trace-original");
    assert.equal(verified.headers["alipay-trace-id"], "trace-original");
    assert.equal(Object.isFrozen(verified.headers), true);

    const ecPublicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
    assert.throws(
      () => verifyV3Response(response, ecPublicKey),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
    const weakPublicKey = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    assert.throws(
      () => verifyV3Response(response, weakPublicKey),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "configuration_invalid",
    );
  });

  it("classifies malformed exported boundaries and preserves invalid UTF-8 error bytes", () => {
    assert.throws(
      () => verifyV3Response({
        status: 200,
        headers: null,
        body: Buffer.from("{}", "utf8"),
      } as unknown as RawV3Response, platformPublicKeyPem),
      (error: unknown) =>
        error instanceof AlipayProviderError && error.code === "response_invalid_shape",
    );
    const bytes = Buffer.from([0xff, 0x00, 0x61]);
    const classified = classifyHttpResponse({ status: 403, headers: {}, body: bytes }, "trace-bytes");
    assert.ok(classified.rawBody instanceof Uint8Array);
    assert.deepEqual(Array.from(classified.rawBody), Array.from(bytes));
  });
});

describe("Alipay ledger provider", () => {
  it("queries an account-log page, verifies it, and retains raw response evidence", async () => {
    const body = JSON.stringify({
      page_no: 1,
      page_size: 2,
      total_size: 1,
      detail_list: [
        {
          account_log_id: "log-1",
          trans_dt: "2026-08-14 12:00:00",
          trans_amount: "1.23",
          direction: "income",
          alipay_order_no: "trade-1",
          trans_memo: "memo",
          other_account: "buyer@example",
          unknown_future_field: { preserved: true },
        },
      ],
    });
    const transport = new FakeV3Transport([
      signedResponse(body, "trace-page-1"),
    ]);
    const provider = new AlipayLedgerProvider({
      appId: "2026000000000000",
      privateKey: applicationPrivateKeyPem,
      alipayPublicKey: platformPublicKeyPem,
      transport,
      timeoutMilliseconds: 1234,
      pageSize: 2,
      clock: () => 1_700_000_000_000,
      nonceFactory: () => "request-nonce",
    });
    const page = await provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 2, requestId: "request-1" });
    assert.equal(page.pageNo, 1);
    assert.equal(page.totalSize, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.traceId, "trace-page-1");
    assert.equal(page.rawResponse.body, body);
    assert.equal(page.rawResponse.signatureVerified, true);
    assert.equal(page.details[0]?.accountLogId, "log-1");
    assert.equal(page.details[0]?.amount, "1.23");
    assert.deepEqual((page.details[0]?.raw as Record<string, unknown>).unknown_future_field, { preserved: true });
    assert.equal(transport.requests[0]?.path, `/v3/alipay/data/bill/accountlog/query?end_time=${encodeURIComponent(endTime)}&page_no=1&page_size=2&start_time=${encodeURIComponent(startTime)}`);
    assert.equal(transport.options[0]?.timeoutMilliseconds, 1234);
  });

  it("maps permission, authentication, rate-limit, server, and timeout failures", async () => {
    for (const [status, kind, code] of [
      [401, "authentication", "remote_authentication_failed"],
      [403, "authorization", "remote_authorization_failed"],
      [429, "rate_limited", "remote_rate_limited"],
      [500, "transient", "remote_server_error"],
    ] as const) {
      const transport = new FakeV3Transport([{
        status,
        headers: { "alipay-trace-id": `trace-${status}` },
        body: Buffer.from("{}", "utf8"),
      }]);
      const provider = makeProvider(transport);
      await assert.rejects(
        provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
        (error: unknown) => error instanceof AlipayProviderError && error.kind === kind && error.code === code,
      );
    }
    const timeout = Object.assign(new Error("deadline"), { name: "TimeoutError" });
    const provider = makeProvider(new FakeV3Transport([timeout]));
    await assert.rejects(
      provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
      (error: unknown) => error instanceof AlipayProviderError && error.kind === "timeout" && error.code === "transport_timeout",
    );

    const cancelled = new Error("cancelled");
    cancelled.name = "AbortError";
    const cancelledProvider = makeProvider(new FakeV3Transport([cancelled]));
    await assert.rejects(
      cancelledProvider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
      (error: unknown) =>
        error instanceof AlipayProviderError &&
        error.kind === "cancelled" &&
        error.code === "transport_cancelled" &&
        error.retryable === false,
    );
  });

  it("reports an oversized window without following unstable numbered pages", async () => {
    const first = JSON.stringify({ page_no: 1, page_size: 2, total_size: 3, detail_list: [{ account_log_id: "one" }, { account_log_id: "two" }] });
    const transport = new FakeV3Transport([signedResponse(first, "trace-1")]);
    const page = await makeProvider(transport).queryPage({ startTime, endTime, pageNo: 1, pageSize: 2 });
    assert.equal(page.hasMore, true);
    assert.equal(page.totalSize, 3);
    assert.deepEqual(page.details.map((item) => item.accountLogId), ["one", "two"]);
    assert.equal(transport.requests.length, 1);
  });

  it("rejects an empty page before the declared end", async () => {
    const empty = new FakeV3Transport([
      signedResponse(JSON.stringify({ page_no: 1, page_size: 1, total_size: 2, detail_list: [] }), "trace-empty"),
    ]);
    await assert.rejects(
      makeProvider(empty).queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
      (error: unknown) => error instanceof AlipayProviderError && error.code === "pagination_invalid" && error.retryable,
    );
  });

  it("accepts the provider's omitted detail list for a zero-result page", async () => {
    const body = JSON.stringify({ page_no: "0", page_size: "2", total_size: "0" });
    const page = await makeProvider(
      new FakeV3Transport([signedResponse(body, "trace-zero-result")]),
    ).queryPage({ startTime, endTime, pageNo: 1, pageSize: 2 });

    assert.equal(page.totalSize, 0);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.details, []);
    assert.equal(page.rawResponse.body, body);
    assert.equal(page.rawResponse.signatureVerified, true);
  });

  it("accepts one camel-case representation of page and detail fields", async () => {
    const body = JSON.stringify({
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      detailList: [{
        accountLogId: "camel-log",
        transDt: "2026-08-14 12:00:00",
        transAmount: "2.34",
        alipayOrderNo: "camel-provider-order",
        merchantOrderNo: "camel-merchant-order",
        transMemo: "camel-memo",
        otherAccount: "camel-account",
      }],
    });
    const page = await makeProvider(
      new FakeV3Transport([signedResponse(body, "trace-camel-fields")]),
    ).queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 });

    assert.equal(page.details[0]?.accountLogId, "camel-log");
    assert.equal(page.details[0]?.amount, "2.34");
    assert.equal(page.details[0]?.merchantOrderNo, "camel-merchant-order");
  });

  it("rejects dual representations of every page field", async () => {
    const conflictingPages: readonly Record<string, unknown>[] = [
      { page_no: 1, pageNo: 1, page_size: 1, total_size: 0, detail_list: [] },
      { page_no: 1, page_size: 1, pageSize: 1, total_size: 0, detail_list: [] },
      { page_no: 1, page_size: 1, total_size: 0, totalSize: 0, detail_list: [] },
      { page_no: 1, page_size: 1, total_size: 0, detail_list: [], detailList: [] },
    ];

    for (const [index, payload] of conflictingPages.entries()) {
      const provider = makeProvider(new FakeV3Transport([
        signedResponse(JSON.stringify(payload), `trace-page-alias-${index}`),
      ]));
      await assert.rejects(
        provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
        (error: unknown) =>
          error instanceof AlipayProviderError &&
          error.code === "response_invalid_shape" &&
          error.signatureVerified === true,
      );
    }
  });

  it("rejects dual representations of every normalized detail field", async () => {
    const conflictingFields: readonly (readonly [string, string, unknown])[] = [
      ["account_log_id", "accountLogId", "same-log"],
      ["trans_dt", "transDt", "2026-08-14 12:00:00"],
      ["trans_amount", "transAmount", "1.00"],
      ["alipay_order_no", "alipayOrderNo", "same-provider-order"],
      ["merchant_order_no", "merchantOrderNo", "same-merchant-order"],
      ["out_biz_no", "outBizNo", "same-out-biz-order"],
      ["merchant_order_no", "out_biz_no", "same-merchant-alias"],
      ["merchantOrderNo", "outBizNo", "same-camel-merchant-alias"],
      ["trans_memo", "transMemo", "same-memo"],
      ["other_account", "otherAccount", "same-account"],
    ];

    for (const [index, [first, second, fieldValue]] of conflictingFields.entries()) {
      const detail: Record<string, unknown> = { account_log_id: `log-${index}` };
      detail[first] = fieldValue;
      detail[second] = fieldValue;
      const body = JSON.stringify({
        page_no: 1,
        page_size: 1,
        total_size: 1,
        detail_list: [detail],
      });
      const provider = makeProvider(new FakeV3Transport([
        signedResponse(body, `trace-detail-alias-${index}`),
      ]));
      await assert.rejects(
        provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
        (error: unknown) =>
          error instanceof AlipayProviderError &&
          error.code === "response_invalid_shape" &&
          error.signatureVerified === true,
      );
    }
  });

  it("does not coerce a JSON number into a transaction amount", async () => {
    const body =
      '{"page_no":1,"page_size":1,"total_size":1,"detail_list":' +
      '[{"account_log_id":"numeric-amount","trans_amount":0.10000000000000001}]}';
    const page = await makeProvider(
      new FakeV3Transport([signedResponse(body, "trace-numeric-amount")]),
    ).queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 });

    assert.equal(page.details[0]?.amount, null);
    assert.equal(page.rawResponse.body, body);
  });

  it("does not accept a zero page number outside the exact empty first-page response", async () => {
    for (const body of [
      JSON.stringify({ page_no: 0, page_size: 2, total_size: 1, detail_list: [] }),
      JSON.stringify({ page_no: 0, page_size: 2, total_size: 0, detail_list: [{}] }),
    ]) {
      await assert.rejects(
        makeProvider(
          new FakeV3Transport([signedResponse(body, "trace-invalid-zero-page")]),
        ).queryPage({ startTime, endTime, pageNo: 1, pageSize: 2 }),
        (error: unknown) =>
          error instanceof AlipayProviderError &&
          (error.code === "response_invalid_shape" || error.code === "pagination_invalid"),
      );
    }
  });

  it("rejects signed but malformed JSON and preserves it for isolation", async () => {
    const malformed = '{"page_no":1,"page_no":2}';
    const provider = makeProvider(new FakeV3Transport([signedResponse(malformed, "trace-malformed")]));
    await assert.rejects(
      provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
      (error: unknown) =>
        error instanceof AlipayProviderError &&
        error.code === "response_invalid_json" &&
        error.traceId === "trace-malformed" &&
        error.rawBody === malformed &&
        !JSON.stringify(error).includes("page_no"),
    );
  });

  it("rejects malformed transport headers and unsafe numeric identifiers", async () => {
    const malformedHeaders = signedResponse(
      JSON.stringify({ page_no: 1, page_size: 1, total_size: 0, detail_list: [] }),
      "trace-bad-headers",
    );
    const provider = makeProvider(new FakeV3Transport([{
      ...malformedHeaders,
      headers: null,
    } as unknown as RawV3Response]));
    await assert.rejects(
      provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 }),
      (error: unknown) =>
        error instanceof AlipayProviderError &&
        error.code === "response_invalid_shape" &&
        error.status === 200 &&
        error.rawBody instanceof Uint8Array &&
        Buffer.compare(Buffer.from(error.rawBody), Buffer.from(malformedHeaders.body)) === 0 &&
        error.responseHeaders === null &&
        error.signatureVerified === null,
    );

    const unsafeIdentifier = JSON.stringify({
      page_no: 1,
      page_size: 1,
      total_size: 1,
      detail_list: [{ account_log_id: 9_007_199_254_740_992 }],
    });
    const unsafePage = await makeProvider(
      new FakeV3Transport([signedResponse(unsafeIdentifier, "trace-unsafe-id")]),
    ).queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 });
    assert.equal(unsafePage.details[0]?.accountLogId, null);
  });

});

describe("fake ledger provider", () => {
  it("returns a configured page without any network dependency", async () => {
    const page = fakePage(1, 1, 1, "fake-log");
    const provider = new FakeLedgerProvider([{ startTime, endTime, pageNo: 1, page }]);
    const result = await provider.queryPage({ startTime, endTime, pageNo: 1, pageSize: 1 });
    assert.equal(provider.calls.length, 1);
    assert.equal(result.details[0]?.accountLogId, "fake-log");
  });
});

function makeProvider(transport: FakeV3Transport): AlipayLedgerProvider {
  return new AlipayLedgerProvider({
    appId: "2026000000000000",
    privateKey: applicationPrivateKeyPem,
    alipayPublicKey: platformPublicKeyPem,
    transport,
    pageSize: 2,
    clock: () => 1_700_000_000_000,
    nonceFactory: () => "request-nonce",
  });
}

function responseSignature(
  body: string | Uint8Array,
  timestamp: string,
  nonce: string,
  signingKey = platformPrivateKey,
): string {
  const bodyText = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const signingString = `${timestamp}\n${nonce}\n${bodyText}\n`;
  return sign("RSA-SHA256", Buffer.from(signingString, "utf8"), signingKey).toString("base64");
}

function signedResponse(body: string, traceId: string): RawV3Response {
  const timestamp = "1700000000123";
  const nonce = `nonce-${traceId}`;
  return {
    status: 200,
    headers: {
      "alipay-timestamp": timestamp,
      "alipay-nonce": nonce,
      "alipay-signature": responseSignature(body, timestamp, nonce),
      "alipay-trace-id": traceId,
    },
    body: Buffer.from(body, "utf8"),
  };
}

function fakePage(pageNo: number, pageSize: number, totalSize: number, accountLogId: string): AccountLogPage {
  return {
    pageNo,
    pageSize,
    totalSize,
    details: [{
      raw: { account_log_id: accountLogId },
      accountLogId,
      occurredAt: null,
      amount: null,
      direction: null,
      alipayOrderNo: null,
      merchantOrderNo: null,
      transMemo: null,
      otherAccount: null,
    }],
    hasMore: false,
    traceId: "fake-trace",
    rawResponse: {
      status: 200,
      headers: {},
      body: JSON.stringify({ page_no: pageNo, page_size: pageSize, total_size: totalSize }),
      traceId: "fake-trace",
      signatureVerified: true,
    },
  };
}
