import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { AppDatabase, inspectDatabaseIntegrity } from "../src/database/database.ts";
import { adminRefundMarks, adminRefundMarkHistory, setAdminRefundMark } from "../src/database/admin-refund-mark-store.ts";
import { adminWorkItemPage, ignoreAllAdminWorkItems } from "../src/http/admin-work-items.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { administratorStateDowngradeSql } from "./admin-state-schema-fixture.ts";
import { enableNotifications, withHttpFixture } from "./reconciliation-http-fixture.ts";
import { seedLegacyRefund } from "./legacy-refund-fixture.ts";
import { seedLegacyDebitException } from "./legacy-debit-exception-fixture.ts";

const preservedTables = ["payment_orders", "amount_slots", "checkout_sessions", "order_events", "financial_operations", "ledger_entries", "ledger_transactions", "ledger_postings", "refund_records", "financial_exceptions", "outbox_events", "webhook_deliveries", "provider_raw_events", "provider_raw_pages", "audit_events"] as const;
function historicalSnapshot(database: AppDatabase) {
  return database.read((connection) => Object.fromEntries(preservedTables.map((table) => [table, connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()])));
}

it("upgrades schema 22 without rewriting historical money, refund evidence, queued notices or audit hashes, and persists admin state through restart", async () => {
  await withHttpFixture(async (fixture) => {
    const { notifyUrl } = enableNotifications(fixture);
    const order = fixture.createSettlement("migration-refund", 999, notifyUrl).order;
    const debit = fixture.recordDebit("migration-legacy-refund", 100, 5);
    const legacyRefund = seedLegacyRefund(fixture.database, { financialOperationId: randomUUID(), orderId: order.orderId, ledgerEntryId: debit.ledgerEntryId, actorId: "admin", reason: "pre-retirement partial refund", now: Date.now() });
    assert.equal(legacyRefund.refundStatus, "PARTIAL");
    seedLegacyDebitException(fixture.database, debit.ledgerEntryId, "UNMATCHED_DEBIT");
    seedLegacyDebitException(fixture.database, debit.ledgerEntryId, "UNLINKED_REFUND");
    const credit = fixture.recordCredit("migration-live-exception", 55, 6);
    const result = fixture.reconciliation.reconcileEntry(credit.ledgerEntryId); assert.equal(result.kind, "unmatched");
    assert.equal(fixture.webhooks.materialize(10, Date.now()), 2);
    const before = historicalSnapshot(fixture.database);
    const databasePath = fixture.services.config.databasePath;
    fixture.database.close();
    const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readBigInts: true });
    try {
      legacy.exec("BEGIN IMMEDIATE;" + administratorStateDowngradeSql() + "COMMIT;");
      assert.equal(Number((legacy.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: bigint }).version), 22);
      assert.equal(inspectDatabaseIntegrity(legacy).ok, true);
    } finally { legacy.close(); }
    let upgraded = await AppDatabase.open(databasePath);
    try {
      assert.deepEqual(historicalSnapshot(upgraded), before);
      assert.equal(Number(upgraded.read((connection) => (connection.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: bigint }).version)), 23);
      assert.equal(adminRefundMarks(upgraded, [order.orderId]).get(order.orderId)?.version, 0, "legacy refunds must not be converted to admin marks");
      assert.equal(adminWorkItemPage(upgraded, { type: "ALL", cursor: null, limit: 100 }).items.length, 1);
      const context = { actorId: "admin", requestId: "migration-state-persistence", remoteAddressHash: "b".repeat(64) };
      const request = { operation_id: randomUUID(), version: 0, marked: true, note: "后台声明不应出现在旧通知中" };
      const mark = setAdminRefundMark(upgraded, order.orderId, request, context);
      const ignored = ignoreAllAdminWorkItems(upgraded, { operation_id: randomUUID(), type: "ALL" }, context);
      assert.equal(ignored.ignored_count, 1);
      const committed = historicalSnapshot(upgraded);
      for (const table of preservedTables.filter((table) => table !== "audit_events")) assert.deepEqual(committed[table], before[table]);
      assert.deepEqual(committed.audit_events?.slice(0, before.audit_events?.length), before.audit_events);
      upgraded.close(); upgraded = await AppDatabase.open(databasePath);
      assert.deepEqual(adminRefundMarks(upgraded, [order.orderId]).get(order.orderId), mark.refund_mark);
      assert.deepEqual(setAdminRefundMark(upgraded, order.orderId, request, context), mark);
      assert.equal(adminRefundMarkHistory(upgraded, order.orderId).length, 1);
      assert.equal(adminWorkItemPage(upgraded, { type: "ALL", cursor: null, limit: 20 }).items.length, 0);
      assert.equal(adminWorkItemPage(upgraded, { type: "ALL", visibility: "IGNORED", cursor: null, limit: 20 }).items.length, 1);
      assert.throws(() => upgraded.write((connection) => connection.exec("UPDATE admin_refund_mark_events SET marked = 0")), /immutable/);
      assert.throws(() => upgraded.write((connection) => connection.exec("DELETE FROM admin_work_item_operations")), /cannot be deleted/);
      const notifications = new WebhookStore(upgraded);
      assert.equal(notifications.materialize(10, Date.now()), 0, "marking must not create additional events or deliveries");
      const deliveredTypes: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        const now = Date.now();
        const claim = notifications.claimNext({ now, leaseMilliseconds: 10000, maximumAttempts: 2 }); assert.ok(claim);
        deliveredTypes.push(claim.event.eventType);
        assert.equal(claim.event.payloadJson.includes("refund_mark"), false);
        assert.equal(claim.event.payloadJson.includes(request.note), false);
        notifications.completeAttempt({ deliveryId: claim.delivery.deliveryId, attemptId: claim.attempt.attemptId, leaseToken: claim.attempt.leaseToken,
          outcome: "ACKNOWLEDGED", now: now + 1, maximumAttempts: 2, retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 60000,
          resolvedAddressesFingerprint: "c".repeat(64), connectedAddress: "8.8.8.8", httpStatus: 200, responseBytes: 2,
          responseFingerprint: createHash("sha256").update("ok").digest("hex"), ackCode: "acknowledged" });
      }
      assert.deepEqual(deliveredTypes.sort(), ["PAYMENT_CONFIRMED", "REFUND_UPDATED"]);
      const afterDelivery = historicalSnapshot(upgraded);
      assert.deepEqual(afterDelivery.refund_records, before.refund_records);
      assert.deepEqual(afterDelivery.outbox_events, before.outbox_events);
      assert.deepEqual(afterDelivery.payment_orders, before.payment_orders);
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally { upgraded.close(); }
  });
});
