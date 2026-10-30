// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";

import { createPreviewDemo } from "../scripts/preview-demo.ts";
import type {
  AdminLedgerDetail,
  AdminLedgerSummary,
  AdminOrderDetail,
  AdminOrderSummary,
  AdminWorkItem,
  FinancialException,
  LedgerConflict,
  LedgerConflictDetail,
  OrderWebhookDeliveryDetail,
  PaymentMatchDetail,
  PublicCheckoutEnvelope,
  ReconciliationLedgerEntry,
  Site,
  SystemAnalytics,
  WebhookAttempt,
  WebhookDeliveryDetail,
  WebhookDeliverySummary,
} from "../web/src/api/generated/types.gen.ts";

type Page<T> = { data: T[]; page: { next_cursor: string | null } };

function covers(actual: Iterable<string>, expected: readonly string[], label: string) {
  const values = new Set(actual);
  for (const value of expected) assert.ok(values.has(value), `${label} must include ${value}`);
}

function percentile(values: readonly number[], fraction: number): number {
  assert.ok(values.length > 0, "A distribution needs observations");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

function chinaDate(timestamp: number | string): string {
  return new Date((typeof timestamp === "string" ? Date.parse(timestamp) : timestamp) + 8 * 3_600_000).toISOString().slice(0, 10);
}

describe("complete local preview scenarios", () => {
  it("serves coherent evidence, histories, and website scopes without any external fetch", async (context) => {
    const originalFetch = globalThis.fetch;
    let fetchAttempts = 0;
    globalThis.fetch = async () => {
      fetchAttempts++;
      throw new Error("Preview scenario verification must not contact external services");
    };
    let demo: Awaited<ReturnType<typeof createPreviewDemo>> | undefined;
    try {
      demo = await createPreviewDemo({ now: Date.UTC(2026, 9, 8, 6) });
      const preview = demo;
      const login = await preview.app.request(preview.origin + "/api/admin/v1/session/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: preview.origin },
        body: JSON.stringify({ password: preview.password }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const headers = { cookie };
      async function get<T>(path: string): Promise<T> {
        const response = await preview.app.request(path, { headers });
        assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
        assert.match(response.headers.get("x-perpay-demo") ?? "", /read-only/);
        return response.json() as Promise<T>;
      }
      async function data<T>(path: string): Promise<T> {
        return (await get<{ data: T }>(path)).data;
      }
      async function all<T>(path: string): Promise<T[]> {
        const url = new URL(path, preview.origin);
        url.searchParams.set("limit", "100");
        const rows: T[] = [];
        const cursors = new Set<string>();
        for (;;) {
          const page = await get<Page<T>>(url.pathname + url.search);
          rows.push(...page.data);
          const cursor = page.page.next_cursor;
          if (cursor === null) return rows;
          assert.ok(!cursors.has(cursor), `${path} repeated a pagination cursor`);
          assert.ok(cursors.size < 100, `${path} did not finish pagination`);
          cursors.add(cursor);
          url.searchParams.set("cursor", cursor);
        }
      }

      const sites = await data<Site[]>("/api/admin/v1/sites");
      const siteIds = new Set(sites.map(site => site.client_id));
      const orders = await all<AdminOrderSummary>("/api/admin/v1/orders");
      const ordersById = new Map(orders.map(order => [order.order_id, order]));
      const scenarioIds = new Set([
        preview.featured,
        ...Object.values(preview.scenarios.financial.orders),
        ...Object.values(preview.scenarios.notifications.orders),
        ...Object.values(preview.scenarios.lifecycle),
      ]);
      const details: AdminOrderDetail[] = [];
      for (const id of scenarioIds) {
        assert.ok(ordersById.has(id), `Scenario order ${id} must be reachable from the order list`);
        details.push(await data<AdminOrderDetail>("/api/admin/v1/orders/" + id));
      }

      await context.test("website states, lists, and analytics stay consistent across scopes", async () => {
        assert.ok(sites.length >= 6, "Preview must include active, paused, and incomplete website setups");
        assert.equal(ordersById.size, orders.length, "Pagination must not duplicate orders");
        assert.equal(new Set(orders.map(order => order.merchant_order_no)).size, orders.length, "Preview merchant order numbers must be unique");
        for (const order of orders) {
          assert.match(order.merchant_order_no, /^\d{22}$/u, "Merchant order numbers must use numeric business identifiers");
          assert.doesNotMatch(order.product_name, /演示|示例|联调|DEMO-/iu, "Products must use business names rather than scenario labels");
        }
        assert.equal(orders[0]?.order_id, preview.featured, "The first order must demonstrate complete payment and notification evidence");
        for (const id of Object.values(preview.scenarios.sites)) assert.ok(siteIds.has(id));
        assert.ok(sites.some(site => !site.configuration.accepting_orders));
        assert.ok(sites.some(site => site.configuration.notifications_enabled));
        assert.ok(sites.some(site => !site.configuration.notifications_enabled));
        assert.ok(sites.some(site => site.configuration.notification_origin === null));
        assert.ok(sites.some(site => site.configuration.policy.orders.pending_order_limit !== null));
        assert.ok(sites.some(site => !orders.some(order => order.api_client_id === site.client_id)), "An unused site must preserve the empty-state example");
        let created = 0;
        let confirmed = 0;
        let received = 0;
        for (const site of sites) {
          assert.doesNotMatch(site.configuration.name, /演示|示例|联调|DEMO-/iu, "Websites must use business names rather than scenario labels");
          const base = "/api/admin/v1/sites/" + site.client_id;
          const scoped = await all<AdminOrderSummary>(base + "/orders");
          assert.deepEqual(new Set(scoped.map(order => order.order_id)), new Set(orders.filter(order => order.api_client_id === site.client_id).map(order => order.order_id)));
          assert.ok(scoped.every(order => order.api_client_id === site.client_id));
          const analytics = await data<SystemAnalytics>(base + "/system/analytics?range=30");
          created += analytics.orders.created;
          confirmed += analytics.confirmations.count;
          received += analytics.confirmations.amount_cents;
        }
        const analytics = await data<SystemAnalytics>("/api/admin/v1/system/analytics?range=30");
        assert.equal(created, analytics.orders.created);
        assert.equal(confirmed, analytics.confirmations.count);
        assert.equal(received, analytics.confirmations.amount_cents);
        assert.equal(analytics.daily.reduce((sum, day) => sum + day.orders_created, 0), analytics.orders.created);
        assert.equal(analytics.daily.reduce((sum, day) => sum + day.confirmed_amount_cents, 0), analytics.confirmations.amount_cents);
      });

      await context.test("7, 30, and 90 day revenue trends reflect distributed business history", async (trend) => {
        const ranges = new Map<number, SystemAnalytics>();
        for (const range of [7, 30, 90]) {
          const analytics = await data<SystemAnalytics>("/api/admin/v1/system/analytics?range=" + range);
          ranges.set(range, analytics);
          assert.equal(analytics.range_days, range);
          assert.equal(analytics.daily.length, range);
          assert.equal(new Set(analytics.daily.map(day => day.date)).size, range);
          assert.equal(analytics.daily.at(-1)?.date, chinaDate(preview.capturedAt));
          assert.equal(analytics.daily.reduce((sum, day) => sum + day.orders_created, 0), analytics.orders.created);
          assert.equal(analytics.daily.reduce((sum, day) => sum + day.confirmations, 0), analytics.confirmations.count);
          assert.equal(analytics.daily.reduce((sum, day) => sum + day.confirmed_amount_cents, 0), analytics.confirmations.amount_cents);
          assert.equal(analytics.daily.reduce((sum, day) => sum + day.notifications_acknowledged, 0), analytics.notifications.acknowledged);
          assert.equal(analytics.daily.reduce((sum, day) => sum + day.notifications_failed, 0), analytics.notifications.failed);
          const from = Date.parse(analytics.from), to = Date.parse(analytics.to);
          const listed = orders.filter(order => Date.parse(order.created_at) >= from && Date.parse(order.created_at) < to);
          assert.equal(listed.length, analytics.orders.created, "Trend order counts must describe real listed orders");
        }
        const week = ranges.get(7)!, month = ranges.get(30)!, quarter = ranges.get(90)!;
        assert.deepEqual(week.daily, month.daily.slice(-7));
        assert.deepEqual(month.daily, quarter.daily.slice(-30));
        assert.deepEqual(week.pending, quarter.pending, "Current pending work is independent of the historical date filter");

        const scenarioDates = new Set(details.map(order => chinaDate(order.created_at)));
        const confirmationEvents = details.flatMap(order => order.events.filter(event => event.event_type === "PAYMENT_CONFIRMED"));
        const confirmationDates = new Set(confirmationEvents.map(event => chinaDate(event.occurred_at)));
        assert.ok(scenarioDates.size >= 10, "Named examples must be distributed across at least ten dates");
        assert.ok(confirmationDates.size >= 10, "Distribute actual receipt confirmations as well as order creation dates");
        assert.ok(orders.every(order => Date.parse(order.created_at) <= preview.capturedAt), "The current day must not contain orders from future hours");
        assert.ok(orders.every(order => order.payment_confirmed_at == null || Date.parse(order.payment_confirmed_at) <= preview.capturedAt), "Listed receipt confirmations must already have occurred");
        assert.ok(confirmationEvents.every(event => Date.parse(event.occurred_at) <= preview.capturedAt), "The current day must not contain future receipt confirmations");

        const today = month.daily.at(-1)!;
        const completedDays = month.daily.slice(0, -1);
        const medianRevenue = percentile(completedDays.map(day => day.confirmed_amount_cents), 0.5);
        const medianOrders = percentile(completedDays.map(day => day.orders_created), 0.5);
        assert.ok(medianRevenue > 0 && medianOrders > 0);
        // These bounds allow substantial daily variation and historical large
        // purchases. They reject the former fixture with every exceptional
        // payment on its final day, which overwhelmed the normal trend.
        assert.ok(today.confirmed_amount_cents <= medianRevenue * 3,
          `Today's receipts (${today.confirmed_amount_cents}) dominate the typical completed day (${medianRevenue})`);
        assert.ok(today.orders_created <= medianOrders * 2.5,
          `Today's order count (${today.orders_created}) dominates the typical completed day (${medianOrders})`);
        assert.ok(today.confirmed_amount_cents <= month.confirmations.amount_cents * 0.20, "The current day must not account for over one fifth of the month's receipts");
        assert.ok(today.orders_created <= month.orders.created * 0.12, "The current day must not account for over twelve percent of the month's orders");

        const olderDays = quarter.daily.slice(0, 60);
        assert.ok(quarter.daily.filter(day => day.orders_created > 0).length >= 75, "The 90 day view needs a usable business history");
        assert.ok(olderDays.filter(day => day.orders_created > 0).length >= 45, "Older history must not consist of empty placeholders before the recent examples");
        let emptyRun = 0;
        for (const day of quarter.daily) {
          emptyRun = day.orders_created === 0 ? emptyRun + 1 : 0;
          assert.ok(emptyRun <= 7, "The 90 day history must not contain an artificial multi-week empty block");
        }

        // Assess ordinary trading days separately from exceptional examples;
        // a real large purchase should not determine normal basket variation.
        const ordinary = olderDays.filter(day => day.confirmations > 0);
        assert.ok(ordinary.length >= 40);
        const revenues = ordinary.map(day => day.confirmed_amount_cents);
        const baskets = ordinary.map(day => day.confirmed_amount_cents / day.confirmations);
        assert.ok(percentile(revenues, 0.1) > 0 && percentile(baskets, 0.1) > 0, "Ordinary confirmed receipts must retain positive amounts");
        const revenueSpread = percentile(revenues, 0.9) / percentile(revenues, 0.1);
        const basketSpread = percentile(baskets, 0.9) / percentile(baskets, 0.1);
        assert.ok(new Set(ordinary.map(day => day.orders_created)).size >= 4, "Ordinary days should not repeat one fixed order count");
        assert.ok(revenueSpread >= 1.25, "Ordinary daily income should vary with business activity");
        assert.ok(basketSpread >= 1.10, "Ordinary average order values should reflect different baskets");
        trend.diagnostic(JSON.stringify({
          named_order_dates: scenarioDates.size,
          named_confirmation_dates: confirmationDates.size,
          active_days_in_90: quarter.daily.filter(day => day.orders_created > 0).length,
          today_receipts_cents: today.confirmed_amount_cents,
          completed_day_median_receipts_cents: medianRevenue,
          today_orders: today.orders_created,
          completed_day_median_orders: medianOrders,
          ordinary_revenue_p90_p10: Number(revenueSpread.toFixed(2)),
          ordinary_basket_p90_p10: Number(basketSpread.toFixed(2)),
        }));
      });

      await context.test("orders expose actual payment evidence, reversals, and refund-mark history", async () => {
        covers(details.map(order => order.checkout.status), ["OPEN", "CLOSED", "EXPIRED"], "Checkout lifecycle");
        covers(details.map(order => order.payment.status), ["UNPAID", "CONFIRMED", "DISPUTED"], "Payment lifecycle");
        covers(details.map(order => order.payment.basis), ["NONE", "INFERRED", "MANUAL"], "Payment basis");
        const matches = details.flatMap(order => order.reconciliation.matches);
        covers(matches.map(match => match.status), ["SETTLED", "REVERSED"], "Payment evidence history");
        covers(matches.map(match => match.evidence_type), ["AMOUNT_INFERRED", "MANUAL"], "Payment evidence type");
        assert.ok(details.some(order => order.payment.status === "CONFIRMED" && order.received_amount_cents! < order.payable_amount_cents), "Include a manually confirmed short payment");
        assert.ok(details.some(order => order.payment.status === "CONFIRMED" && order.received_amount_cents! > order.payable_amount_cents), "Include a manually confirmed excess payment");
        assert.ok(details.some(order => order.payable_amount_cents !== order.requested_amount_cents), "Include a reserved amount offset");
        const marked = details.find(order => order.refund_mark.marked);
        const cleared = details.find(order => !order.refund_mark.marked && order.refund_mark_history.some(event => event.marked));
        assert.ok(marked, "Include a current administrator refund mark");
        assert.ok(cleared, "Include a removed refund mark with retained history");
        assert.ok(cleared.refund_mark_history.some(event => !event.marked));
        assert.equal(marked.payment.status, "CONFIRMED");
        assert.equal(marked.refund.status, "NONE", "An administrator mark is separate from legacy financial refund records");
        for (const order of details) {
          const base = "/api/admin/v1/sites/" + order.api_client_id;
          assert.deepEqual(await data<AdminOrderDetail>(base + "/orders/" + order.order_id), order);
          const foreign = sites.find(site => site.client_id !== order.api_client_id)!;
          assert.equal((await preview.app.request("/api/admin/v1/sites/" + foreign.client_id + "/orders/" + order.order_id, { headers })).status, 404);
          const active = order.reconciliation.matches.filter(match => match.status === "SETTLED");
          if (order.payment.status === "CONFIRMED") {
            assert.equal(active.length, 1, order.product_name + " must have one active payment basis");
            assert.equal(active[0]!.ledger_entry.amount_cents, order.received_amount_cents);
            assert.equal(order.payment.received_amount_cents, order.received_amount_cents);
            assert.ok(order.events.some(event => event.event_type === "PAYMENT_CONFIRMED"));
          }
          if (order.payment.status === "DISPUTED") assert.ok(order.events.some(event => event.event_type === "PAYMENT_DISPUTED"));
          for (const match of order.reconciliation.matches) {
            assert.equal(match.order_id, order.order_id);
            assert.equal(match.ledger_entry.ledger_entry_id, match.ledger_entry_id);
            assert.equal(match.order.order_id, order.order_id);
            assert.equal(match.creation_operation.order_id, order.order_id);
            assert.equal(match.creation_operation.ledger_entry_id, match.ledger_entry_id);
            assert.deepEqual(await data<PaymentMatchDetail>(base + "/reconciliation/matches/" + match.payment_match_id), match);
            if (match.evidence_type === "AMOUNT_INFERRED") {
              assert.ok(match.candidate);
              assert.equal(match.candidate.order_id, order.order_id);
              assert.equal(match.candidate.ledger_entry_id, match.ledger_entry_id);
              assert.equal(match.creation_operation.operation_type, "AUTO_SETTLEMENT");
            } else {
              assert.equal(match.creation_operation.operation_type, "MANUAL_SETTLEMENT");
              assert.equal(match.creation_operation.actor_type, "ADMIN");
            }
            if (match.status === "REVERSED") assert.equal(match.resolution_operation?.operation_type, "REVERSE_SETTLEMENT");
          }
        }
        const featured = details.find(order => order.order_id === preview.featured)!;
        assert.equal(featured.payment.status, "CONFIRMED");
        assert.ok(featured.reconciliation.matches.some(match => match.status === "SETTLED"));
        const deliveries = await all<OrderWebhookDeliveryDetail>("/api/admin/v1/orders/" + featured.order_id + "/notifications/deliveries");
        assert.ok(deliveries.some(item => item.delivery.status === "ACKNOWLEDGED" && item.attempts.some(attempt => attempt.outcome === "ACKNOWLEDGED")), "Featured order must show both payment and business-notification evidence");
      });

      await context.test("public checkouts retain every reachable business state and safe empty states", async () => {
        // Public checkout tokens have a finite observation window. Exercise the
        // deliberately recent examples, not an arbitrary month-old history row.
        const examples = { UNPAID: preview.scenarios.lifecycle.open, CONFIRMED: preview.featured,
          DISPUTED: preview.scenarios.lifecycle.disputed, CLOSED: preview.scenarios.lifecycle.closed,
          EXPIRED: preview.scenarios.lifecycle.expired };
        for (const [expected, orderId] of Object.entries(examples)) {
          const order = details.find(order => order.order_id === orderId);
          assert.ok(order, "Missing public checkout example: " + expected);
          assert.equal(order.payment.status === "UNPAID" && order.checkout.status !== "OPEN" ? order.checkout.status : order.payment.status, expected);
          const redirect = await preview.app.request("/api/admin/v1/orders/" + order.order_id + "/checkout", { headers });
          assert.equal(redirect.status, 302);
          const location = redirect.headers.get("location");
          assert.ok(location);
          assert.ok(location.startsWith("/checkout/"));
          const token = location.slice("/checkout/".length);
          const checkout = await data<PublicCheckoutEnvelope["data"]>("/api/public/v1/checkouts/" + token);
          assert.equal(checkout.merchant_order_no, order.merchant_order_no);
          assert.deepEqual(checkout.payment, order.payment);
          assert.equal(checkout.checkout.status, order.checkout.status);
          if (expected === "UNPAID") assert.equal(checkout.payment_instructions?.payable_amount_cents, order.payable_amount_cents);
          else assert.equal(checkout.payment_instructions, null);
          for (const privateField of ["order_id", "api_client_id", "reconciliation", "refund_mark", "checkout_token"]) assert.ok(!(privateField in checkout));
        }
        const noNotification = details.find(order => order.notification.notify_url === null);
        assert.ok(noNotification, "Include an order with no callback configured");
        assert.deepEqual(await all<OrderWebhookDeliveryDetail>("/api/admin/v1/orders/" + noNotification.order_id + "/notifications/deliveries"), []);
        assert.ok(details.some(order => order.payment.status === "UNPAID" && order.reconciliation.matches.length === 0), "Unpaid orders must keep the genuine no-payment-evidence state");
      });

      await context.test("notification examples include all attempts and linked redelivery generations", async () => {
        const deliveries: Array<WebhookDeliveryDetail & { attempts: WebhookAttempt[] }> = [];
        for (const id of new Set(Object.values(preview.scenarios.notifications.deliveries))) {
          const detail = await data<WebhookDeliveryDetail>("/api/admin/v1/webhooks/deliveries/" + id);
          const attempts = await data<WebhookAttempt[]>("/api/admin/v1/webhooks/deliveries/" + id + "/attempts");
          const order = ordersById.get(detail.event.order_id);
          assert.ok(order);
          assert.equal(detail.event.payload.merchant_order_no, order.merchant_order_no);
          assert.equal(detail.target.order_id, order.order_id);
          assert.equal(detail.target.api_client_id, order.api_client_id);
          assert.equal(detail.event.payload.order_id, order.order_id);
          assert.equal(detail.event.payload.event_id, detail.event.event_id);
          assert.equal(detail.delivery.event_id, detail.event.event_id);
          assert.equal(detail.delivery.attempt_count, attempts.length);
          if (detail.delivery.status === "PENDING") assert.equal(attempts.length, 0);
          if (detail.delivery.status === "LEASED") {
            assert.ok(detail.delivery.lease_expires_at);
            assert.equal(attempts.at(-1)?.outcome, "STARTED");
            assert.equal(attempts.at(-1)?.finished_at, null);
          }
          if (detail.delivery.status === "RETRY_WAIT") {
            assert.ok(detail.delivery.next_attempt_at);
            assert.ok(Date.parse(detail.delivery.next_attempt_at) > preview.capturedAt);
            assert.ok(detail.delivery.last_error_code);
          }
          if (detail.delivery.status === "DEAD_LETTER") assert.ok(detail.delivery.dead_lettered_at);
          if (detail.delivery.status === "ACKNOWLEDGED") {
            assert.ok(detail.delivery.acknowledged_at);
            assert.equal(attempts.at(-1)?.outcome, "ACKNOWLEDGED");
          }
          for (const attempt of attempts) {
            assert.equal(attempt.delivery_id, id);
            assert.ok(attempt.key_version > 0);
            assert.match(attempt.request_body_fingerprint, /^[0-9a-f]{64}$/);
            assert.ok(!("lease_token" in attempt));
          }
          const base = "/api/admin/v1/sites/" + order.api_client_id;
          assert.deepEqual(await data<WebhookDeliveryDetail>(base + "/webhooks/deliveries/" + id), detail);
          const orderDeliveries = await all<OrderWebhookDeliveryDetail>(base + "/orders/" + order.order_id + "/notifications/deliveries");
          const embedded = orderDeliveries.find(item => item.delivery.delivery_id === id);
          assert.ok(embedded);
          assert.deepEqual(embedded.attempts, attempts);
          if (detail.delivery.predecessor_delivery_id) {
            const predecessor = await data<WebhookDeliveryDetail>("/api/admin/v1/webhooks/deliveries/" + detail.delivery.predecessor_delivery_id);
            assert.equal(predecessor.event.event_id, detail.event.event_id);
            assert.equal(predecessor.delivery.generation + 1, detail.delivery.generation);
            assert.equal(predecessor.is_latest, false);
          }
          deliveries.push({ ...detail, attempts });
        }
        covers(deliveries.map(item => item.delivery.status), ["PENDING", "LEASED", "RETRY_WAIT", "ACKNOWLEDGED", "DEAD_LETTER"], "Notification delivery statuses");
        covers(deliveries.flatMap(item => item.attempts.map(attempt => attempt.outcome)), ["STARTED", "ACKNOWLEDGED", "RETRYABLE_FAILURE", "PERMANENT_FAILURE", "OUTCOME_UNKNOWN"], "Notification attempt outcomes");
        assert.ok(deliveries.some(item => item.delivery.status === "ACKNOWLEDGED" && item.delivery.attempt_count > 1), "Include retry then success");
        assert.ok(deliveries.some(item => item.delivery.predecessor_delivery_id && item.delivery.status === "ACKNOWLEDGED"), "Include administrator redelivery then success");
        assert.ok(deliveries.some(item => item.delivery.status === "DEAD_LETTER" && item.attempts.some(attempt => attempt.http_status === 200 && attempt.outcome !== "ACKNOWLEDGED")), "Include HTTP success with an invalid business acknowledgement");
        const unmaterializedId = preview.scenarios.notifications.orders.unmaterialized;
        assert.ok(unmaterializedId);
        const unmaterialized = details.find(order => order.order_id === unmaterializedId)!;
        assert.equal(unmaterialized.payment.status, "CONFIRMED");
        assert.ok(unmaterialized.notification.notify_url);
        assert.deepEqual(await all<OrderWebhookDeliveryDetail>("/api/admin/v1/orders/" + unmaterializedId + "/notifications/deliveries"), [], "A configured callback awaiting materialization must retain the real empty state");
        const global = await all<WebhookDeliverySummary>("/api/admin/v1/webhooks/deliveries");
        for (const item of deliveries) assert.ok(global.some(row => row.delivery_id === item.delivery.delivery_id));
      });

      await context.test("global ledger browsing groups historical sources and preserves real payment evidence", async () => {
        const changes = () => Number(preview.database.read(connection => connection.prepare("SELECT total_changes() AS n").get()!.n));
        const before = changes();
        const entries = await all<AdminLedgerSummary>("/api/admin/v1/ledger/entries");
        const identities = entries.map(entry => entry.external_event_id);
        assert.equal(new Set(identities).size, entries.length, "A provider event must occur once across all pages");
        const expected = preview.database.read(connection => connection.prepare(
          "SELECT DISTINCT entry.external_event_id FROM ledger_entries entry JOIN provider_account_bindings binding USING (provider_account_key) WHERE binding.provider_endpoint = ?",
        ).all("https://openapi-sandbox.dl.alipaydev.com"));
        assert.deepEqual(new Set(identities), new Set(expected.map(row => String(row.external_event_id))));
        covers(entries.flatMap(entry => entry.states), ["UNALLOCATED", "ALLOCATED", "CONFLICT"], "Global ledger states");
        covers(entries.map(entry => entry.direction ?? "DISPUTED"), ["CREDIT", "DEBIT"], "Global ledger directions");
        assert.ok(entries.every(entry => entry.environment === "SANDBOX"));

        const duplicate = await data<AdminLedgerDetail>("/api/admin/v1/ledger/entries/" + preview.scenarios.ledger.identical);
        assert.equal(duplicate.content_consistent, true);
        assert.equal(duplicate.source_record_count, 2);
        assert.equal(duplicate.active_match_count, 0);
        assert.equal(duplicate.active_match, null);
        assert.equal(duplicate.ledger_entry_id, preview.scenarios.ledger.identical,
          "a native account binding must not displace the earlier historical source anchor");
        assert.deepEqual(new Set(duplicate.sources.map(source => source.ledger_entry_id)),
          new Set([preview.scenarios.ledger.identical, preview.scenarios.ledger.identicalCopy]));
        assert.equal(new Set(duplicate.sources.map(source => source.semantic_fingerprint)).size, 1);
        const alias = await data<AdminLedgerDetail>("/api/admin/v1/ledger/entries/" + preview.scenarios.ledger.identicalCopy);
        assert.deepEqual(alias, duplicate, "An original source ID must open the complete event group");
        const paid = entries.find(entry => entry.active_match?.order_id === preview.featured);
        assert.ok(paid?.active_match, "The actual featured receipt must keep its order association");
        const paidDetail = await data<AdminLedgerDetail>("/api/admin/v1/ledger/entries/" + paid.ledger_entry_id);
        assert.ok(paidDetail.sources.some(source => source.ledger_entry_id === paid.active_match!.ledger_entry_id));
        assert.ok(paidDetail.matches.some(match => match.payment_match_id === paid.active_match!.payment_match_id));

        const inconsistent = await data<AdminLedgerDetail>("/api/admin/v1/ledger/entries/" + preview.scenarios.ledger.inconsistent);
        assert.equal(inconsistent.content_consistent, false);
        assert.equal(inconsistent.has_conflicts, true);
        assert.equal(inconsistent.amount_cents, null, "Conflicting amounts are never selected or added");
        assert.equal(inconsistent.source_record_count, 2);
        assert.equal(new Set(inconsistent.sources.map(source => source.amount_cents)).size, 2);
        assert.equal(inconsistent.active_match_count, 0);
        const query = await all<AdminLedgerSummary>("/api/admin/v1/ledger/entries?q=" + encodeURIComponent(inconsistent.external_event_id));
        assert.equal(query.length, 1);
        assert.equal(query[0]!.source_record_count, 2);
        for (const entryId of [preview.scenarios.financial.entries.disputedInferred!, preview.scenarios.financial.entries.disputedManual!]) {
          const detail = await data<AdminLedgerDetail>("/api/admin/v1/ledger/entries/" + entryId);
          assert.ok(detail.matches.some(match => match.status === "REVERSED"), "Reversed payment evidence must stay visible");
        }
        assert.equal(changes(), before, "Ledger reads must not mutate financial or collection data");
      });

      await context.test("financial exceptions, ledger conflicts, and reminder history have durable evidence", async () => {
        const exceptions: FinancialException[] = [];
        for (const id of new Set(Object.values(preview.scenarios.financial.exceptions))) {
          const exception = await data<FinancialException>("/api/admin/v1/reconciliation/exceptions/" + id);
          assert.equal(exception.exception_id, id);
          if (exception.order_id) {
            const order = ordersById.get(exception.order_id);
            assert.ok(order);
            assert.deepEqual(await data<FinancialException>("/api/admin/v1/sites/" + order.api_client_id + "/reconciliation/exceptions/" + id), exception);
          }
          if (exception.status === "RESOLVED") {
            assert.ok(exception.resolution_operation_id);
            assert.ok(exception.resolved_at);
          }
          exceptions.push(exception);
        }
        covers(exceptions.map(exception => exception.exception_type), ["UNMATCHED_CREDIT", "AMOUNT_MISMATCH", "CHECKOUT_ENDED_PAYMENT", "DUPLICATE_PAYMENT", "RECONCILIATION_CONFLICT"], "Financial exceptions");
        covers(exceptions.map(exception => exception.status), ["OPEN", "RESOLVED"], "Financial exception resolution");
        const conflicts = await all<LedgerConflict>("/api/admin/v1/ledger/conflicts?status=ALL");
        covers(conflicts.map(conflict => conflict.conflict_type), ["RAW_PAGE_VARIANT", "DUPLICATE_EXTERNAL_ID", "MISSING_EXTERNAL_ID", "INVALID_AMOUNT", "INVALID_TIMESTAMP", "INVALID_DIRECTION", "INVALID_SHAPE"], "Ledger conflict evidence");
        covers(conflicts.map(conflict => conflict.status), ["OPEN", "RESOLVED", "IGNORED"], "Ledger conflict resolution");
        for (const id of new Set(Object.values(preview.scenarios.financial.conflicts))) {
          const detail = await data<LedgerConflictDetail>("/api/admin/v1/ledger/conflicts/" + id);
          assert.equal(detail.conflict.conflict_id, id);
          assert.ok(conflicts.some(conflict => conflict.conflict_id === id));
          assert.ok(detail.raw_page, "Conflicts must preserve synthetic ingestion evidence");
          if (detail.conflict.status !== "OPEN") assert.ok(detail.resolution_operation);
        }
        const entries: ReconciliationLedgerEntry[] = [];
        for (const id of new Set(Object.values(preview.scenarios.financial.entries))) {
          const entry = await data<ReconciliationLedgerEntry>("/api/admin/v1/reconciliation/ledger-entries/" + id);
          assert.equal(entry.ledger_entry_id, id);
          entries.push(entry);
        }
        covers(entries.map(entry => entry.direction), ["CREDIT", "DEBIT"], "Ledger directions");
        const active = await all<AdminWorkItem>("/api/admin/v1/work-items?visibility=ACTIVE");
        const ignored = await all<AdminWorkItem>("/api/admin/v1/work-items?visibility=IGNORED");
        covers(active.map(item => item.type), ["FINANCIAL_EXCEPTION", "LEDGER_CONFLICT", "NOTIFICATION_FAILURE"], "Active reminder categories");
        assert.ok(active.every(item => item.ignored_at === null && !item.ended));
        assert.ok(ignored.some(item => !item.ended), "Include a hidden but unresolved reminder");
        assert.ok(ignored.some(item => item.ended), "Keep ignored history after a resource is resolved");
        assert.ok(ignored.every(item => item.ignored_at !== null && item.ignored_by !== null));
        assert.ok(ignored.every(item => !active.some(current => current.type === item.type && current.resource_id === item.resource_id)));
        for (const item of active.filter(item => item.type === "NOTIFICATION_FAILURE")) {
          assert.equal((await data<WebhookDeliveryDetail>("/api/admin/v1/webhooks/deliveries/" + item.resource_id)).is_latest, true, "Replayed historical failures must not reappear as active reminders");
        }
        assert.equal((await data<{ total: number }>("/api/admin/v1/work-items/summary")).total, active.length);
        for (const site of sites) {
          const base = "/api/admin/v1/sites/" + site.client_id;
          const scoped = await all<AdminWorkItem>(base + "/work-items");
          const expected = active.filter(item => item.order_id !== null && ordersById.get(item.order_id)?.api_client_id === site.client_id);
          assert.deepEqual(new Set(scoped.map(item => item.type + ":" + item.resource_id)), new Set(expected.map(item => item.type + ":" + item.resource_id)));
          assert.equal((await data<{ total: number }>(base + "/work-items/summary")).total, scoped.length);
        }
      });

      const integrity = preview.database.integrityCheck();
      assert.equal(integrity.ok, true, JSON.stringify(integrity));
      assert.equal(fetchAttempts, 0, "Scenario seeding and every preview read must stay offline");
    } finally {
      globalThis.fetch = originalFetch;
      demo?.dispose();
    }
    assert.ok(demo);
    assert.equal(existsSync(demo.directory), false);
  });
});
