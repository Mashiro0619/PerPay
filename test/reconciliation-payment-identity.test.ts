import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { AlipayAccountStore, AlipayAccountService } from "../src/alipay-accounts/index.ts";
import { OrderService } from "../src/orders/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { hasSettledPaymentIdentity } from "../src/reconciliation/payment-identity.ts";
import { keyMaster, privatePem, platformPem, keyAudit } from "./application-key-fixture.ts";

async function withCopies(test: (fixture: Awaited<ReturnType<typeof createCopies>>) => void) {
  const fixture = await createCopies();
  try { test(fixture); } finally {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

async function createCopies() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-payment-identity-"));
  const database = await AppDatabase.open(join(directory, "database.sqlite3"));
  const settings = new RuntimeSettingsStore(database, keyMaster); settings.initialize();
  const accountStore = new AlipayAccountStore(database, keyMaster);
  const accounts = new AlipayAccountService({ store: accountStore });
  const account = await accounts.create({ name: "Stable wallet", app_id: "original-app",
    code_payload: "https://qr.alipay.com/payment-identity", private_key: privatePem,
    platform_public_key: platformPem }, keyAudit());
  const sites = settings.siteStore()!;
  const site = sites.create({ operation_id: randomUUID(), configuration: {
    name: "Identity test", accepting_orders: true, notifications_enabled: false,
    notification_origin: null, return_origin: null,
    collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] },
    policy: sites.defaults().policy,
  } }, keyAudit());
  let now = Date.now();
  const orders = new OrderService(database, () => settings.instanceSnapshot(), () => now,
    sites, undefined, { accounts: () => accountStore.snapshots() }).forSite(site.clientId);
  const ledger = new LedgerStore(database), reconciliation = new ReconciliationStore(database);
  const createOrder = (name: string) => orders.create({ merchant_order_no: name, idempotency_key: name,
    amount_cents: 1000, product_name: "Identity regression" }).order;
  const firstOrder = createOrder("first"); now += 1000;
  const occurredAt = now;
  const credit = (providerAccountKey: string) => {
    const timestamp = (value: number) => new Date(value + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
    const run = ledger.startIngestRun({ providerAccountKey, pageSize: 100,
      start: timestamp(occurredAt - 10000), end: timestamp(occurredAt + 10000), now });
    const detail = { accountLogId: "one-real-payment", occurredAt: timestamp(occurredAt), amount: "10.01",
      direction: "CREDIT" as const, alipayOrderNo: "same-alipay-order", merchantOrderNo: null,
      transMemo: null, otherAccount: null, raw: { account_log_id: "one-real-payment", amount: "10.01" } };
    const recorded = ledger.recordPage({ ingestRunId: run.ingestRunId,
      page: { pageNo: 1, pageSize: 100, totalSize: 1, hasMore: false, details: [detail] },
      evidence: { httpStatus: 200, headers: {}, body: JSON.stringify(detail), traceId: "identity-test", signatureVerified: true }, now });
    assert.notEqual(recorded.kind, "variant");
    if (recorded.kind === "variant") throw new Error("unexpected page variant");
    const entry = recorded.normalized[0]; assert.equal(entry?.kind, "created");
    if (entry?.kind !== "created") throw new Error("expected new source copy");
    return entry.entry.ledgerEntryId;
  };
  const firstEntry = credit(account.provider_account_key!);
  const firstMatch = reconciliation.reconcileEntry(firstEntry, now);
  assert.equal(firstMatch.kind, "auto_settled");
  if (firstMatch.kind !== "auto_settled") throw new Error("expected first settlement");
  orders.close(firstOrder.orderId);
  const updated = await accounts.update(account.id, { revision: account.revision, name: account.name,
    enabled: true, code_payload: account.code_payload, environment: "PRODUCTION", app_id: "replacement-app",
    platform_public_key: platformPem }, keyAudit());
  const secondEntry = credit(updated.provider_account_key!);
  now += 601000;
  const secondOrder = createOrder("second");
  return { directory, database, reconciliation, orders, firstOrder, firstEntry,
    firstMatch, secondOrder, secondEntry, now, siteId: site.clientId };
}

it("excludes settled source copies from manual discovery, sweeps and automatic confirmation; permits reuse only after reversal", async () => {
  await withCopies(f => {
    for (const view of ["recommended", "all"] as const) {
      const query = { q: "", view, limit: 20, position: null };
      for (const siteClientId of [undefined, f.siteId]) {
        const page = f.reconciliation.manualLedgerPage({ ...query, contextId: f.secondOrder.orderId,
          ...(siteClientId === undefined ? {} : { siteClientId }) });
        assert.ok(page);
        assert.ok(!page.items.some(item => item.record.ledgerEntryId === f.secondEntry));
      }
      const orders = f.reconciliation.manualOrderPage({ ...query, contextId: f.secondEntry });
      assert.deepEqual(orders?.items, []);
    }
    assert.deepEqual(f.reconciliation.reconcileEntry(f.secondEntry, f.now), { kind: "ignored", ledgerEntryId: f.secondEntry });
    assert.ok(!f.reconciliation.pendingLedgerPage(null, 20).ledgerEntryIds.includes(f.secondEntry));
    const input = { financialOperationId: randomUUID(), actorId: "admin", orderId: f.secondOrder.orderId,
      ledgerEntryId: f.secondEntry, now: f.now };
    for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => f.reconciliation.settleManually(input),
      { code: "match_state_conflict" });
    assert.equal(f.orders.get(f.secondOrder.orderId).payment.status, "UNPAID");
    assert.equal(f.database.read(db => Number(db.prepare("SELECT COUNT(*) n FROM outbox_events").get()!.n)), 1);
    assert.equal(f.database.integrityCheck().ok, true);

    f.reconciliation.reverseSettlement({ financialOperationId: randomUUID(), paymentMatchId: f.firstMatch.paymentMatchId,
      actorId: "admin", reason: "Correct the original allocation", now: f.now });
    assert.ok(f.reconciliation.manualLedgerPage({ contextId: f.secondOrder.orderId, q: "", view: "recommended", limit: 20, position: null })!
      .items.some(item => item.record.ledgerEntryId === f.secondEntry));
    const settled = f.reconciliation.settleManually(input);
    assert.equal(settled.replayed, false);
    assert.equal(f.reconciliation.settleManually(input).replayed, true);
    assert.equal(f.orders.get(f.firstOrder.orderId).payment.status, "DISPUTED");
    assert.equal(f.orders.get(f.secondOrder.orderId).payment.status, "CONFIRMED");
    assert.equal(f.database.integrityCheck().ok, true);
  });
});

it("detects an existing double allocation created by the former source-local settlement check", async () => {
  await withCopies(f => {
    // Reproduce the old eligibility check only. Keep the real transaction,
    // accounting, outbox and audit writes so no unrelated corruption explains
    // the integrity violation.
    const legacy = new ReconciliationStore({ read: f.database.read.bind(f.database),
      write: operation => f.database.write(connection => operation(new Proxy(connection, {
        get(target, property) {
          if (property === "prepare") return (sql: string) => {
            if (sql.startsWith("SELECT 1 FROM ledger_entries AS entry") && sql.includes("identity_match")) return { get: () => undefined };
            return target.prepare(sql);
          };
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }))),
    });
    assert.equal(f.database.integrityCheck().ok, true);
    legacy.settleManually({ financialOperationId: randomUUID(), actorId: "admin", orderId: f.secondOrder.orderId,
      ledgerEntryId: f.secondEntry, now: f.now });
    const integrity = f.database.integrityCheck();
    assert.equal(integrity.ok, false);
    assert.equal(integrity.foreignKeyViolations, 0);
    assert.equal(integrity.domainViolations, 2);
  });
});

it("keeps distinct accounts, environments and unmapped historical sources isolated", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE ledger_entries(ledger_entry_id TEXT, provider_account_key TEXT, external_event_id TEXT);
      CREATE TABLE payment_matches(payment_match_id TEXT, ledger_entry_id TEXT, status TEXT);
      INSERT INTO ledger_entries VALUES ('old','old-provider','payment'), ('new','new-provider','payment'),
        ('other-account','other-provider','payment'), ('sandbox','sandbox-provider','payment'), ('unmapped','unmapped-provider','payment');
      INSERT INTO payment_matches VALUES ('match','old','SETTLED');`);
    assert.equal(hasSettledPaymentIdentity(db, "old"), true);
    assert.equal(hasSettledPaymentIdentity(db, "new"), false, "legacy sources are isolated by provider key");
    db.exec(`CREATE TABLE alipay_account_generations(provider_account_key TEXT PRIMARY KEY, account_id TEXT);
      CREATE TABLE provider_account_bindings(provider_account_key TEXT PRIMARY KEY, provider_endpoint TEXT);
      INSERT INTO alipay_account_generations VALUES ('old-provider','wallet'),('new-provider','wallet'),
        ('other-provider','another-wallet'),('sandbox-provider','wallet');
      INSERT INTO provider_account_bindings VALUES ('old-provider','https://openapi.alipay.com'),('new-provider','https://openapi.alipay.com'),
        ('other-provider','https://openapi.alipay.com'),('sandbox-provider','https://openapi-sandbox.dl.alipaydev.com');`);
    assert.equal(hasSettledPaymentIdentity(db, "new"), true);
    for (const id of ["other-account", "sandbox", "unmapped"]) assert.equal(hasSettledPaymentIdentity(db, id), false, id);
    db.exec("UPDATE payment_matches SET status='REVERSED'");
    assert.equal(hasSettledPaymentIdentity(db, "new"), false);
  } finally { db.close(); }
});
