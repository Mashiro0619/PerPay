import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { describe, it } from "node:test";
import {
  createV3ResponseSignature,
  FakeV3Transport,
  type RawV3Response,
} from "../src/infrastructure/alipay/index.ts";
import { parseProviderKeys, SettingsError } from "../src/settings/index.ts";
import { verifyProviderApplicationKey } from "../src/settings/provider-key-verification.ts";
import {
  applicationPair,
  platformPair,
  platformPem,
  privatePem,
} from "./application-key-fixture.ts";

const clock = () => Date.parse("2026-09-27T08:00:00Z");
const provider = parseProviderKeys({
  environment: "PRODUCTION",
  appId: "verification-test-app",
  privateKey: privatePem,
  publicKey: platformPem,
  timeoutMilliseconds: 120000,
  scanIntervalMilliseconds: 60000,
  activeScanIntervalMilliseconds: 8000,
  safetyLagMilliseconds: 10000,
  maximumSuccessAgeMilliseconds: 120000,
});
const page = { page_no: 1, page_size: 1, total_size: 0, detail_list: [] };
function response(body: unknown = page): RawV3Response {
  const json = JSON.stringify(body);
  return {
    status: 200,
    body: Buffer.from(json),
    headers: {
      "alipay-timestamp": String(clock()),
      "alipay-nonce": "synthetic-response-nonce",
      "alipay-signature": createV3ResponseSignature(
        json,
        String(clock()),
        "synthetic-response-nonce",
        platformPair.privateKey,
      ),
    },
  };
}
const failed = (error: unknown) =>
  error instanceof SettingsError &&
  error.code === "provider_application_key_verification_failed";

describe("read-only application key verification", () => {
  it("uses the candidate key for one signed GET with a bounded window, page size and timeout", async () => {
    const transport = new FakeV3Transport([response()]);
    await verifyProviderApplicationKey(
      provider,
      { requestId: "synthetic-probe" },
      { transport, clock },
    );
    assert.equal(transport.requests.length, 1);
    const request = transport.requests[0]!;
    assert.equal(request.method, "GET");
    assert.equal(request.body, "");
    assert.equal(request.requestId, "synthetic-probe");
    const url = new URL(request.path, provider.endpoint);
    assert.equal(url.pathname, "/v3/alipay/data/bill/accountlog/query");
    assert.equal(url.searchParams.get("start_time"), "2026-09-27 15:58:50");
    assert.equal(url.searchParams.get("end_time"), "2026-09-27 15:59:50");
    assert.equal(url.searchParams.get("page_size"), "1");
    assert.equal(url.searchParams.get("page_no"), "1");
    assert.equal(transport.options[0]!.timeoutMilliseconds, 8000);
    const authorization = String(request.headers.authorization).replace(
      "ALIPAY-SHA256withRSA ",
      "",
    );
    const separator = authorization.lastIndexOf(",sign=");
    const signingText =
      authorization.slice(0, separator) + "\nGET\n" + request.path + "\n\n";
    assert.equal(
      verify(
        "RSA-SHA256",
        Buffer.from(signingText),
        applicationPair.publicKey,
        Buffer.from(authorization.slice(separator + 6), "base64"),
      ),
      true,
    );
  });

  it("does not accept a 2xx response without a verified response signature", async () => {
    const unsigned = response();
    await assert.rejects(
      verifyProviderApplicationKey(
        provider,
        {},
        {
          transport: new FakeV3Transport([{ ...unsigned, headers: {} }]),
          clock,
        },
      ),
      failed,
    );
    await assert.rejects(
      verifyProviderApplicationKey(
        provider,
        {},
        {
          transport: new FakeV3Transport([
            {
              ...unsigned,
              body: Buffer.from(JSON.stringify({ ...page, total_size: 2 })),
            },
          ]),
          clock,
        },
      ),
      failed,
    );
  });

  it("rejects signed business errors, malformed pages, and non-success responses", async () => {
    for (const reply of [
      response({ code: "INVALID_SIGNATURE", message: "do-not-log-this" }),
      response({ ...page, page_size: 2000 }),
      { ...response(), status: 401 },
      { ...response(), status: 403 },
      { ...response(), status: 429 },
      { ...response(), status: 500 },
    ]) {
      await assert.rejects(
        verifyProviderApplicationKey(
          provider,
          {},
          {
            transport: new FakeV3Transport([reply]),
            clock,
          },
        ),
        (error: unknown) => {
          assert.ok(failed(error));
          assert.equal(
            (error as Error).message.includes("do-not-log-this"),
            false,
          );
          return true;
        },
      );
    }
  });

  it("rejects network and cancellation failures without exposing provider payloads", async () => {
    await assert.rejects(
      verifyProviderApplicationKey(
        provider,
        {},
        {
          transport: new FakeV3Transport([
            new Error("sensitive transport body"),
          ]),
          clock,
        },
      ),
      (error: unknown) =>
        failed(error) && !(error as Error).message.includes("sensitive"),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      verifyProviderApplicationKey(
        provider,
        { signal: controller.signal },
        {
          transport: new FakeV3Transport([response()]),
          clock,
        },
      ),
      failed,
    );
  });
});
