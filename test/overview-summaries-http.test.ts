import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import { createApp } from "../src/http/app.ts";
import type { OrderIdentitySummary } from "../src/http/admin-order-summary.ts";
import type { AdminOrderNotificationSummary } from "../src/http/admin-order-notification-summary.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";
import { configureTestSiteNotifications } from "./site-notification-fixture.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

type OrderRow = {
  order_id: string;
  api_client_id: string;
  site_name: string;
  merchant_order_no: string;
  product_name: string;
  payment: { status: string };
  notification_summary: AdminOrderNotificationSummary;
};
type WorkRow = {
  type: string;
  resource_id: string;
  order_id: string | null;
  status: string;
  order_summary: OrderIdentitySummary | null;
};
type Page<T> = { data: T[]; page: { next_cursor: string | null } };
const PRIVATE_NOTE = "overview-private-order-note-must-not-be-exposed";

it("projects overview summaries through authenticated global and website HTTP routes", async (context) => {
  const fixture = await createSitePaymentFixture();
  try {
    const ledger = new LedgerStore(fixture.database);
    const reconciliation = new ReconciliationStore(fixture.database);
    const webhooks = new WebhookStore(fixture.database);
    const app = createApp({ ...fixture, ledger, reconciliation, webhookStore: webhooks, startedAt: new Date(0), clock: fixture.now });
    const session = await fixture.identity.login(HTTP_TEST_ADMIN_PASSWORD);
    const headers = { cookie: `perpay_session=${session.sessionToken}; perpay_csrf=${session.csrfToken}` };
    const alpha = fixture.createSite("Alpha shop"), beta = fixture.createSite("Beta shop");
    configureTestSiteNotifications(fixture.sites, alpha.clientId, { enabled: true, allowed_origin: "https://alpha.example.com" });
    configureTestSiteNotifications(fixture.sites, beta.clientId, { enabled: true, allowed_origin: "https://beta.example.com" });

    const credit = (amount: number) => {
      const now = fixture.now();
      const timestamp = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
      return recordLedgerEntry(ledger, { start: timestamp(now - 60_000), end: timestamp(now + 60_000) },
        randomUUID(), amount, now + 1_000, now + 2_000, "CREDIT", fixture.snapshot.activeProviderAccountKey!);
    };
    const paid = (clientId: string, product: string, amount: number, outcome: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE") => {
      const site = fixture.sites.get(clientId)!;
      const order = fixture.orders.forSite(clientId).create(createOrderRequestSchema.parse({
        merchant_order_no: "same-merchant-number", idempotency_key: randomUUID(), amount_cents: amount,
        product_name: product, note: PRIVATE_NOTE, notify_url: site.configuration.notification_origin + "/notify",
      })).order;
      const entry = credit(order.payableAmountCents);
      reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: order.orderId,
        ledgerEntryId: entry.ledgerEntryId, actorId: "admin", now: fixture.now() + 2_001 });
      fixture.setNow(fixture.now() + 2_002);
      assert.equal(webhooks.materialize(10, fixture.now(), clientId), 1);
      const attempt = webhooks.claimNext({ clientId, siteRevision: site.revision,
        now: fixture.now(), leaseMilliseconds: 30_000, maximumAttempts: 3 });
      assert.ok(attempt);
      const delivery = webhooks.completeAttempt({ deliveryId: attempt.delivery.deliveryId,
        attemptId: attempt.attempt.attemptId, leaseToken: attempt.attempt.leaseToken, outcome,
        now: fixture.now() + 1, maximumAttempts: 3, retryBaseMilliseconds: 60_000,
        retryMaximumMilliseconds: 60_000, errorCode: "transport_timeout" });
      fixture.setNow(fixture.now() + 2);
      return { order, delivery };
    };
    // Simulate wall-clock progress under full-suite load without advancing the fixture clock.
    // This SQL function belongs only to this connection and is removed when the fixture closes.
    const physicalNow = fixture.now() + 15_000;
    fixture.database.read((connection) => {
      connection.function("unixepoch", (_modifier) => physicalNow / 1000);
    });
    const unlinked = reconciliation.reconcileEntry(credit(90_000).ledgerEntryId, fixture.now() + 2_001);
    assert.equal(unlinked.kind, "unmatched");
    if (unlinked.kind !== "unmatched") throw new Error("Expected an unallocated financial reminder");
    fixture.setNow(fixture.now() + 2_002);
    const alphaPaid = paid(alpha.clientId, "Alpha course", 10_000, "RETRYABLE_FAILURE");
    const betaPaid = paid(beta.clientId, "Beta subscription", 20_000, "PERMANENT_FAILURE");
    const unpaid = fixture.orders.forSite(alpha.clientId).create(createOrderRequestSchema.parse({
      merchant_order_no: "alpha-unpaid", idempotency_key: randomUUID(), amount_cents: 30_000,
      product_name: "Alpha pending order", note: PRIVATE_NOTE,
    })).order;
    const page = async <T>(path: string): Promise<Page<T>> => {
      const response = await app.request("/api/admin/v1" + path, { headers });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json() as Page<T>;
      assertNoDetails(body);
      return body;
    };

    await context.test("returns readable summaries without conflating confirmed payments and failed notifications", async () => {
      const orders = await page<OrderRow>("/orders");
      assert.deepEqual(new Set(orders.data.map((row) => row.order_id)),
        new Set([alphaPaid.order.orderId, betaPaid.order.orderId, unpaid.orderId]));
      const reminders = await page<WorkRow>("/work-items?sort_by=priority");
      assert.deepEqual(new Set(reminders.data.map((row) => row.resource_id)),
        new Set([alphaPaid.delivery.deliveryId, betaPaid.delivery.deliveryId, unlinked.exceptionId]));

      for (const [site, expected] of [[alpha, alphaPaid], [beta, betaPaid]] as const) {
        const order = orders.data.find((row) => row.order_id === expected.order.orderId)!;
        assert.ok(order);
        assert.equal(order.payment.status, "CONFIRMED");
        assert.deepEqual(order.notification_summary, {
          status: expected.delivery.status, total_events: 1, acknowledged_events: 0,
        });
        const reminder = reminders.data.find((row) => row.resource_id === expected.delivery.deliveryId)!;
        assert.ok(reminder);
        assert.equal(reminder.type, "NOTIFICATION_FAILURE");
        assert.equal(reminder.status, expected.delivery.status);
        const summary = reminder.order_summary;
        assert.ok(summary);
        assert.equal(summary.order_id, order.order_id);
        assert.equal(summary.api_client_id, site.clientId);
        assert.equal(summary.site_name, site.configuration.name);
        assert.equal(summary.product_name, expected.order.productName);
        assert.equal(summary.merchant_order_no, "same-merchant-number");
        assert.equal(summary.payable_amount_cents, expected.order.payableAmountCents);
        assert.equal(summary.received_amount_cents, expected.order.payableAmountCents);
        assert.ok(summary.payment_confirmed_at);
      }
      assert.equal(alphaPaid.delivery.status, "RETRY_WAIT");
      assert.equal(betaPaid.delivery.status, "DEAD_LETTER");
      assert.deepEqual(orders.data.find((row) => row.order_id === unpaid.orderId)?.notification_summary,
        { status: "NOT_CONFIGURED", total_events: 0, acknowledged_events: 0 });
      const unallocated = reminders.data.find((row) => row.resource_id === unlinked.exceptionId)!;
      assert.equal(unallocated.type, "FINANCIAL_EXCEPTION");
      assert.equal(unallocated.order_id, null);
      assert.equal(unallocated.order_summary, null);
    });

    await context.test("keeps both summaries within the selected website and binds pagination to its path", async () => {
      for (const [site, own, other] of [[alpha, alphaPaid, betaPaid], [beta, betaPaid, alphaPaid]] as const) {
        const base = "/sites/" + site.clientId;
        const orders = await page<OrderRow>(base + "/orders");
        assert.deepEqual(new Set(orders.data.map((row) => row.order_id)),
          new Set(site.clientId === alpha.clientId ? [own.order.orderId, unpaid.orderId] : [own.order.orderId]));
        assert.ok(orders.data.every((row) => row.api_client_id === site.clientId && row.site_name === site.configuration.name));
        assert.equal(orders.data.find((row) => row.order_id === own.order.orderId)?.notification_summary.status, own.delivery.status);
        const reminders = await page<WorkRow>(base + "/work-items?sort_by=priority");
        assert.deepEqual(reminders.data.map((row) => row.resource_id), [own.delivery.deliveryId]);
        assert.equal(reminders.data[0]?.order_summary?.order_id, own.order.orderId);
        assert.equal(reminders.data[0]?.order_summary?.api_client_id, site.clientId);
        assert.equal(reminders.data[0]?.order_summary?.product_name, own.order.productName);
        assert.deepEqual((await page<OrderRow>(base + "/orders?q=" + encodeURIComponent(other.order.productName))).data, []);
        assert.deepEqual((await page<WorkRow>(base + "/work-items?q=" + encodeURIComponent(other.order.productName))).data, []);
        assert.equal((await app.request("/api/admin/v1" + base + "/orders/" + other.order.orderId, { headers })).status, 404);
        assert.equal((await app.request("/api/admin/v1" + base + "/webhooks/deliveries/" + other.delivery.deliveryId, { headers })).status, 404);
      }
      const first = await page<OrderRow>("/sites/" + alpha.clientId + "/orders?limit=1");
      assert.ok(first.page.next_cursor);
      const second = await page<OrderRow>("/sites/" + alpha.clientId + "/orders?limit=1&cursor=" + encodeURIComponent(first.page.next_cursor));
      assert.deepEqual(new Set([...first.data, ...second.data].map((row) => row.order_id)), new Set([alphaPaid.order.orderId, unpaid.orderId]));
      const crossed = await app.request("/api/admin/v1/sites/" + beta.clientId + "/orders?cursor=" + encodeURIComponent(first.page.next_cursor), { headers });
      assert.equal(crossed.status, 422);
      assert.equal(((await crossed.json()) as { error: { code: string } }).error.code, "validation_failed");
    });

    await context.test("requires an administrator session for global and site summary responses", async () => {
      for (const path of ["/orders", "/work-items", "/sites/" + alpha.clientId + "/orders", "/sites/" + alpha.clientId + "/work-items"]) {
        const response = await app.request("/api/admin/v1" + path);
        assert.equal(response.status, 401);
        const body = await response.json() as { data?: unknown; error: { code: string } };
        assert.equal(body.error.code, "session_invalid");
        assert.equal(body.data, undefined);
      }
    });
  } finally {
    fixture.close();
  }
});

function assertNoDetails(value: { data: unknown[] }): void {
  const forbidden = new Set(["payload", "payload_json", "attempts", "events", "event_details",
    "notify_url", "target_url", "token", "checkout_token", "lease_token", "api_secret", "webhook_secret"]);
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key), false, "Overview list responses must omit " + key);
      visit(child);
    }
  };
  visit(value);
  for (const row of value.data) {
    assert.ok(row && typeof row === "object");
    assert.equal(Object.hasOwn(row, "note"), false, "The order's private note belongs only in its detail response");
    for (const key of ["order_summary", "notification_summary"]) {
      const summary: unknown = (row as Record<string, unknown>)[key];
      if (summary && typeof summary === "object") assert.equal(Object.hasOwn(summary, "note"), false);
    }
  }
  assert.equal(JSON.stringify(value).includes(PRIVATE_NOTE), false, "An order note must not leak through a nested payload");
}
