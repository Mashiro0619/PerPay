import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";

describe("system analytics", () => {
  it("returns a complete zero-filled daily series for an empty database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-analytics-"));
    const databasePath = join(directory, "database.sqlite3");
    const database = await AppDatabase.open(databasePath);
    try {
      const result = systemAnalytics(database, 7, Date.UTC(2026, 0, 15, 12));
      assert.equal(result.range_days, 7);
      assert.equal(result.from, "2026-01-08T16:00:00.000Z");
      assert.equal(result.to, "2026-01-15T16:00:00.000Z");
      assert.equal(result.daily.length, 7);
      assert.equal(result.orders.created, 0);
      assert.equal(result.confirmations.amount_cents, 0);
      assert.deepEqual(result.daily[0], {
        date: "2026-01-09",
        orders_created: 0,
        confirmations: 0,
        confirmed_amount_cents: 0,
        notifications_acknowledged: 0,
        notifications_failed: 0,
      });
      assert.deepEqual(result.daily[6], {
        date: "2026-01-15",
        orders_created: 0,
        confirmations: 0,
        confirmed_amount_cents: 0,
        notifications_acknowledged: 0,
        notifications_failed: 0,
      });
    } finally {
      database.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith("perpay-analytics-"));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("advances the calendar at Beijing midnight through year and leap-day boundaries", () => {
    withFixture((database) => {
      for (const boundary of [
        { now: "2025-12-31T15:59:59.999Z", first: "2025-12-25", last: "2025-12-31", from: "2025-12-24T16:00:00.000Z", to: "2025-12-31T16:00:00.000Z" },
        { now: "2025-12-31T16:00:00.000Z", first: "2025-12-26", last: "2026-01-01", from: "2025-12-25T16:00:00.000Z", to: "2026-01-01T16:00:00.000Z" },
        { now: "2028-02-28T16:00:00.000Z", first: "2028-02-23", last: "2028-02-29", from: "2028-02-22T16:00:00.000Z", to: "2028-02-29T16:00:00.000Z" },
      ]) {
        const result = systemAnalytics(database, 7, Date.parse(boundary.now));
        assert.equal(result.from, boundary.from);
        assert.equal(result.to, boundary.to);
        assert.equal(result.daily[0]?.date, boundary.first);
        assert.equal(result.daily.at(-1)?.date, boundary.last);
      }
    });
  });

  it("excludes expired unpaid orders from pending counts without materializing checkout state", () => {
    withFixture((database, connection) => {
      const now = Date.parse("2026-01-15T12:00:00.000Z");
      const insert = connection.prepare(`INSERT INTO payment_orders(order_id,api_client_id,created_at,expires_at,payment_status,checkout_status) VALUES (?, ?, ?, ?, 'UNPAID', 'OPEN')`);
      insert.run("alpha-expiring", "alpha", now - 1_000, now);
      insert.run("alpha-live", "alpha", now - 1_000, now + 10_000);
      insert.run("beta-live", "beta", now - 1_000, now + 20_000);
      for (const [timestamp, alphaPending, totalPending] of [[now - 1, 2, 3], [now, 1, 2], [now + 1, 1, 2]] as const) {
        for (const [clientId, pending, unpaid] of [[null, totalPending, 3], ["alpha", alphaPending, 2], ["beta", 1, 1]] as const) {
          const result = systemAnalytics(database, 7, timestamp, clientId);
          assert.equal(result.pending.orders, pending);
          assert.equal(result.orders.unpaid, unpaid);
        }
      }
      assert.deepEqual(connection.prepare("SELECT order_id, checkout_status FROM payment_orders ORDER BY order_id").all().map((row) => ({ ...row })), [
        { order_id: "alpha-expiring", checkout_status: "OPEN" },
        { order_id: "alpha-live", checkout_status: "OPEN" },
        { order_id: "beta-live", checkout_status: "OPEN" },
      ]);
    });
  });

  it("excludes only retired debit warnings from pending exception counts", () => {
    withFixture((database, connection) => {
      connection.exec("INSERT INTO financial_exceptions(status,exception_type) VALUES ('OPEN', 'UNMATCHED_DEBIT'), ('OPEN', 'UNLINKED_REFUND'), ('OPEN', 'UNMATCHED_CREDIT'), ('RESOLVED', 'UNMATCHED_CREDIT')");
      connection.exec("INSERT INTO ledger_conflicts VALUES ('OPEN')");
      assert.equal(systemAnalytics(database, 7).pending.exceptions, 1);
      assert.equal(systemAnalytics(database, 7).pending.conflicts, 1);
    });
  });

  for (const days of [7, 30, 90] as const) {
    it(`groups orders, confirmations and notifications into ${days} Beijing days with exclusive end boundaries`, () => {
      withFixture((database, connection) => {
        const now = Date.parse("2026-01-16T00:00:00+08:00");
        const end = Date.parse("2026-01-17T00:00:00+08:00");
        const start = end - days * 86_400_000;
        const records = [
          { timestamp: start - 1, amount: 10, status: "ACKNOWLEDGED" },
          { timestamp: start, amount: 20, status: "ACKNOWLEDGED" },
          { timestamp: now - 1, amount: 30, status: "DEAD_LETTER" },
          { timestamp: now, amount: 40, status: "ACKNOWLEDGED" },
          { timestamp: end - 1, amount: 50, status: "DEAD_LETTER" },
          { timestamp: end, amount: 60, status: "ACKNOWLEDGED" },
        ];
        for (const [index, record] of records.entries()) {
          const orderId = `order-${index}`;
          connection.prepare(`INSERT INTO payment_orders(order_id,created_at,payment_status,checkout_status,received_amount_cents) VALUES (?, ?, 'CONFIRMED', 'CLOSED', ?)`)
            .run(orderId, record.timestamp, record.amount);
          connection.prepare(`INSERT INTO order_events VALUES (?, 'PAYMENT_CONFIRMED', ?)`)
            .run(orderId, record.timestamp);
          connection.prepare("INSERT INTO webhook_deliveries(created_at,status) VALUES (?, ?)")
            .run(record.timestamp, record.status);
        }

        const result = systemAnalytics(database, days, now);
        assert.equal(result.range_days, days);
        assert.equal(Date.parse(result.from), start);
        assert.equal(Date.parse(result.to), end);
        assert.equal(result.daily.length, days);
        assert.equal(result.orders.created, 4);
        assert.deepEqual(result.confirmations, { count: 4, amount_cents: 140 });
        assert.deepEqual(result.notifications, { acknowledged: 2, failed: 2, pending: 0 });
        assert.equal(result.daily[0]?.confirmed_amount_cents, 20);
        assert.deepEqual(result.daily.at(-2), {
          date: "2026-01-15", orders_created: 1, confirmations: 1,
          confirmed_amount_cents: 30, notifications_acknowledged: 0, notifications_failed: 1,
        });
        assert.deepEqual(result.daily.at(-1), {
          date: "2026-01-16", orders_created: 2, confirmations: 2,
          confirmed_amount_cents: 90, notifications_acknowledged: 1, notifications_failed: 1,
        });
        assert.equal(result.daily.reduce((total, day) => total + day.orders_created, 0), result.orders.created);
        assert.equal(result.daily.reduce((total, day) => total + day.confirmed_amount_cents, 0), result.confirmations.amount_cents);
        assert.equal(result.daily.reduce((total, day) => total + day.notifications_acknowledged, 0), result.notifications.acknowledged);
        assert.equal(result.daily.reduce((total, day) => total + day.notifications_failed, 0), result.notifications.failed);
      });
    });
  }
});

function withFixture(operation: (database: AppDatabase, connection: DatabaseSync) => void): void {
  const connection = new DatabaseSync(":memory:", { readBigInts: true });
  const database = {
    read<Result>(read: (databaseConnection: DatabaseSync) => Result): Result {
      return read(connection);
    },
  } as AppDatabase;
  try {
    connection.exec(`
      CREATE TABLE payment_orders (
        api_client_id TEXT NOT NULL DEFAULT 'default',
        order_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER,
        payment_status TEXT NOT NULL, checkout_status TEXT NOT NULL,
        received_amount_cents INTEGER
      );
      CREATE TABLE order_events (order_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at INTEGER NOT NULL);
      CREATE TABLE webhook_targets(target_id TEXT PRIMARY KEY, api_client_id TEXT);
      CREATE TABLE webhook_deliveries (target_id TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE financial_exceptions (order_id TEXT, status TEXT NOT NULL, exception_type TEXT NOT NULL);
      CREATE TABLE ledger_conflicts (status TEXT NOT NULL);
    `);
    operation(database, connection);
  } finally {
    connection.close();
  }
}
