import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { AppDatabase } from "../src/database/database.ts";
import { siteOverview } from "../src/http/site-overview.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

const DAY_MILLISECONDS = 86_400_000;

describe("website overview period and global amount scale", () => {
  for (const { days, firstDate } of [
    { days: 7, firstDate: "2026-01-10" },
    { days: 30, firstDate: "2025-12-18" },
    { days: 90, firstDate: "2025-10-19" },
  ]) {
    it(`returns a ${days}-day Shanghai period with exclusive event boundaries and isolated totals`, () => {
      withFixture((database, connection) => {
        const now = Date.parse("2026-01-16T00:00:00+08:00");
        const end = Date.parse("2026-01-17T00:00:00+08:00");
        const start = end - days * DAY_MILLISECONDS;
        addSite(connection, "alpha", "Alpha");
        addSite(connection, "beta", "Beta", { acceptingOrders: false });
        addSite(connection, "empty", "Empty");
        addSite(connection, "deleted", "Deleted", { deletedAt: now });

        const records = [
          { timestamp: start - 1, amount: 10000 },
          { timestamp: start, amount: 20 },
          { timestamp: now - 1, amount: 30 },
          { timestamp: now, amount: 40 },
          { timestamp: end - 1, amount: 50 },
          { timestamp: end, amount: 20000 },
        ];
        for (const [index, record] of records.entries()) {
          addConfirmation(connection, "alpha", `alpha-${index}`, record.timestamp, record.amount, start - DAY_MILLISECONDS);
        }
        addConfirmation(connection, "beta", "beta-start", start, 500);
        addConfirmation(connection, "beta", "beta-today", now, 999);
        addConfirmation(connection, "deleted", "deleted-today", now, 777777);
        connection.prepare("INSERT INTO order_events VALUES (?, 'CHECKOUT_CLOSED', ?)").run("alpha-0", now);
        connection.prepare(`
          INSERT INTO payment_orders(order_id, api_client_id, created_at, expires_at, checkout_status, payment_status)
          VALUES ('pending-alpha', 'alpha', ?, ?, 'OPEN', 'UNPAID'),
                 ('expired-alpha', 'alpha', ?, ?, 'EXPIRED', 'UNPAID')
        `).run(start - DAY_MILLISECONDS, now + 1, start - DAY_MILLISECONDS, now - 1);
        connection.prepare(`
          INSERT INTO financial_exceptions(exception_id, order_id, created_at, status)
          VALUES ('active-alpha', 'pending-alpha', ?, 'OPEN'),
                 ('ignored-alpha', 'pending-alpha', ?, 'OPEN'),
                 ('resolved-alpha', 'pending-alpha', ?, 'RESOLVED'),
                 ('active-beta', 'beta-today', ?, 'OPEN'),
                 ('unassigned', NULL, ?, 'OPEN')
        `).run(start - 1, start - 1, start - 1, start - 1, start - 1);
        connection.exec(`
          INSERT INTO admin_work_item_states(kind, item_id, ignored)
          VALUES ('FINANCIAL_EXCEPTION', 'ignored-alpha', 1);
          INSERT INTO ledger_conflicts(conflict_id, status) VALUES ('global-conflict', 'OPEN');
        `);

        const result = siteOverview(database, new URLSearchParams({ range: String(days) }), now);
        assert.deepEqual(result.period, { from: firstDate, to: "2026-01-16" });
        assert.equal(result.max_confirmed_amount_cents, 1499);
        assert.deepEqual(result.data.map(site => site.client_id), ["alpha", "beta", "empty"]);
        assert.equal(result.page.next_cursor, null);
        const [alpha, beta, empty] = result.data;
        assert.ok(alpha && beta && empty);
        assert.equal(alpha.confirmed_count, 4);
        assert.equal(alpha.confirmed_amount_cents, 140);
        assert.equal(alpha.pending_orders, 1);
        assert.equal(alpha.work_items, 1);
        assert.equal(beta.confirmed_count, 2);
        assert.equal(beta.confirmed_amount_cents, 1499);
        assert.equal(beta.accepting_orders, false);
        assert.equal(beta.notifications_enabled, false);
        assert.equal(beta.pending_orders, 0);
        assert.equal(beta.work_items, 1);
        assert.equal(empty.confirmed_count, 0);
        assert.equal(empty.confirmed_amount_cents, 0);
        assert.equal(empty.pending_orders, 0);
        assert.equal(empty.work_items, 0);
        assert.ok(result.data.every(site => !("daily" in site)));
      });
    });
  }

  it("returns the period on empty pages across Shanghai midnight, year and leap-day boundaries", () => {
    withFixture((database) => {
      for (const boundary of [
        { now: "2025-12-31T15:59:59.999Z", first: "2025-12-25", last: "2025-12-31" },
        { now: "2025-12-31T16:00:00.000Z", first: "2025-12-26", last: "2026-01-01" },
        { now: "2028-02-28T16:00:00.000Z", first: "2028-02-23", last: "2028-02-29" },
      ]) {
        const result = siteOverview(database, new URLSearchParams("range=7"), Date.parse(boundary.now));
        assert.deepEqual(result.period, { from: boundary.first, to: boundary.last });
        assert.equal(result.max_confirmed_amount_cents, 0);
        assert.deepEqual(result.data, []);
        assert.equal(result.page.next_cursor, null);
      }
      assert.deepEqual(siteOverview(database, new URLSearchParams(), Date.parse("2026-01-16T00:00:00+08:00")).period, { from: "2025-12-18", to: "2026-01-16" });
    });
  });

  it("returns zero for sites without receipts even when a deleted site has receipts", () => {
    withFixture((database, connection) => {
      const now = Date.parse("2026-01-16T12:00:00+08:00");
      addSite(connection, "empty", "Empty");
      addSite(connection, "deleted", "Deleted", { deletedAt: now });
      addConfirmation(connection, "deleted", "deleted-order", now, 999999);

      const result = siteOverview(database, new URLSearchParams("range=7"), now);
      assert.equal(result.max_confirmed_amount_cents, 0);
      assert.deepEqual(result.period, { from: "2026-01-10", to: "2026-01-16" });
      assert.equal(result.data.length, 1);
      assert.equal(result.data[0]!.confirmed_count, 0);
      assert.equal(result.data[0]!.confirmed_amount_cents, 0);
    });
  });

  it("reports the actual period and maximum when a cursor is used across Shanghai midnight", () => {
    withFixture((database, connection) => {
      const before = Date.parse("2026-01-16T23:59:59.999+08:00");
      const after = before + 1;
      addSite(connection, "alpha", "Alpha");
      addSite(connection, "beta", "Beta");
      addConfirmation(connection, "alpha", "leaving-period", Date.parse("2026-01-10T00:00:00+08:00"), 5000);
      addConfirmation(connection, "beta", "still-in-period", Date.parse("2026-01-16T12:00:00+08:00"), 200);
      addConfirmation(connection, "beta", "entering-period", after, 900);

      const first = siteOverview(database, new URLSearchParams("range=7&limit=1"), before);
      assert.ok(first.page.next_cursor);
      assert.deepEqual(first.period, { from: "2026-01-10", to: "2026-01-16" });
      assert.equal(first.max_confirmed_amount_cents, 5000);
      assert.equal(first.data[0]!.confirmed_amount_cents, 5000);
      const nextQuery = new URLSearchParams({ range: "7", limit: "1", cursor: first.page.next_cursor });
      const sameDay = siteOverview(database, nextQuery, before);
      assert.deepEqual(sameDay.period, first.period);
      assert.equal(sameDay.max_confirmed_amount_cents, first.max_confirmed_amount_cents);
      assert.equal(sameDay.data[0]!.confirmed_amount_cents, 200);

      const nextDay = siteOverview(database, nextQuery, after);
      assert.deepEqual(nextDay.period, { from: "2026-01-11", to: "2026-01-17" });
      assert.notDeepEqual(nextDay.period, first.period);
      assert.equal(nextDay.data[0]!.client_id, "beta");
      assert.equal(nextDay.data[0]!.confirmed_amount_cents, 1100);
      assert.equal(nextDay.max_confirmed_amount_cents, 1100);
      assert.equal(nextDay.page.next_cursor, null);
    });
  });

  it("executes five SQL statements and shares the global maximum across ranges, searches and pages", (t) => {
    withFixture((database, connection) => {
      const now = Date.parse("2026-01-16T12:00:00+08:00");
      const clientIds = Array.from({ length: 24 }, (_, index) => `site-${String(index).padStart(3, "0")}`);
      for (const [index, clientId] of clientIds.entries()) {
        addSite(connection, clientId, `Batch ${index}`);
        addConfirmation(connection, clientId, `order-${index}`, now, (index + 1) * 100);
      }
      addSite(connection, "zz-maximum", "Hidden", { acceptingOrders: false });
      addConfirmation(connection, "zz-maximum", "hidden-first", now, 700000);
      addConfirmation(connection, "zz-maximum", "hidden-second", now, 400000);
      addSite(connection, "zz-deleted", "Deleted", { deletedAt: now });
      addConfirmation(connection, "zz-deleted", "deleted-order", now, 9999999);

      const prepared: string[] = [];
      const executed: string[] = [];
      const prepare = connection.prepare.bind(connection);
      t.mock.method(connection, "prepare", (sql: string) => {
        prepared.push(sql);
        const statement = prepare(sql);
        for (const method of ["all", "get", "iterate", "run"] as const) {
          const execute = statement[method];
          t.mock.method(statement, method, (...parameters: unknown[]) => {
            executed.push(sql);
            return Reflect.apply(execute, statement, parameters);
          });
        }
        return statement;
      });

      const readPage = (query: string, expectedSites: number, days: number) => {
        prepared.length = 0;
        executed.length = 0;
        const result = siteOverview(database, new URLSearchParams(query), now);
        assert.equal(result.data.length, expectedSites);
        assert.equal(prepared.length, 5);
        assert.equal(executed.length, 5);
        assert.deepEqual(executed, prepared);
        assert.equal(Date.parse(result.period.to) - Date.parse(result.period.from), (days - 1) * DAY_MILLISECONDS);
        assert.equal(result.period.to, "2026-01-16");
        assert.equal(result.max_confirmed_amount_cents, 1100000);
        for (const site of result.data) {
          const index = clientIds.indexOf(site.client_id);
          assert.notEqual(index, -1);
          assert.equal(site.confirmed_count, 1);
          assert.equal(site.confirmed_amount_cents, (index + 1) * 100);
        }
        return result;
      };

      for (const days of [7, 30, 90]) {
        readPage(`range=${days}&limit=1`, 1, days);
        for (const limit of [1, 10, 100]) {
          readPage(`q=Batch&range=${days}&limit=${limit}`, Math.min(limit, clientIds.length), days);
        }
      }
      const first = readPage("q=Batch&range=30&limit=10", 10, 30);
      assert.ok(first.page.next_cursor);
      const second = readPage(`q=Batch&range=30&limit=10&cursor=${encodeURIComponent(first.page.next_cursor)}`, 10, 30);
      assert.ok(second.page.next_cursor);
      const last = readPage(`q=Batch&range=30&limit=10&cursor=${encodeURIComponent(second.page.next_cursor)}`, 4, 30);
      assert.deepEqual(second.period, first.period);
      assert.deepEqual(last.period, first.period);
      assert.equal(last.page.next_cursor, null);
      assert.deepEqual([...first.data, ...second.data, ...last.data].map(site => site.client_id), clientIds);
      const noMatches = readPage("q=missing&range=7", 0, 7);
      assert.equal(noMatches.page.next_cursor, null);
      readPage("q=Deleted&range=7", 0, 7);

      for (const query of ["q=Batch&range=7", "q=Hidden&range=30"]) {
        assert.throws(() => siteOverview(database, new URLSearchParams(`${query}&cursor=${encodeURIComponent(first.page.next_cursor!)}`), now), /游标/);
      }
    });
  });
});

it("excludes expired checkouts without an order read while keeping other sites' live payments pending", async () => {
  const fixture = await createSitePaymentFixture();
  try {
    const alpha = fixture.createSite("Alpha");
    const beta = fixture.createSite("Beta");
    for (const [site, ttl] of [[alpha, 60], [beta, 600]] as const) {
      const configuration = structuredClone(site.configuration);
      configuration.policy.orders.order_ttl_seconds = ttl;
      fixture.sites.update(site.clientId, { revision: site.revision, configuration }, { actorId: "admin" });
    }
    const createOrder = (clientId: string) => fixture.orders.forSite(clientId).create(createOrderRequestSchema.parse({
      merchant_order_no: "pending-overview", idempotency_key: "pending-overview", product_name: "Overview test", amount_cents: 10000,
    })).order;
    const alphaOrder = createOrder(alpha.clientId);
    const betaOrder = createOrder(beta.clientId);
    const pending = (clientId: string, range: number) => siteOverview(fixture.database, new URLSearchParams({ q: clientId, range: String(range) }), fixture.now()).data[0]!.pending_orders;

    fixture.setNow(alphaOrder.checkout.expiresAt - 1);
    assert.equal(pending(alpha.clientId, 7), 1);
    fixture.setNow(alphaOrder.checkout.expiresAt);
    for (const range of [7, 30, 90]) {
      assert.equal(pending(alpha.clientId, range), 0);
      assert.equal(pending(beta.clientId, range), 1);
    }
    fixture.setNow(alphaOrder.checkout.expiresAt + 1);
    assert.equal(pending(alpha.clientId, 7), 0);
    assert.equal(fixture.database.read(connection => connection.prepare("SELECT checkout_status FROM payment_orders WHERE order_id = ?").get(alphaOrder.orderId)?.checkout_status), "OPEN");
    fixture.orders.forSite(alpha.clientId).get(alphaOrder.orderId);
    assert.equal(pending(alpha.clientId, 7), 0);
    fixture.setNow(betaOrder.checkout.expiresAt);
    assert.equal(pending(beta.clientId, 7), 0);
  } finally {
    fixture.close();
  }
});

function addSite(connection: DatabaseSync, clientId: string, name: string, options: { deletedAt?: number; acceptingOrders?: boolean } = {}): void {
  connection.prepare("INSERT INTO sites(client_id, configuration, deleted_at) VALUES (?, ?, ?)").run(clientId, JSON.stringify({
    name,
    accepting_orders: options.acceptingOrders ?? true,
    notifications_enabled: false,
    notification_origin: null,
    return_origin: null,
    policy: {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 60, pending_order_limit: null },
      display: { checkout_name: "PerPay", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
    },
  }), options.deletedAt ?? null);
}

function addConfirmation(connection: DatabaseSync, clientId: string, orderId: string, occurredAt: number, amount: number, createdAt = occurredAt): void {
  connection.prepare(`
    INSERT INTO payment_orders(order_id, api_client_id, created_at, payment_status, checkout_status, received_amount_cents)
    VALUES (?, ?, ?, 'CONFIRMED', 'CLOSED', ?)
  `).run(orderId, clientId, createdAt, amount);
  connection.prepare("INSERT INTO order_events VALUES (?, 'PAYMENT_CONFIRMED', ?)").run(orderId, occurredAt);
}

function withFixture(operation: (database: AppDatabase, connection: DatabaseSync) => void): void {
  const connection = new DatabaseSync(":memory:", { readBigInts: true });
  const database = {
    read<Result>(read: (databaseConnection: DatabaseSync) => Result): Result {
      return read(connection);
    },
  } as AppDatabase;
  try {
    connection.exec(`
      CREATE TABLE sites (client_id TEXT PRIMARY KEY, configuration TEXT NOT NULL, deleted_at INTEGER);
      CREATE TABLE payment_orders (
        order_id TEXT PRIMARY KEY, api_client_id TEXT NOT NULL, collection_profile_id TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER, payment_status TEXT NOT NULL, checkout_status TEXT NOT NULL,
        received_amount_cents INTEGER
      );
      CREATE TABLE order_events (order_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL);
      CREATE TABLE financial_exceptions (
        exception_id TEXT PRIMARY KEY, provider_account_key TEXT, status TEXT NOT NULL,
        exception_type TEXT NOT NULL DEFAULT 'UNMATCHED_CREDIT', order_id TEXT, ledger_entry_id TEXT,
        candidate_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_conflicts (
        conflict_id TEXT PRIMARY KEY, provider_account_key TEXT, status TEXT, conflict_type TEXT,
        existing_ledger_entry_id TEXT, external_event_id TEXT, created_at INTEGER
      );
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY, outbox_event_id TEXT, status TEXT, attempt_count INTEGER,
        next_attempt_at INTEGER, last_error_code TEXT, dead_lettered_at INTEGER, created_at INTEGER,
        updated_at INTEGER, predecessor_delivery_id TEXT
      );
      CREATE TABLE outbox_events (outbox_event_id TEXT PRIMARY KEY, event_type TEXT, aggregate_id TEXT);
      CREATE TABLE collection_profiles (profile_id TEXT PRIMARY KEY, provider_account_key TEXT);
      CREATE TABLE collection_profile_provider_accounts (profile_id TEXT PRIMARY KEY, provider_account_key TEXT);
      CREATE TABLE admin_work_item_states (kind TEXT, item_id TEXT, ignored INTEGER, updated_at INTEGER, operation_id TEXT);
      CREATE TABLE admin_operation_log (operation_id TEXT PRIMARY KEY, actor_id TEXT);
    `);
    operation(database, connection);
  } finally {
    connection.close();
  }
}
