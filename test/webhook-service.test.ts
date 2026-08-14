import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import type { WebhookRuntimeConfig } from "../src/config.ts";
import type { WebhookDelivery } from "../src/notifications/model.ts";
import {
  WebhookDeliveryService,
  type WebhookDeliveryStore,
} from "../src/notifications/service.ts";
import {
  WebhookTransportError,
  type WebhookTransport,
  type WebhookTransportResponse,
} from "../src/notifications/transport.ts";
import type {
  ClaimedWebhookAttempt,
  CompleteWebhookAttemptInput,
} from "../src/notifications/store.ts";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";
const KEY_ID = "66666666-6666-4666-8666-666666666666";
const ORDER_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_EVENT_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_DELIVERY_ID = "99999999-9999-4999-8999-999999999999";
const REQUEST_TIMESTAMP = 2_000_000_000_000;
const PAYLOAD_JSON = JSON.stringify({
  schema: "perpay:event:v1",
  event_id: EVENT_ID,
  event_type: "payment.succeeded",
  order_id: ORDER_ID,
});
const WEBHOOK_SECRET = Buffer.alloc(32, 0x5a).toString("base64url");

const config: Extract<WebhookRuntimeConfig, { readonly enabled: true }> = Object.freeze({
  enabled: true,
  allowedOrigin: "https://hooks.example.test",
  allowedOriginFingerprint: "a".repeat(64),
  secret: WEBHOOK_SECRET,
  signingKeyFingerprint: "b".repeat(64),
  timeoutMilliseconds: 5_000,
  maximumAttempts: 5,
  retryBaseMilliseconds: 1_000,
  retryMaximumMilliseconds: 60_000,
});

describe("WebhookDeliveryService", () => {
  it("materializes and claims work before reporting an empty queue", async () => {
    const store = new FakeWebhookStore(null);
    const transport = rejectingUnexpectedTransport();
    const service = new WebhookDeliveryService({
      store,
      transport,
      config,
      clock: sequenceClock(3_000, 3_001),
      leaseMilliseconds: 7_000,
    });

    assert.deepEqual(await service.processOne(), {
      processed: false,
      deliveryId: null,
      status: null,
      outcome: null,
      errorCode: null,
    });
    assert.deepEqual(store.materializeCalls, [{ limit: 64, now: 3_000 }]);
    assert.deepEqual(store.claimCalls, [{
      now: 3_001,
      leaseMilliseconds: 7_000,
      maximumAttempts: 5,
    }]);
    assert.deepEqual(store.completions, []);
  });

  it("sends the canonical signed request and persists complete ACK evidence", async () => {
    const claimed = claimedAttempt();
    const store = new FakeWebhookStore(claimed);
    let request: Parameters<WebhookTransport["post"]>[0] | null = null;
    const transport: WebhookTransport = {
      async post(input) {
        request = input;
        return response({ body: ackBody() });
      },
    };
    const service = new WebhookDeliveryService({
      store,
      transport,
      config,
      clock: sequenceClock(4_000, 4_001, 4_002),
      leaseMilliseconds: 9_000,
    });
    const abortController = new AbortController();

    assert.deepEqual(await service.processOne(abortController.signal), {
      processed: true,
      deliveryId: DELIVERY_ID,
      status: "ACKNOWLEDGED",
      outcome: "ACKNOWLEDGED",
      errorCode: null,
    });
    assert.ok(request !== null);
    const sent = request as Parameters<WebhookTransport["post"]>[0];
    assert.equal(sent.targetUrl, "https://hooks.example.test/receive?tenant=personal");
    assert.equal(sent.body.toString("utf8"), PAYLOAD_JSON);
    assert.equal(sent.timeoutMilliseconds, 5_000);
    assert.equal(sent.signal, abortController.signal);
    assert.deepEqual(sent.headers, {
      "x-perpay-webhook-version": "1",
      "x-perpay-webhook-key-id": KEY_ID,
      "x-perpay-webhook-timestamp": String(REQUEST_TIMESTAMP),
      "x-perpay-webhook-delivery-id": DELIVERY_ID,
      "x-perpay-webhook-event-id": EVENT_ID,
      "x-perpay-webhook-attempt": "1",
      "x-perpay-webhook-signature": expectedSignature(Buffer.from(PAYLOAD_JSON, "utf8")),
    });
    assert.deepEqual(store.completions, [{
      deliveryId: DELIVERY_ID,
      attemptId: ATTEMPT_ID,
      leaseToken: LEASE_TOKEN,
      outcome: "ACKNOWLEDGED",
      now: 4_002,
      maximumAttempts: 5,
      retryBaseMilliseconds: 1_000,
      retryMaximumMilliseconds: 60_000,
      resolvedAddressesFingerprint: "c".repeat(64),
      connectedAddress: "8.8.8.8",
      httpStatus: 200,
      responseBytes: ackBody().byteLength,
      responseFingerprint: "d".repeat(64),
      ackCode: "acknowledged",
      errorCode: null,
    }]);
  });

  it("classifies strict ACK and HTTP failures without losing response evidence", async () => {
    const cases: readonly {
      readonly name: string;
      readonly response: WebhookTransportResponse;
      readonly outcome: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE";
      readonly code: string;
    }[] = [
      {
        name: "wrong content type",
        response: response({ contentType: "text/plain", body: ackBody() }),
        outcome: "RETRYABLE_FAILURE",
        code: "ack_content_type_invalid",
      },
      {
        name: "invalid JSON",
        response: response({ body: Buffer.from("{", "utf8") }),
        outcome: "RETRYABLE_FAILURE",
        code: "ack_json_invalid",
      },
      {
        name: "extra ACK field",
        response: response({ body: ackBody({ extra: true }) }),
        outcome: "RETRYABLE_FAILURE",
        code: "ack_shape_invalid",
      },
      {
        name: "event mismatch",
        response: response({ body: ackBody({ event_id: OTHER_EVENT_ID }) }),
        outcome: "RETRYABLE_FAILURE",
        code: "ack_event_mismatch",
      },
      {
        name: "delivery mismatch",
        response: response({ body: ackBody({ delivery_id: OTHER_DELIVERY_ID }) }),
        outcome: "RETRYABLE_FAILURE",
        code: "ack_delivery_mismatch",
      },
      {
        name: "unsupported content encoding",
        response: response({ contentEncoding: "gzip", body: ackBody() }),
        outcome: "PERMANENT_FAILURE",
        code: "ack_content_encoding_invalid",
      },
      ...[408, 425, 429, 500, 503].map((status) => ({
        name: `retryable HTTP ${status}`,
        response: response({ status, body: Buffer.alloc(0) }),
        outcome: "RETRYABLE_FAILURE" as const,
        code: "http_status_not_ack",
      })),
      ...[400, 401, 403, 404, 422].map((status) => ({
        name: `permanent HTTP ${status}`,
        response: response({ status, body: Buffer.alloc(0) }),
        outcome: "PERMANENT_FAILURE" as const,
        code: "http_status_not_ack",
      })),
    ];

    for (const fixture of cases) {
      const store = new FakeWebhookStore(claimedAttempt());
      const transport: WebhookTransport = {
        async post() {
          return fixture.response;
        },
      };
      const service = new WebhookDeliveryService({
        store,
        transport,
        config,
        clock: sequenceClock(5_000, 5_001, 5_002),
      });

      const result = await service.processOne();
      assert.equal(result.outcome, fixture.outcome, fixture.name);
      assert.equal(result.errorCode, fixture.code, fixture.name);
      assert.equal(store.completions.length, 1, fixture.name);
      const completion = store.completions[0]!;
      assert.equal(completion.outcome, fixture.outcome, fixture.name);
      assert.equal(completion.httpStatus, fixture.response.status, fixture.name);
      assert.equal(completion.responseBytes, fixture.response.body.byteLength, fixture.name);
      assert.equal(completion.responseFingerprint, fixture.response.responseFingerprint, fixture.name);
      assert.equal(completion.ackCode, fixture.code, fixture.name);
      assert.equal(completion.errorCode, fixture.code, fixture.name);
    }
  });

  it("maps transport exceptions to retry, permanent failure, or unknown outcome", async () => {
    const cases: readonly {
      readonly name: string;
      readonly error: unknown;
      readonly outcome: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "OUTCOME_UNKNOWN";
      readonly code: string;
    }[] = [
      {
        name: "cancelled after an uncertain write",
        error: new WebhookTransportError({
          code: "transport_cancelled",
          message: "cancelled",
          retryable: true,
          resolvedAddressesFingerprint: "e".repeat(64),
          connectedAddress: "1.1.1.1",
        }),
        outcome: "OUTCOME_UNKNOWN",
        code: "transport_cancelled",
      },
      {
        name: "timeout after a potentially completed request",
        error: new WebhookTransportError({
          code: "transport_timeout",
          message: "timeout",
          retryable: true,
        }),
        outcome: "OUTCOME_UNKNOWN",
        code: "transport_timeout",
      },
      {
        name: "DNS failure before any request",
        error: new WebhookTransportError({
          code: "dns_failed",
          message: "DNS failed",
          retryable: true,
        }),
        outcome: "RETRYABLE_FAILURE",
        code: "dns_failed",
      },
      {
        name: "response stream interrupted after delivery",
        error: new WebhookTransportError({
          code: "transport_network",
          message: "response interrupted",
          retryable: true,
          resolvedAddressesFingerprint: "d".repeat(64),
          connectedAddress: "1.0.0.1",
        }),
        outcome: "OUTCOME_UNKNOWN",
        code: "transport_network",
      },
      {
        name: "permanent transport failure",
        error: new WebhookTransportError({
          code: "target_address_forbidden",
          message: "forbidden",
          retryable: false,
        }),
        outcome: "PERMANENT_FAILURE",
        code: "target_address_forbidden",
      },
      {
        name: "unexpected exception",
        error: new Error("socket implementation failed"),
        outcome: "OUTCOME_UNKNOWN",
        code: "transport_network",
      },
    ];

    for (const fixture of cases) {
      const store = new FakeWebhookStore(claimedAttempt());
      const transport: WebhookTransport = {
        async post() {
          throw fixture.error;
        },
      };
      const service = new WebhookDeliveryService({
        store,
        transport,
        config,
        clock: sequenceClock(6_000, 6_001, 6_002),
      });

      const result = await service.processOne();
      assert.equal(result.outcome, fixture.outcome, fixture.name);
      assert.equal(result.errorCode, fixture.code, fixture.name);
      const completion = store.completions[0]!;
      assert.equal(completion.outcome, fixture.outcome, fixture.name);
      assert.equal(completion.errorCode, fixture.code, fixture.name);
      if (fixture.code === "transport_cancelled") {
        assert.equal(completion.resolvedAddressesFingerprint, "e".repeat(64));
        assert.equal(completion.connectedAddress, "1.1.1.1");
      } else if (fixture.name === "response stream interrupted after delivery") {
        assert.equal(completion.resolvedAddressesFingerprint, "d".repeat(64));
        assert.equal(completion.connectedAddress, "1.0.0.1");
      }
    }
  });

  it("does not reinterpret ACK persistence failures as transport failures", async () => {
    const persistenceError = new Error("database completion failed");
    const store = new FakeWebhookStore(claimedAttempt(), persistenceError);
    let transportCalls = 0;
    const transport: WebhookTransport = {
      async post() {
        transportCalls += 1;
        return response({ body: ackBody() });
      },
    };
    const service = new WebhookDeliveryService({
      store,
      transport,
      config,
      clock: sequenceClock(7_000, 7_001, 7_002),
    });

    await assert.rejects(service.processOne(), persistenceError);
    assert.equal(transportCalls, 1);
    assert.equal(store.completions.length, 1);
    assert.equal(store.completions[0]?.outcome, "ACKNOWLEDGED");
    assert.equal(store.completions[0]?.errorCode, null);
  });
});

class FakeWebhookStore implements WebhookDeliveryStore {
  readonly materializeCalls: Array<{ readonly limit: number; readonly now: number }> = [];
  readonly claimCalls: Array<{
    readonly now: number;
    readonly leaseMilliseconds: number;
    readonly maximumAttempts: number;
  }> = [];
  readonly completions: CompleteWebhookAttemptInput[] = [];
  readonly #claimed: ClaimedWebhookAttempt | null;
  readonly #completionError: Error | null;

  constructor(claimed: ClaimedWebhookAttempt | null, completionError: Error | null = null) {
    this.#claimed = claimed;
    this.#completionError = completionError;
  }

  materialize(limit: number, now: number): number {
    this.materializeCalls.push({ limit, now });
    return this.#claimed === null ? 0 : 1;
  }

  claimNext(input: {
    readonly now: number;
    readonly leaseMilliseconds: number;
    readonly maximumAttempts: number;
  }): ClaimedWebhookAttempt | null {
    this.claimCalls.push(input);
    return this.#claimed;
  }

  completeAttempt(input: CompleteWebhookAttemptInput): WebhookDelivery {
    this.completions.push(input);
    if (this.#completionError) throw this.#completionError;
    if (!this.#claimed) throw new Error("completion without a claim");
    const status = input.outcome === "ACKNOWLEDGED"
      ? "ACKNOWLEDGED"
      : input.outcome === "PERMANENT_FAILURE"
        ? "DEAD_LETTER"
        : "RETRY_WAIT";
    return {
      ...this.#claimed.delivery,
      status,
      leaseExpiresAt: null,
      acknowledgedAt: status === "ACKNOWLEDGED" ? input.now : null,
      deadLetteredAt: status === "DEAD_LETTER" ? input.now : null,
      lastErrorCode: input.errorCode ?? null,
      updatedAt: input.now,
    };
  }
}

function claimedAttempt(): ClaimedWebhookAttempt {
  return {
    delivery: {
      deliveryId: DELIVERY_ID,
      eventId: EVENT_ID,
      targetId: TARGET_ID,
      generation: 1,
      predecessorDeliveryId: null,
      requestKey: `event:${EVENT_ID}`,
      requestedByType: "SYSTEM",
      requestedByActorId: null,
      reason: null,
      status: "LEASED",
      attemptCount: 1,
      nextAttemptAt: 3_000,
      leaseExpiresAt: 33_000,
      acknowledgedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      createdAt: 1_000,
      updatedAt: 3_000,
    },
    event: {
      eventId: EVENT_ID,
      eventType: "payment.succeeded",
      orderId: ORDER_ID,
      orderVersion: 3,
      payloadJson: PAYLOAD_JSON,
      payloadFingerprint: createHash("sha256").update(PAYLOAD_JSON, "utf8").digest("hex"),
      createdAt: 1_000,
    },
    target: {
      targetId: TARGET_ID,
      orderId: ORDER_ID,
      apiClientId: "default",
      format: "NATIVE_JSON_V1",
      targetUrl: "https://hooks.example.test/receive?tenant=personal",
      allowedOrigin: "https://hooks.example.test",
      urlFingerprint: "f".repeat(64),
      createdAt: 1_000,
    },
    attempt: {
      attemptId: ATTEMPT_ID,
      deliveryId: DELIVERY_ID,
      attemptNumber: 1,
      leaseToken: LEASE_TOKEN,
      keyVersion: 1,
      keyId: KEY_ID,
      requestTimestamp: REQUEST_TIMESTAMP,
      requestBodyFingerprint: createHash("sha256").update(PAYLOAD_JSON, "utf8").digest("hex"),
      outcome: "STARTED",
      resolvedAddressesFingerprint: null,
      connectedAddress: null,
      httpStatus: null,
      responseBytes: null,
      responseFingerprint: null,
      ackCode: null,
      errorCode: null,
      startedAt: 3_000,
      finishedAt: null,
    },
    key: {
      keyVersion: 1,
      keyId: KEY_ID,
      secretFingerprint: config.signingKeyFingerprint,
      activatedAt: 500,
      retiredAt: null,
    },
  };
}

function response(
  overrides: Partial<WebhookTransportResponse> = {},
): WebhookTransportResponse {
  return {
    status: 200,
    contentType: "application/json; charset=utf-8",
    contentEncoding: "identity",
    body: ackBody(),
    responseFingerprint: "d".repeat(64),
    resolvedAddressesFingerprint: "c".repeat(64),
    connectedAddress: "8.8.8.8",
    ...overrides,
  };
}

function ackBody(
  overrides: Readonly<Record<string, unknown>> = {},
): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "perpay:webhook-ack:v1",
    ack: true,
    event_id: EVENT_ID,
    delivery_id: DELIVERY_ID,
    ...overrides,
  }), "utf8");
}

function expectedSignature(body: Buffer): string {
  const bodyFingerprint = createHash("sha256").update(body).digest("hex");
  const canonical = [
    "perpay:webhook:v1",
    KEY_ID,
    String(REQUEST_TIMESTAMP),
    DELIVERY_ID,
    EVENT_ID,
    "1",
    bodyFingerprint,
  ].join("\n");
  return `v1=${createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "base64url"))
    .update(canonical, "utf8")
    .digest("hex")}`;
}

function rejectingUnexpectedTransport(): WebhookTransport {
  return {
    async post() {
      throw new Error("transport must not be called");
    },
  };
}

function sequenceClock(...values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("webhook test clock exhausted");
    index += 1;
    return value;
  };
}
