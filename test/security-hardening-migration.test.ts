import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { OrderStore } from "../src/database/order-store.ts";
import { createOrderRequestSchema, fingerprintCreateOrderRequest, digestIdempotencyKey } from "../src/orders/model.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { securityHardeningDowngradeSql } from "./security-schema-fixture.ts";

it("upgrades schema 20 without changing historical payment windows, events or audit evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-security-migration-"));
  const services = await createConfiguredHttpServices({ directory,
    apiSecret: Buffer.alloc(32, 7).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/migration-test" });
  let reopened: AppDatabase | undefined;
  const base = 2_000_000_000_000;
  let now = base - 3_600_000;
  const orders = new OrderStore(services.database, () => now);
  const input = (suffix: string, amount: number, ttlMilliseconds = 300_000) => {
    const request = createOrderRequestSchema.parse({ idempotency_key: suffix, merchant_order_no: suffix, product_name: suffix, amount_cents: amount });
    return { apiClientId: "default", request, idempotencyKeyDigest: digestIdempotencyKey("default", suffix),
      requestFingerprint: fingerprintCreateOrderRequest(request), ttlMilliseconds, amountOffsetMaximumCents: 1 };
  };
  const history = (database: AppDatabase) => database.read((connection) => ({
    orders: connection.prepare("SELECT order_id, payable_amount_cents, checkout_status, payment_status, payment_basis, eligible_from, created_at, expires_at, closed_at, updated_at, version FROM payment_orders ORDER BY order_id").all(),
    slots: connection.prepare("SELECT * FROM amount_slots ORDER BY slot_id").all(),
    events: connection.prepare("SELECT * FROM order_events ORDER BY event_id").all(),
    audit: connection.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
    outbox: connection.prepare("SELECT * FROM outbox_events ORDER BY outbox_event_id").all(),
  }));
  try {
    const old = orders.createOrder(input("long-expired", 2_000, 60_000));
    if (old.kind !== "created") assert.fail("expected old order");
    now = base;
    assert.equal(orders.orderById("default", old.aggregate.order.orderId)?.order.checkoutStatus, "EXPIRED");
    const recent = orders.createOrder(input("recently-closed", 1_000));
    if (recent.kind !== "created") assert.fail("expected recent order");
    now = base + 60_000;
    orders.closeOrder("default", recent.aggregate.order.orderId);
    const before = history(services.database);
    services.database.close();

    // Remove only the additive security migrations from this isolated fixture,
    // retaining real pre-upgrade orders, fingerprints, sessions and audit records.
    const legacy = new DatabaseSync(services.config.databasePath);
    try {
      legacy.exec(`
        BEGIN IMMEDIATE;
        ${securityHardeningDowngradeSql()}
        COMMIT;
      `);
    } finally { legacy.close(); }

    reopened = await AppDatabase.open(services.config.databasePath);
    assert.deepEqual(history(reopened), before);
    assert.equal(reopened.integrityCheck().ok, true);
    assert.equal(reopened.read((connection) => Number((connection.prepare(
      "SELECT max(version) AS value FROM schema_migrations",
    ).get() as { value: bigint }).value)), 22);
    now = base + 62_000;
    const upgraded = new OrderStore(reopened, () => now);
    assert.deepEqual(upgraded.createOrder(input("blocked-after-upgrade", 1_000)),
      { kind: "amount_slots_exhausted", retryAfterSeconds: 598 });
    const reusable = upgraded.createOrder(input("elapsed-before-upgrade", 2_000));
    assert.equal(reusable.kind, "created");
    assert.equal(upgraded.orderById("default", recent.aggregate.order.orderId)?.order.paymentStatus, "UNPAID");
  } finally { reopened?.close(); services.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
