import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { webhookSigningKeyFingerprint } from "../src/notifications/model.ts";

/** Historical financial facts are seeded on schema 33, not by downgrading schema 34. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-legacy-payment-"));
  const services = await createConfiguredLegacyHttpServices({ directory,
    apiSecret: Buffer.alloc(32, 13).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/legacy-payment" });
  const { database, orders } = services;
  const baseTime = Date.now();
  const ledger = new LedgerStore(database), reconciliation = new ReconciliationStore(database), webhooks = new WebhookStore(database);
  const source = services.settings.snapshot().activeProviderAccountKey!;
  const time = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const window = { start: time(baseTime - 60_000), end: time(baseTime + 3600_000) };
  let sequence = 0;
  const record = (id: string, cents: number, offset: number, direction: "CREDIT" | "DEBIT") =>
    recordLedgerEntry(ledger, window, id, cents, baseTime + 60_000 + offset * 1000, baseTime - 60_000 + ++sequence, direction, source);
  const createOrder = (id: string, cents: number, notifyUrl?: string) => orders.create(createOrderRequestSchema.parse({
    idempotency_key: id, merchant_order_no: id, product_name: id, amount_cents: cents, ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  })).order;
  return { services, database, directory, ledger, reconciliation, webhooks, baseTime, createOrder,
    recordCredit: (id: string, cents: number, offset: number) => record(id, cents, offset, "CREDIT"),
    recordDebit: (id: string, cents: number, offset: number) => record(id, cents, offset, "DEBIT"),
    createSettlement(id: string, cents: number, notifyUrl?: string) {
      const order = createOrder(id, cents, notifyUrl);
      const entry = record("entry-" + id, order.payableAmountCents, ++sequence, "CREDIT");
      const result = reconciliation.reconcileEntry(entry.ledgerEntryId);
      assert.equal(result.kind, "auto_settled");
      return { order, entry, result };
    },
    enableNotifications() {
      const origin = "https://business.example.com", secret = Buffer.alloc(32, 73).toString("base64url");
      services.settingsStore.saveWebhook({ revision: services.settings.view().revision, enabled: true, allowed_origin: origin,
        secret, timeout_milliseconds: 5000, maximum_attempts: 2, retry_base_seconds: 1, retry_maximum_seconds: 60,
      }, { actorId: "admin" });
      webhooks.syncSigningKey({ secretFingerprint: webhookSigningKeyFingerprint(secret), now: Date.now() });
      return { notifyUrl: origin + "/notify" };
    },
  };
}
export async function withLegacyPaymentFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try { await run(f); }
  finally {
    f.database.close();
    const path = resolve(f.directory);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith("perpay-legacy-payment-"));
    rmSync(path, { recursive: true });
  }
}
