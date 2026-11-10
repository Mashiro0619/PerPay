import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { siteOverview } from "../src/http/site-overview.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { beijingDate } from "../src/shared/created-dates.ts";
import { withLegacyPaymentFixture } from "./legacy-payment-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const providerTime = (value: number) => new Date(value + OFFSET).toISOString().slice(0, 19).replace("T", " ");

it("retains each confirmation amount across Beijing midnight, reversal and confirmation with another receipt", async () => {
  const f = await createSitePaymentFixture();
  try {
    const midnight = Math.floor((f.now() + OFFSET + 60_000) / DAY) * DAY - OFFSET + DAY;
    const firstDay = midnight - 60_000;
    const secondDay = midnight + 10_000;
    f.setNow(firstDay);
    const alpha = f.createSite("Confirmation Alpha"), beta = f.createSite("Confirmation Beta");
    const create = (clientId: string, amount: number) => f.orders.forSite(clientId).create(createOrderRequestSchema.parse({
      merchant_order_no: "confirmation-history", idempotency_key: "confirmation-history", amount_cents: amount, product_name: "Confirmation history",
    })).order;
    const originalOrder = create(alpha.clientId, 1499), otherOrder = create(beta.clientId, 1999);
    const ledger = new LedgerStore(f.database), reconciliation = new ReconciliationStore(f.database);
    const credit = (id: string, amount: number, occurredAt: number) => recordLedgerEntry(ledger,
      { start: providerTime(firstDay - 60_000), end: providerTime(secondDay + 60_000) },
      id, amount, occurredAt, occurredAt + 1_000, "CREDIT", f.snapshot.activeProviderAccountKey!);
    const original = credit("original-confirmation", originalOrder.payableAmountCents, firstDay + 1_000);
    const other = credit("other-site-confirmation", otherOrder.payableAmountCents, firstDay + 2_000);
    const first = reconciliation.reconcileEntry(original.ledgerEntryId, firstDay + 10_000);
    assert.equal(first.kind, "auto_settled");
    assert.equal(reconciliation.reconcileEntry(other.ledgerEntryId, firstDay + 10_000).kind, "auto_settled");
    const firstAmount = original.amountCents, otherAmount = other.amountCents, nextAmount = firstAmount + 3;
    const before = systemAnalytics(f.database, 7, firstDay + 10_000, alpha.clientId);
    assert.deepEqual(before.confirmations, { count: 1, amount_cents: firstAmount });

    reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: first.paymentMatchId,
      actorId: "admin", reason: "原付款需重新核对", now: midnight + 1_000 });
    const replacement = credit("replacement-confirmation", nextAmount, midnight + 2_000);
    reconciliation.settleManually({ financialOperationId: randomUUID(), orderId: originalOrder.orderId,
      ledgerEntryId: replacement.ledgerEntryId, actorId: "admin", reason: "核对实际付款流水后重新确认", now: secondDay });
    f.setNow(secondDay);
    assert.equal(f.orders.forSite(alpha.clientId).get(originalOrder.orderId).payment.receivedAmountCents, nextAmount);

    for (const range of [7, 30, 90]) {
      const originalDay = systemAnalytics(f.database, range, firstDay + 10_000, alpha.clientId);
      assert.deepEqual(originalDay.confirmations, before.confirmations, "a later confirmation must not rewrite the previous day's amount");
      const own = systemAnalytics(f.database, range, secondDay, alpha.clientId);
      assert.deepEqual(own.confirmations, { count: 2, amount_cents: firstAmount + nextAmount });
      assert.equal(own.daily.find(day => day.date === beijingDate(firstDay))!.confirmed_amount_cents, firstAmount);
      assert.equal(own.daily.find(day => day.date === beijingDate(secondDay))!.confirmed_amount_cents, nextAmount);
      assert.deepEqual(systemAnalytics(f.database, range, secondDay, beta.clientId).confirmations, { count: 1, amount_cents: otherAmount });
      assert.deepEqual(systemAnalytics(f.database, range, secondDay).confirmations, { count: 3, amount_cents: firstAmount + nextAmount + otherAmount });

      const previousOverview = siteOverview(f.database, new URLSearchParams({ range: String(range) }), firstDay + 10_000);
      assert.equal(previousOverview.data.find(site => site.client_id === alpha.clientId)!.confirmed_amount_cents, firstAmount);
      const overview = siteOverview(f.database, new URLSearchParams({ range: String(range) }), secondDay);
      assert.equal(overview.data.find(site => site.client_id === alpha.clientId)!.confirmed_count, 2);
      assert.equal(overview.data.find(site => site.client_id === alpha.clientId)!.confirmed_amount_cents, firstAmount + nextAmount);
      assert.equal(overview.data.find(site => site.client_id === beta.clientId)!.confirmed_amount_cents, otherAmount);
      assert.equal(overview.max_confirmed_amount_cents, Math.max(firstAmount + nextAmount, otherAmount));
    }
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("keeps pre-website confirmation snapshots readable after the current migration path", async () => {
  await withLegacyPaymentFixture(async f => {
    const settled = f.createSettlement("legacy-confirmation-statistics", 1499);
    const now = Date.now();
    const before = systemAnalytics(f.database, 7, now);
    assert.deepEqual(before.confirmations, { count: 1, amount_cents: settled.entry.amountCents });
    const snapshot = f.database.read(db => db.prepare("SELECT * FROM outbox_events").all());
    f.database.close();
    const upgraded = await AppDatabase.open(f.services.config.databasePath, { masterKey: f.services.config.masterKey });
    try {
      assert.deepEqual(upgraded.read(db => db.prepare("SELECT * FROM outbox_events").all()), snapshot);
      assert.deepEqual(systemAnalytics(upgraded, 7, now).confirmations, before.confirmations);
      assert.deepEqual(systemAnalytics(upgraded, 7, now).daily, before.daily);
      const site = siteOverview(upgraded, new URLSearchParams("range=7"), now).data.find(site => site.client_id === "default")!;
      assert.equal(site.confirmed_count, 1);
      assert.equal(site.confirmed_amount_cents, settled.entry.amountCents);
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally { upgraded.close(); }
  });
});
