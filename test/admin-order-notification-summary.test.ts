import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:sqlite";
import { describe, it } from "node:test";

import type { AppDatabase } from "../src/database/database.ts";
import {
  adminOrderNotificationSummaries,
  type AdminOrderNotificationSummary,
} from "../src/http/admin-order-notification-summary.ts";
import type { ClaimedWebhookAttempt, CompleteWebhookAttemptInput } from "../src/notifications/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { seedLegacyRefund } from "./legacy-refund-fixture.ts";
import {
  enableNotifications,
  withHttpFixture,
  type ReconciliationHttpFixture,
} from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";

describe("admin order notification summaries", () => {
  it("distinguishes no target, no business event and unmaterialized events without creating deliveries", async () => {
    await withHttpFixture(async (fixture) => {
      const unconfigured = fixture.createOrder("unconfigured", 1_000);
      const paidWithoutTarget = fixture.createSettlement("paid-unconfigured", 2_000).order;
      const { notifyUrl } = enableNotifications(fixture);
      const noEvent = fixture.createOrder("no-event", 3_000, notifyUrl);
      const unmaterialized = fixture.createSettlement("unmaterialized", 4_000, notifyUrl).order;
      const connection = fixture.database.read((db) => db);
      const before = connection.prepare("SELECT total_changes() AS count").get();

      const missingId = randomUUID();
      const summaries = adminOrderNotificationSummaries(fixture.database, [
        unconfigured.orderId, paidWithoutTarget.orderId, noEvent.orderId,
        unmaterialized.orderId, missingId,
      ]);
      assert.deepEqual(summaries.get(unconfigured.orderId), expected("NOT_CONFIGURED", 0));
      assert.deepEqual(summaries.get(paidWithoutTarget.orderId), expected("NOT_CONFIGURED", 0));
      assert.deepEqual(summaries.get(noEvent.orderId), expected("NO_EVENT", 0));
      assert.deepEqual(summaries.get(unmaterialized.orderId), expected("UNMATERIALIZED"));
      assert.equal(summaries.has(missingId), false);
      assert.equal(summaries.size, 4);
      assert.deepEqual(connection.prepare("SELECT total_changes() AS count").get(), before);
      assert.equal(fixture.webhooks.listDeliveries({ limit: 10 }).deliveries.length, 0);
    });
  });

  it("follows a confirmed payment's pending, leased, retry and terminal delivery states", async () => {
    await withHttpFixture(async (fixture) => {
      const { notifyUrl } = enableNotifications(fixture);
      const { order } = fixture.createSettlement("delivery-states", 1_000, notifyUrl);
      const now = Date.now();
      assert.equal(fixture.webhooks.materialize(10, now), 1);
      assertSummary(fixture, order.orderId, "PENDING");
      const attempt = claim(fixture, now);
      assertSummary(fixture, order.orderId, "LEASED");
      const retry = finish(fixture, attempt, "RETRYABLE_FAILURE", now + 1);
      assertSummary(fixture, order.orderId, "RETRY_WAIT");
      const finalAttempt = claim(fixture, retry.nextAttemptAt);
      finish(fixture, finalAttempt, "PERMANENT_FAILURE", retry.nextAttemptAt + 1);
      assertSummary(fixture, order.orderId, "DEAD_LETTER");
      assert.equal(fixture.services.orders.get(order.orderId).payment.status, "CONFIRMED");
    });
  });

  it("replaces failed and acknowledged historical generations with the current redelivery", async () => {
    await withHttpFixture(async (fixture) => {
      const { allowedOrigin, notifyUrl } = enableNotifications(fixture);
      const { order } = fixture.createSettlement("generations", 1_000, notifyUrl);
      const now = Date.now();
      fixture.webhooks.materialize(10, now);
      const first = finish(fixture, claim(fixture, now), "PERMANENT_FAILURE", now + 1);
      const second = fixture.webhooks.replay({
        redeliveryId: randomUUID(), deliveryId: first.deliveryId,
        actorId: "admin", reason: "retry a stopped event", activeAllowedOrigin: allowedOrigin,
        now: now + 2,
      }).delivery;
      assertSummary(fixture, order.orderId, "PENDING");
      finish(fixture, claim(fixture, second.nextAttemptAt), "ACKNOWLEDGED", now + 3);
      assertSummary(fixture, order.orderId, "ACKNOWLEDGED", 1, 1);
      const third = fixture.webhooks.replay({
        redeliveryId: randomUUID(), deliveryId: second.deliveryId,
        actorId: "admin", reason: "request a new business acknowledgement", activeAllowedOrigin: allowedOrigin,
        now: now + 4,
      }).delivery;
      assertSummary(fixture, order.orderId, "PENDING", 1, 0);
      const retry = finish(fixture, claim(fixture, third.nextAttemptAt), "RETRYABLE_FAILURE", now + 5);
      assertSummary(fixture, order.orderId, "RETRY_WAIT", 1, 0);
      finish(fixture, claim(fixture, retry.nextAttemptAt), "ACKNOWLEDGED", retry.nextAttemptAt + 1);
      assertSummary(fixture, order.orderId, "ACKNOWLEDGED", 1, 1);
      assert.equal(fixture.webhooks.listDeliveriesForOrder({ orderId: order.orderId, limit: 10 }).deliveries.length, 3);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("counts every business event and requires all current generations to be acknowledged", async () => {
    await withHttpFixture(async (fixture) => {
      const { allowedOrigin, notifyUrl } = enableNotifications(fixture);
      const { order, result } = fixture.createSettlement("multiple-events", 1_000, notifyUrl);
      const now = Date.now();
      fixture.webhooks.materialize(10, now);
      finish(fixture, claim(fixture, now), "ACKNOWLEDGED", now + 1);
      fixture.reconciliation.reverseSettlement({
        financialOperationId: randomUUID(), paymentMatchId: result.paymentMatchId,
        actorId: "admin", reason: "disputed receipt", now: now + 2,
      });
      assertSummary(fixture, order.orderId, "UNMATERIALIZED", 2, 1);
      assert.equal(fixture.webhooks.materialize(10, now + 3), 1);
      assertSummary(fixture, order.orderId, "PENDING", 2, 1);
      const disputed = claim(fixture, now + 3);
      assert.equal(disputed.event.eventType, "PAYMENT_DISPUTED");
      assertSummary(fixture, order.orderId, "LEASED", 2, 1);
      const dead = finish(fixture, disputed, "PERMANENT_FAILURE", now + 4);
      assertSummary(fixture, order.orderId, "DEAD_LETTER", 2, 1);
      fixture.webhooks.replay({
        redeliveryId: randomUUID(), deliveryId: dead.deliveryId,
        actorId: "admin", reason: "recover one of several events", activeAllowedOrigin: allowedOrigin,
        now: now + 5,
      });
      assertSummary(fixture, order.orderId, "PENDING", 2, 1);
      finish(fixture, claim(fixture, now + 5), "ACKNOWLEDGED", now + 6);
      assertSummary(fixture, order.orderId, "ACKNOWLEDGED", 2, 2);
    });
  });

  it("prioritizes stopped and retrying events above leased, pending and unmaterialized events", async () => {
    await withHttpFixture(async (fixture) => {
      const { notifyUrl } = enableNotifications(fixture);
      const { order } = fixture.createSettlement("priority", 1_000, notifyUrl);
      const now = Date.now();
      fixture.webhooks.materialize(10, now);
      finish(fixture, claim(fixture, now), "ACKNOWLEDGED", now + 1);

      const addRefundEvent = (sequence: number) => {
        const debit = fixture.recordDebit(`priority-refund-${sequence}`, 100, sequence + 2);
        seedLegacyRefund(fixture.database, {
          financialOperationId: randomUUID(), orderId: order.orderId,
          ledgerEntryId: debit.ledgerEntryId, actorId: "admin", reason: "historical refund event",
          now: now + sequence * 2,
        });
      };

      addRefundEvent(1);
      assertSummary(fixture, order.orderId, "UNMATERIALIZED", 2, 1);
      fixture.webhooks.materialize(10, now + 3);
      addRefundEvent(2);
      assertSummary(fixture, order.orderId, "PENDING", 3, 1);
      const second = claim(fixture, now + 4);
      assert.equal(second.event.eventType, "REFUND_UPDATED");
      assertSummary(fixture, order.orderId, "LEASED", 3, 1);
      fixture.webhooks.materialize(10, now + 5);
      assertSummary(fixture, order.orderId, "LEASED", 3, 1);
      const third = claim(fixture, now + 5);
      finish(fixture, second, "RETRYABLE_FAILURE", now + 6);
      assertSummary(fixture, order.orderId, "RETRY_WAIT", 3, 1);
      addRefundEvent(3);
      assertSummary(fixture, order.orderId, "RETRY_WAIT", 4, 1);
      fixture.webhooks.materialize(10, now + 7);
      assertSummary(fixture, order.orderId, "RETRY_WAIT", 4, 1);
      finish(fixture, third, "PERMANENT_FAILURE", now + 8);
      assertSummary(fixture, order.orderId, "DEAD_LETTER", 4, 1);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("uses the order's saved target after site changes and keeps requested website orders isolated", async () => {
    await withHttpFixture(async (fixture) => {
      const { notifyUrl } = enableNotifications(fixture);
      const sites = fixture.services.sites;
      const secondSite = sites.create({
        operation_id: randomUUID(), configuration: {
          name: "第二网站", accepting_orders: true, notifications_enabled: false,
          notification_origin: null, return_origin: null, policy: sites.defaults().policy,
        },
      }, { actorId: "admin" });
      configureTestSiteNotifications(sites, secondSite.clientId, {
        enabled: true, allowed_origin: "https://second.example.com",
      });
      const createAtSite = (clientId: string, amount: number, target: string) => {
        const order = fixture.services.orders.forSite(clientId).create(createOrderRequestSchema.parse({
          idempotency_key: "same-idempotency", merchant_order_no: "same-merchant-order",
          amount_cents: amount, product_name: "同名商品", notify_url: target,
        })).order;
        const credit = fixture.recordCredit(`site-${clientId}`, order.payableAmountCents, 1);
        assert.equal(fixture.reconciliation.reconcileEntry(credit.ledgerEntryId).kind, "auto_settled");
        return order;
      };
      const first = createAtSite("default", 1_000, notifyUrl);
      const second = createAtSite(secondSite.clientId, 2_000, "https://second.example.com/notify");
      const noEvent = fixture.createOrder("saved-target", 3_000, notifyUrl);
      const unconfigured = fixture.createOrder("no-saved-target", 4_000);
      assert.equal(fixture.webhooks.materialize(10, Date.now(), "default"), 1);
      const ids = [first.orderId, second.orderId, noEvent.orderId, unconfigured.orderId];
      const before = adminOrderNotificationSummaries(fixture.database, ids);
      assert.deepEqual(before.get(first.orderId), expected("PENDING"));
      assert.deepEqual(before.get(second.orderId), expected("UNMATERIALIZED"));
      assert.deepEqual(before.get(noEvent.orderId), expected("NO_EVENT", 0));
      assert.deepEqual(before.get(unconfigured.orderId), expected("NOT_CONFIGURED", 0));

      configureTestSiteNotifications(sites, "default", { enabled: false, allowed_origin: null });
      configureTestSiteNotifications(sites, secondSite.clientId, {
        enabled: true, allowed_origin: "https://replacement.example.com",
      });
      assert.deepEqual(adminOrderNotificationSummaries(fixture.database, ids), before);
      const secondPage = adminOrderNotificationSummaries(fixture.database, [second.orderId]);
      assert.deepEqual([...secondPage], [[second.orderId, expected("UNMATERIALIZED")]]);
    });
  });

  it("makes one deduplicated batch query without reading private data or writing state", async (context) => {
    await withHttpFixture(async (fixture) => {
      const { notifyUrl } = enableNotifications(fixture);
      const first = fixture.createSettlement("bounded-read", 1_000, notifyUrl).order;
      const second = fixture.createOrder("bounded-read-no-target", 2_000);
      fixture.webhooks.materialize(10, Date.now());
      const connection = fixture.database.read((db) => db);
      const prepare = context.mock.method(connection, "prepare");
      const allowed = new Map<string, Set<string>>([
        ["app_lease", new Set(["owner_token", "expires_at", "lease_key"])],
        ["payment_orders", new Set(["order_id"])],
        ["webhook_targets", new Set(["order_id", "target_id"])],
        ["outbox_events", new Set(["aggregate_id", "outbox_event_id"])],
        ["webhook_deliveries", new Set(["outbox_event_id", "target_id", "generation", "status"])],
      ]);
      connection.setAuthorizer((action, table, column) => {
        if (action === constants.SQLITE_READ && (!table || !column || !allowed.get(table)?.has(column))) {
          return constants.SQLITE_DENY;
        }
        return [constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION].includes(action)
          ? constants.SQLITE_OK : constants.SQLITE_DENY;
      });
      try {
        const summaries = adminOrderNotificationSummaries(fixture.database, [
          first.orderId, first.orderId, second.orderId, first.orderId, second.orderId,
        ]);
        assert.equal(summaries.size, 2);
        assert.deepEqual(summaries.get(first.orderId), expected("PENDING"));
        assert.deepEqual(summaries.get(second.orderId), expected("NOT_CONFIGURED", 0));
        const queries = prepare.mock.calls.map((call) => call.arguments[0])
          .filter((sql) => !sql.includes("app_lease"));
        assert.equal(queries.length, 1);
        assert.equal(queries[0]!.match(/\?/g)?.length, 2);
      } finally {
        connection.setAuthorizer(null);
        prepare.mock.restore();
      }
    });
  });

  it("does not access the database for an empty page", () => {
    const database = { read: () => assert.fail("an empty page must not issue a read") } as unknown as AppDatabase;
    assert.equal(adminOrderNotificationSummaries(database, []).size, 0);
  });
});

function expected(
  status: AdminOrderNotificationSummary["status"], total = 1, acknowledged = 0,
): AdminOrderNotificationSummary {
  return { status, total_events: total, acknowledged_events: acknowledged };
}

function assertSummary(
  fixture: ReconciliationHttpFixture, orderId: string,
  status: AdminOrderNotificationSummary["status"], total = 1, acknowledged = 0,
) {
  assert.deepEqual(adminOrderNotificationSummaries(fixture.database, [orderId]).get(orderId),
    expected(status, total, acknowledged));
}

function claim(fixture: ReconciliationHttpFixture, now: number): ClaimedWebhookAttempt {
  const attempt = fixture.webhooks.claimNext({
    clientId: "default", siteRevision: fixture.services.sites.get("default")!.revision,
    now, leaseMilliseconds: 30_000, maximumAttempts: 3,
  });
  assert.ok(attempt);
  return attempt;
}

function finish(
  fixture: ReconciliationHttpFixture, attempt: ClaimedWebhookAttempt,
  outcome: CompleteWebhookAttemptInput["outcome"], now: number,
) {
  return fixture.webhooks.completeAttempt({
    deliveryId: attempt.delivery.deliveryId, attemptId: attempt.attempt.attemptId,
    leaseToken: attempt.attempt.leaseToken, outcome, now,
    maximumAttempts: 3, retryBaseMilliseconds: 60_000, retryMaximumMilliseconds: 60_000,
    ...(outcome === "ACKNOWLEDGED" ? {
      resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8",
      httpStatus: 200, responseBytes: 2, responseFingerprint: createHash("sha256").update("ok").digest("hex"),
      ackCode: "acknowledged", errorCode: null,
    } : { errorCode: "transport_timeout" }),
  });
}
