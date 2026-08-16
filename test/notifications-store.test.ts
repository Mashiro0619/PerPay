import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { OrderStore, type StoredOrderAggregate } from "../src/database/order-store.ts";
import type { AccountLogDetail } from "../src/infrastructure/alipay/types.ts";
import type { LedgerEntry } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import {
  prepareWebhookTarget,
  WebhookStore,
  WebhookStoreError,
  webhookSigningKeyFingerprint,
} from "../src/notifications/index.ts";
import {
  createOrderRequestSchema,
  fingerprintCreateOrderRequest,
} from "../src/orders/model.ts";
import {
  digestIdempotencyKey,
  fingerprintCollectionCodeProfile,
} from "../src/orders/service.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";

const API_CLIENT_ID = "default";
const BASE_TIME = 2_000_000_000_000;
const EVENT_TIME = BASE_TIME + 60_000;
const DELIVERY_TIME = BASE_TIME + 70_000;
const ALLOWED_ORIGIN = "https://hooks.example.test";
const TARGET_URL = `${ALLOWED_ORIGIN}/receive?tenant=personal%26developer`;
const PROVIDER_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;

describe("WebhookStore", () => {
  it("materializes, retries, acknowledges, and projects one durable event", async () => {
    await withWebhookContext(async ({ database, store, outboxCreatedAt }) => {
      assert.equal(store.materialize(10, DELIVERY_TIME), 1);
      assert.equal(store.materialize(10, DELIVERY_TIME), 0);
      const claimed = store.claimNext({
        now: DELIVERY_TIME,
        leaseMilliseconds: 30_000,
        maximumAttempts: 3,
      });
      assert.ok(claimed);
      assert.equal(claimed.event.createdAt, outboxCreatedAt);
      assert.equal(claimed.delivery.leaseExpiresAt, DELIVERY_TIME + 30_000);
      assert.equal(claimed.attempt.requestBodyFingerprint, claimed.event.payloadFingerprint);

      const retry = store.completeAttempt({
        deliveryId: claimed.delivery.deliveryId,
        attemptId: claimed.attempt.attemptId,
        leaseToken: claimed.attempt.leaseToken,
        outcome: "RETRYABLE_FAILURE",
        now: DELIVERY_TIME + 1_000,
        maximumAttempts: 3,
        retryBaseMilliseconds: 1_000,
        retryMaximumMilliseconds: 60_000,
        errorCode: "transport_timeout",
      });
      assert.equal(retry.status, "RETRY_WAIT");
      assert.equal(retry.attemptCount, 1);
      assert.equal(retry.nextAttemptAt > DELIVERY_TIME + 1_000, true);

      const second = store.claimNext({
        now: retry.nextAttemptAt,
        leaseMilliseconds: 30_000,
        maximumAttempts: 3,
      });
      assert.ok(second);
      assert.equal(second.delivery.deliveryId, claimed.delivery.deliveryId);
      assert.equal(second.attempt.attemptNumber, 2);
      const response = Buffer.from(JSON.stringify({ ack: true }));
      const acknowledged = store.completeAttempt({
        deliveryId: second.delivery.deliveryId,
        attemptId: second.attempt.attemptId,
        leaseToken: second.attempt.leaseToken,
        outcome: "ACKNOWLEDGED",
        now: retry.nextAttemptAt + 1_000,
        maximumAttempts: 3,
        retryBaseMilliseconds: 1_000,
        retryMaximumMilliseconds: 60_000,
        resolvedAddressesFingerprint: "b".repeat(64),
        connectedAddress: "8.8.8.8",
        httpStatus: 200,
        responseBytes: response.byteLength,
        responseFingerprint: createHash("sha256").update(response).digest("hex"),
        ackCode: "acknowledged",
        errorCode: null,
      });
      assert.equal(acknowledged.status, "ACKNOWLEDGED");
      assert.equal(acknowledged.acknowledgedAt, retry.nextAttemptAt + 1_000);
      assert.equal(acknowledged.leaseExpiresAt, null);

      const detail = store.delivery(acknowledged.deliveryId);
      assert.ok(detail);
      assert.equal(detail.event.createdAt, outboxCreatedAt);
      assert.deepEqual(detail.attempts.map((attempt) => attempt.outcome), [
        "RETRYABLE_FAILURE",
        "ACKNOWLEDGED",
      ]);
      assert.equal(
        store.eventForApiClient(API_CLIENT_ID, detail.event.eventId)?.eventId,
        detail.event.eventId,
      );
      assert.equal(store.eventForApiClient("another-client", detail.event.eventId), null);

      const page = store.listDeliveries({ limit: 1 });
      assert.equal(page.deliveries.length, 1);
      assert.equal(page.deliveries[0]?.orderId, detail.event.orderId);
      assert.equal(page.deliveries[0]?.eventType, "PAYMENT_CONFIRMED");
      assert.equal(page.deliveries[0]?.targetUrlFingerprint, detail.target.urlFingerprint);
      assert.equal(page.nextCursor, null);
      assert.deepEqual(store.counts(), { pending: 0, dead: 0 });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("creates immutable replay generations and replays one request key exactly", async () => {
    await withWebhookContext(async ({ database, store }) => {
      const original = acknowledgeFirstDelivery(store);
      const redeliveryId = randomUUID();
      const reason = "😀".repeat(500);
      const input = {
        redeliveryId,
        deliveryId: original.deliveryId,
        actorId: "admin",
        reason,
        activeAllowedOrigin: ALLOWED_ORIGIN,
        now: DELIVERY_TIME + 100_000,
        requestId: randomUUID(),
        remoteAddressHash: "c".repeat(64),
      } as const;
      const created = store.replay(input);
      assert.equal(created.replayed, false);
      assert.equal(created.delivery.generation, 2);
      assert.equal(created.delivery.predecessorDeliveryId, original.deliveryId);
      assert.equal(created.delivery.requestKey, redeliveryId);

      const exactReplay = store.replay(input);
      assert.equal(exactReplay.replayed, true);
      assert.equal(exactReplay.delivery.deliveryId, created.delivery.deliveryId);
      for (const activeAllowedOrigin of [null, "https://rotated.example.test"] as const) {
        const replayAfterConfigurationChange = store.replay({
          ...input,
          activeAllowedOrigin,
        });
        assert.equal(replayAfterConfigurationChange.replayed, true);
        assert.equal(
          replayAfterConfigurationChange.delivery.deliveryId,
          created.delivery.deliveryId,
        );
      }
      assert.throws(
        () => store.replay({ ...input, reason: "different reason" }),
        (error: unknown) =>
          error instanceof WebhookStoreError &&
          error.code === "webhook_operation_conflict",
      );
      assert.throws(
        () => store.replay({
          ...input,
          redeliveryId: randomUUID(),
          activeAllowedOrigin: null,
        }),
        (error: unknown) =>
          error instanceof WebhookStoreError && error.code === "webhook_disabled",
      );
      assert.throws(
        () => store.replay({
          ...input,
          redeliveryId: randomUUID(),
          activeAllowedOrigin: "https://rotated.example.test",
        }),
        (error: unknown) =>
          error instanceof WebhookStoreError && error.code === "webhook_target_inactive",
      );
      assert.throws(
        () => store.replay({
          ...input,
          redeliveryId: randomUUID(),
          reason: "stale predecessor",
        }),
        (error: unknown) =>
          error instanceof WebhookStoreError &&
          error.code === "webhook_delivery_state_conflict",
      );

      database.read((connection) => {
        const rows = connection
          .prepare(
            `SELECT action, actor_type, actor_id, subject_id, details_json
               FROM audit_events
              WHERE action LIKE 'webhook.%'
              ORDER BY sequence`,
          )
          .all() as Array<{
          action: string;
          actor_type: string;
          actor_id: string;
          subject_id: string;
          details_json: string;
        }>;
        assert.deepEqual(rows.map((row) => row.action), [
          "webhook.signing_key_initialized",
          "webhook.delivery_redelivered",
        ]);
        assert.equal(rows[1]?.actor_type, "ADMIN");
        assert.equal(rows[1]?.actor_id, "admin");
        assert.equal(rows[1]?.subject_id, created.delivery.deliveryId);
        assert.equal(rows.some((row) => row.details_json.includes("secret")), false);
      });
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("recovers expired leases, honors a lowered maximum, and rotates keys monotonically", async () => {
    await withWebhookContext(async ({ database, store, signingSecret }) => {
      assert.equal(store.materialize(10, DELIVERY_TIME), 1);
      const claimed = store.claimNext({
        now: DELIVERY_TIME,
        leaseMilliseconds: 1_000,
        maximumAttempts: 12,
      });
      assert.ok(claimed);
      assert.equal(store.recoverExpired(DELIVERY_TIME + 1_000), 1);
      const recovered = store.delivery(claimed.delivery.deliveryId);
      assert.equal(recovered?.delivery.status, "RETRY_WAIT");
      assert.equal(recovered?.attempts[0]?.outcome, "OUTCOME_UNKNOWN");

      assert.equal(store.claimNext({
        now: DELIVERY_TIME + 1_000,
        leaseMilliseconds: 1_000,
        maximumAttempts: 1,
      }), null);
      const dead = store.delivery(claimed.delivery.deliveryId)?.delivery;
      assert.equal(dead?.status, "DEAD_LETTER");
      assert.equal(dead?.lastErrorCode, "maximum_attempts_reached");
      assert.deepEqual(store.counts(), { pending: 0, dead: 1 });

      const replay = store.replay({
        redeliveryId: randomUUID(),
        deliveryId: claimed.delivery.deliveryId,
        actorId: "admin",
        reason: "retry the unresolved dead letter",
        activeAllowedOrigin: ALLOWED_ORIGIN,
        now: DELIVERY_TIME + 2_000,
      });
      assert.equal(replay.delivery.status, "PENDING");
      assert.deepEqual(store.counts(), { pending: 1, dead: 0 });

      const active = store.activeSigningKey();
      assert.ok(active);
      const rotated = store.syncSigningKey({
        secretFingerprint: webhookSigningKeyFingerprint(
          Buffer.alloc(32, 91).toString("base64url"),
        ),
        now: active.activatedAt - 10_000,
      });
      assert.equal(rotated.keyVersion, active.keyVersion + 1);
      assert.equal(rotated.activatedAt, active.activatedAt);
      assert.throws(
        () => store.syncSigningKey({
          secretFingerprint: webhookSigningKeyFingerprint(signingSecret),
          now: active.activatedAt + 1,
        }),
        (error: unknown) =>
          error instanceof WebhookStoreError &&
          error.code === "webhook_signing_key_rollback",
      );
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("detects a notification target whose cryptographic binding was altered", async () => {
    await withWebhookContext(async ({ database }) => {
      database.write((connection) => {
        const trigger = connection
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'webhook_targets_no_update'",
          )
          .get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        connection.exec("DROP TRIGGER webhook_targets_no_update");
        connection.prepare("UPDATE webhook_targets SET url_fingerprint = ?")
          .run("0".repeat(64));
        connection.exec(trigger.sql);
      });

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
    });
  });

  it("rejects late target insertion and detects an altered order commitment", async () => {
    await withWebhookContext(async ({ database, order }) => {
      const lateOrder = createOrderWithoutWebhook(database);
      const target = prepareWebhookTarget(
        `${ALLOWED_ORIGIN}/late`,
        ALLOWED_ORIGIN,
      );
      rewriteOrderWebhookCommitment(
        database,
        lateOrder.order.orderId,
        target.requestFingerprint,
      );
      assert.throws(
        () => database.write((connection) => {
          connection.prepare(
            `INSERT INTO webhook_targets(
               target_id, order_id, api_client_id, target_format, target_url,
               allowed_origin, url_fingerprint, request_fingerprint,
               request_fingerprint_version, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            randomUUID(),
            lateOrder.order.orderId,
            API_CLIENT_ID,
            target.format,
            target.url,
            target.allowedOrigin,
            target.urlFingerprint,
            target.requestFingerprint,
            target.requestFingerprintVersion,
            lateOrder.order.createdAt,
          );
        }),
        /webhook target must match an uncommitted order target/,
      );
      rewriteOrderWebhookCommitment(database, lateOrder.order.orderId, null);
      assert.equal(database.integrityCheck().ok, true);

      rewriteOrderWebhookCommitment(database, order.order.orderId, "0".repeat(64));

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
    });
  });

  it("detects a committed notification target that is missing", async () => {
    await withWebhookContext(async ({ database }) => {
      database.write((connection) => {
        const trigger = connection
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'webhook_targets_no_delete'",
          )
          .get() as { sql: string } | undefined;
        assert.ok(trigger?.sql);
        connection.exec("DROP TRIGGER webhook_targets_no_delete");
        connection.exec("DELETE FROM webhook_targets");
        connection.exec(trigger.sql);
      });

      const integrity = database.integrityCheck();
      assert.equal(integrity.schema, "ok");
      assert.ok(integrity.domainViolations >= 1);
      assert.equal(integrity.ok, false);
    });
  });
});

interface WebhookTestContext {
  readonly database: AppDatabase;
  readonly store: WebhookStore;
  readonly order: StoredOrderAggregate;
  readonly outboxCreatedAt: number;
  readonly signingSecret: string;
}

async function withWebhookContext(
  operation: (context: WebhookTestContext) => Promise<void> | void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-webhook-store-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  let now = BASE_TIME;
  try {
    database.write((connection) => {
      connection.prepare(
        `INSERT INTO api_client_config(
           singleton_key, client_id, secret_fingerprint, key_version,
           enabled, created_at, updated_at
         ) VALUES (1, ?, ?, 1, 1, ?, ?)`,
      ).run(API_CLIENT_ID, "a".repeat(64), now, now);
      connection.prepare(
        `INSERT INTO api_client_keys(
           client_id, key_version, secret_fingerprint, activated_at, retired_at
         ) VALUES (?, 1, ?, ?, NULL)`,
      ).run(API_CLIENT_ID, "a".repeat(64), now);
    });
    const orders = new OrderStore(database, () => now);
    const { payloadFingerprint, profileFingerprint } = fingerprintCollectionCodeProfile(
      "https://qr.example.test/personal",
    );
    orders.syncCollectionProfile({
      codePayload: "https://qr.example.test/personal",
      payloadFingerprint,
      profileFingerprint,
    });
    const request = createOrderRequestSchema.parse({
      idempotency_key: "webhook-store-idempotency",
      merchant_order_no: "webhook-store-order",
      amount_cents: 999,
      notify_url: TARGET_URL,
    });
    const created = orders.createOrder({
      apiClientId: API_CLIENT_ID,
      request,
      idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
      requestFingerprint: fingerprintCreateOrderRequest(request),
      ttlMilliseconds: 5 * 60 * 1_000,
      amountOffsetMaximumCents: 99,
      webhookTarget: prepareWebhookTarget(TARGET_URL, ALLOWED_ORIGIN),
    });
    if (created.kind !== "created") {
      throw new Error(`expected a created order, received ${created.kind}`);
    }

    const ledger = new LedgerStore(database);
    ledger.bindProviderIdentity(PROVIDER_IDENTITY, now);
    const entry = recordLedgerEntry(
      ledger,
      "webhook-store-credit",
      created.aggregate.order.payableAmountCents,
      EVENT_TIME,
      EVENT_TIME + 1_000,
    );
    const outboxCreatedAt = EVENT_TIME + 3_000;
    new ReconciliationStore(database).settleManually({
      financialOperationId: randomUUID(),
      orderId: created.aggregate.order.orderId,
      ledgerEntryId: entry.ledgerEntryId,
      actorId: "admin",
      reason: "confirm webhook store fixture",
      now: outboxCreatedAt,
    });
    now = outboxCreatedAt;

    const signingSecret = Buffer.alloc(32, 77).toString("base64url");
    const store = new WebhookStore(database);
    store.syncSigningKey({
      secretFingerprint: webhookSigningKeyFingerprint(signingSecret),
      now: outboxCreatedAt,
    });
    await operation({
      database,
      store,
      order: created.aggregate,
      outboxCreatedAt,
      signingSecret,
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function acknowledgeFirstDelivery(store: WebhookStore) {
  assert.equal(store.materialize(10, DELIVERY_TIME), 1);
  const claimed = store.claimNext({
    now: DELIVERY_TIME,
    leaseMilliseconds: 30_000,
    maximumAttempts: 3,
  });
  assert.ok(claimed);
  const response = Buffer.from("{}");
  return store.completeAttempt({
    deliveryId: claimed.delivery.deliveryId,
    attemptId: claimed.attempt.attemptId,
    leaseToken: claimed.attempt.leaseToken,
    outcome: "ACKNOWLEDGED",
    now: DELIVERY_TIME + 1_000,
    maximumAttempts: 3,
    retryBaseMilliseconds: 1_000,
    retryMaximumMilliseconds: 60_000,
    resolvedAddressesFingerprint: "d".repeat(64),
    connectedAddress: "8.8.8.8",
    httpStatus: 200,
    responseBytes: response.byteLength,
    responseFingerprint: createHash("sha256").update(response).digest("hex"),
    ackCode: "acknowledged",
    errorCode: null,
  });
}

function createOrderWithoutWebhook(database: AppDatabase): StoredOrderAggregate {
  const request = createOrderRequestSchema.parse({
    idempotency_key: "webhook-store-no-target-idempotency",
    merchant_order_no: "webhook-store-no-target-order",
    amount_cents: 899,
  });
  const created = new OrderStore(database, () => DELIVERY_TIME + 10_000).createOrder({
    apiClientId: API_CLIENT_ID,
    request,
    idempotencyKeyDigest: digestIdempotencyKey(API_CLIENT_ID, request.idempotency_key),
    requestFingerprint: fingerprintCreateOrderRequest(request),
    ttlMilliseconds: 5 * 60 * 1_000,
    amountOffsetMaximumCents: 99,
  });
  if (created.kind !== "created") {
    throw new Error(`expected a created order without a target, received ${created.kind}`);
  }
  return created.aggregate;
}

function rewriteOrderWebhookCommitment(
  database: AppDatabase,
  orderId: string,
  commitment: string | null,
): void {
  database.write((connection) => {
    const commitmentTrigger = connection
      .prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger'
            AND name = 'payment_orders_webhook_target_commitment_immutable'`,
      )
      .get() as { sql: string } | undefined;
    const versionTrigger = connection
      .prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'payment_orders_version_step'`,
      )
      .get() as { sql: string } | undefined;
    assert.ok(commitmentTrigger?.sql);
    assert.ok(versionTrigger?.sql);
    connection.exec("DROP TRIGGER payment_orders_webhook_target_commitment_immutable");
    connection.exec("DROP TRIGGER payment_orders_version_step");
    const update = connection.prepare(
      `UPDATE payment_orders
          SET webhook_target_request_fingerprint = ?
        WHERE order_id = ?`,
    ).run(commitment, orderId);
    assert.equal(Number(update.changes), 1);
    connection.exec(commitmentTrigger.sql);
    connection.exec(versionTrigger.sql);
  });
}

function recordLedgerEntry(
  store: LedgerStore,
  externalEventId: string,
  amountCents: number,
  occurredAt: number,
  startedAt: number,
): LedgerEntry {
  const run = store.startIngestRun({
    start: formatProviderTimestamp(BASE_TIME),
    end: formatProviderTimestamp(BASE_TIME + 60 * 60 * 1_000),
    pageSize: 1,
    now: startedAt,
  });
  const occurredAtText = formatProviderTimestamp(occurredAt);
  const amount = (amountCents / 100).toFixed(2);
  const detail: AccountLogDetail = {
    raw: {
      account_log_id: externalEventId,
      amount,
      direction: "CREDIT",
      occurred_at: occurredAtText,
    },
    accountLogId: externalEventId,
    occurredAt: occurredAtText,
    amount,
    direction: "CREDIT",
    alipayOrderNo: `platform-${externalEventId}`,
    merchantOrderNo: null,
    transMemo: null,
    otherAccount: null,
  };
  const recorded = store.recordPage({
    ingestRunId: run.ingestRunId,
    page: {
      pageNo: 1,
      pageSize: 1,
      totalSize: 1,
      hasMore: false,
      details: [detail],
    },
    evidence: {
      httpStatus: 200,
      headers: { "alipay-request-id": `trace-${externalEventId}` },
      body: JSON.stringify({ external_event_id: externalEventId, amount }),
      traceId: `trace-${externalEventId}`,
      signatureVerified: true,
    },
    now: startedAt + 1_000,
  });
  const normalized = recorded.normalized[0];
  if (!normalized || normalized.kind !== "created") {
    throw new Error(`expected a created ledger entry, received ${normalized?.kind ?? "missing"}`);
  }
  return normalized.entry;
}

function formatProviderTimestamp(milliseconds: number): string {
  const local = new Date(milliseconds + 8 * 60 * 60 * 1_000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}
