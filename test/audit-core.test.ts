// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { AlipayAccountStore } from "../src/alipay-accounts/store.ts";
import { migrateAlipayAccounts } from "../src/alipay-accounts/migration.ts";
import { auditChanges, createAuditContext, MAX_AUDIT_CONTEXT_BYTES, runWithAuditContext, type StoredAuditContext } from "../src/audit/context.ts";
import { inspectAuditChain } from "../src/database/audit-chain.ts";
import { AppDatabase } from "../src/database/database.ts";
import { appendAuditEvent } from "../src/database/identity-store.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { createOrderRequestSchema, fingerprintCreateOrderRequest } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import { adminAccessInputSchema } from "../src/settings/admin-access.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { SiteStore } from "../src/sites/store.ts";
import { createPreAccountDatabase } from "./legacy-settings-fixture.ts";
import { privatePem, platformPem } from "./application-key-fixture.ts";
import { withHttpFixture } from "./reconciliation-http-fixture.ts";

const MASTER_KEY = Buffer.alloc(32, 97);
const ADMIN = { actorId: "admin" };

async function withDatabase(operation: (database: AppDatabase) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-audit-core-"));
  const database = await AppDatabase.open(join(directory, "perpay.sqlite3"), { masterKey: MASTER_KEY });
  try { await operation(database); }
  finally { database.close(); removeFixture(directory); }
}

function removeFixture(directory: string): void {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("perpay-audit-core-"));
  rmSync(directory, { recursive: true, force: true });
}

function latestContext(database: AppDatabase, action: string): StoredAuditContext {
  const row = database.read(db => db.prepare(`SELECT context.context_json FROM audit_event_context context
    JOIN audit_events event USING(event_id) WHERE event.action = ? ORDER BY event.sequence DESC LIMIT 1`).get(action)) as { context_json: string } | undefined;
  assert.ok(row, `missing context for ${action}`);
  return JSON.parse(row.context_json) as StoredAuditContext;
}

describe("permanent audit context and transaction integrity", () => {
  it("upgrades a real schema 38 database without changing any historical audit bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-audit-core-upgrade-"));
    const path = join(directory, "perpay.sqlite3");
    const legacy = createPreAccountDatabase(path);
    let upgraded: AppDatabase | undefined;
    try {
      legacy.owner.write(db => {
        for (const migration of migrations.filter(item => item.version >= 37 && item.version <= 38)) {
          db.exec(migration.sql);
          if (migration.postApply === "migrate_alipay_accounts_v1") migrateAlipayAccounts(db, MASTER_KEY);
          db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
        }
        appendAuditEvent(db, { occurredAt: 1_790_000_000_000, actorType: "SYSTEM", action: "legacy.event", outcome: "SUCCESS", details: { revision: 1, label: "旧链字节" } });
        appendAuditEvent(db, { occurredAt: 1_790_000_000_001, actorType: "ADMIN", actorId: "admin", action: "legacy.event", outcome: "FAILURE", requestId: "legacy-request", details: { reason: "test" } });
      });
      const before = legacy.connection.prepare("SELECT * FROM audit_events ORDER BY sequence").all();
      assert.equal(inspectAuditChain(legacy.connection).violations, 0);
      assert.ok(before.every(row => !String(row.details_json).includes("context_fingerprint")));
      legacy.owner.close();
      upgraded = await AppDatabase.open(path, { masterKey: MASTER_KEY });
      assert.deepEqual(upgraded.read(db => db.prepare("SELECT * FROM audit_events ORDER BY sequence").all()), before);
      assert.equal(Number(upgraded.read(db => db.prepare("SELECT COUNT(*) AS n FROM audit_event_context").get()!.n)), 0);
      assert.equal(upgraded.read(db => inspectAuditChain(db).violations), 0);
      const backupPath = `${path}.pre-migration-v38-to-v39.sqlite3`;
      assert.equal(existsSync(backupPath), true);
      const backup = new DatabaseSync(backupPath, { readOnly: true, readBigInts: true });
      try { assert.deepEqual(backup.prepare("SELECT * FROM audit_events ORDER BY sequence").all(), before); }
      finally { backup.close(); }
      const context = createAuditContext({ actorType: "ADMIN", actorId: "admin", requestId: "after-upgrade", sourceAddress: "2001:db8::1", userAgent: "Browser/1" });
      runWithAuditContext(context, () => upgraded!.write(db => appendAuditEvent(db, { occurredAt: Date.now(), actorType: "ADMIN", actorId: "admin", action: "new.event", outcome: "SUCCESS" })));
      assert.equal(context.coreEventIds.length, 1);
      assert.equal(latestContext(upgraded, "new.event").source_address, "2001:db8::1");
      assert.equal(upgraded.integrityCheck().ok, true);
    } finally { legacy.owner.close(); upgraded?.close(); removeFixture(directory); }
  });

  for (const corruption of ["update", "delete", "drop-table"] as const) {
    it(`detects ${corruption} of context independently of the unchanged event hash`, async () => {
      await withDatabase(database => {
        const event = runWithAuditContext(createAuditContext({ sourceAddress: "192.0.2.10", userAgent: "Browser/1" }), () => database.write(db =>
          appendAuditEvent(db, { occurredAt: Date.now(), actorType: "SYSTEM", action: "context.test", outcome: "SUCCESS" })));
        const before = database.read(db => db.prepare("SELECT event_hash, details_json FROM audit_events WHERE event_id = ?").get(event.eventId));
        database.write(db => {
          if (corruption === "drop-table") { db.exec("DROP TABLE audit_event_context"); return; }
          const triggerName = corruption === "update" ? "audit_event_context_no_update" : "audit_event_context_no_delete";
          const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ? AND type = 'trigger'").get(triggerName) as { sql: string };
          const mutate = () => corruption === "update"
            ? db.prepare("UPDATE audit_event_context SET source_address = '192.0.2.99', context_json = json_set(context_json, '$.source_address', '192.0.2.99') WHERE event_id = ?").run(event.eventId)
            : db.prepare("DELETE FROM audit_event_context WHERE event_id = ?").run(event.eventId);
          assert.throws(mutate, /append-only/);
          db.exec(`DROP TRIGGER ${triggerName}`);
          mutate();
          db.exec(trigger.sql);
        });
        assert.deepEqual(database.read(db => db.prepare("SELECT event_hash, details_json FROM audit_events WHERE event_id = ?").get(event.eventId)), before);
        assert.ok(database.read(db => inspectAuditChain(db).violations) > 0);
        assert.equal(database.integrityCheck().ok, false);
      });
    });
  }

  it("keeps very large differences bounded and preserves change identities without secret or URL credential disclosure", async () => {
    await withDatabase(database => {
      const before: Record<string, unknown> = { provider_private_key: "PRIVATE-BEFORE", api_secret: "SECRET-BEFORE", return_url: "https://before:password@example.com/path?secret=1#token" };
      const after: Record<string, unknown> = { provider_private_key: "PRIVATE-AFTER", api_secret: "SECRET-AFTER", return_url: "https://after:password@example.com/next?secret=2#token" };
      for (let index = 0; index < 32; index += 1) {
        before[`safe_field_${index}`] = Array.from({ length: 100 }, (_, item) => ({ name: "旧".repeat(400), weight: item, private_key: "NESTED-PRIVATE" }));
        after[`safe_field_${index}`] = Array.from({ length: 100 }, (_, item) => ({ name: "新".repeat(400), weight: item + 1, private_key: "NESTED-PRIVATE" }));
      }
      database.write(db => appendAuditEvent(db, { occurredAt: Date.now(), actorType: "ADMIN", actorId: "admin", action: "settings.large_change", outcome: "SUCCESS",
        context: { changes: auditChanges(before, after, Object.keys(before)) } }));
      const context = latestContext(database, "settings.large_change");
      const json = JSON.stringify(context);
      assert.ok(Buffer.byteLength(json, "utf8") <= MAX_AUDIT_CONTEXT_BYTES);
      assert.equal(context.changes.length, Object.keys(before).length);
      assert.ok(context.changes.filter(change => change.field.startsWith("safe_field_")).every(change => change.kind === "value"));
      assert.equal(context.changes.find(change => change.field === "provider_private_key")?.kind, "redacted_change");
      assert.equal(context.changes.find(change => change.field === "api_secret")?.kind, "redacted_change");
      for (const secret of ["PRIVATE-BEFORE", "PRIVATE-AFTER", "SECRET-BEFORE", "SECRET-AFTER", "NESTED-PRIVATE", "password", "secret=", "#token"]) assert.equal(json.includes(secret), false);
      assert.equal(database.read(db => inspectAuditChain(db).violations), 0);
    });
  });

  it("records real instance, website and account changes while retaining credentials only as changed markers", async () => {
    await withDatabase(database => {
      const settings = new RuntimeSettingsStore(database, MASTER_KEY);
      settings.initialize();
      const scope = createAuditContext({ actorType: "ADMIN", actorId: "admin", requestId: "settings-change", sourceAddress: "192.0.2.45", userAgent: "Browser/2" });
      runWithAuditContext(scope, () => settings.saveInstanceDisplay({ revision: settings.status().revision, system_name: "新的系统名", dashboard_chart_type: "BAR" }, ADMIN));
      const display = latestContext(database, "settings.display_updated");
      assert.equal(display.activity_id, scope.activityId);
      assert.equal(display.source_address, "192.0.2.45");
      assert.ok(display.changes.some(change => change.field === "system_name" && change.after === "新的系统名"));
      const accounts = new AlipayAccountStore(database, MASTER_KEY);
      const account = runWithAuditContext(scope, () => accounts.create({ name: "审计账号", enabled: true, environment: "PRODUCTION", app_id: "2026000000000011",
        code_payload: "https://qr.alipay.com/DO-NOT-LOG-PAYLOAD", private_key: privatePem, platform_public_key: platformPem }, ADMIN));
      const accountContext = latestContext(database, "alipay_account.created");
      assert.ok(accountContext.changes.some(change => change.field === "private_key" && change.kind === "redacted_change"));
      assert.ok(accountContext.changes.some(change => change.field === "code_payload" && change.kind === "redacted_change"));
      assert.doesNotMatch(JSON.stringify(accountContext), /BEGIN PRIVATE KEY|BEGIN PUBLIC KEY|DO-NOT-LOG-PAYLOAD/);
      const sites = new SiteStore(database, MASTER_KEY);
      const site = sites.create({ operation_id: randomUUID(), configuration: { name: "原网站名", accepting_orders: true, notifications_enabled: false,
        notification_origin: null, return_origin: null, collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] }, policy: sites.defaults().policy } }, ADMIN);
      const changed = runWithAuditContext(scope, () => sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, name: "新网站名", accepting_orders: false } }, ADMIN));
      const siteContext = latestContext(database, "site.updated");
      assert.equal(siteContext.site_id, site.clientId);
      assert.equal(siteContext.site_name, "新网站名");
      assert.ok(siteContext.changes.some(change => change.field === "name" && change.before === "原网站名" && change.after === "新网站名"));
      const rotated = sites.rotateSecret(site.clientId, "api_secret", changed.revision, ADMIN);
      const secretContext = latestContext(database, "site.secret_rotated");
      assert.ok(secretContext.changes.every(change => change.kind === "redacted_change"));
      assert.equal(JSON.stringify(secretContext).includes(rotated.secret), false);
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("accepts the supported 100 CIDRs and 100 collection accounts without losing the audit difference", async () => {
    await withDatabase(database => {
      const settings = new RuntimeSettingsStore(database, MASTER_KEY);
      settings.initialize();
      const cidrs = Array.from({ length: 100 }, (_, index) => `2001:0db8:abcd:abcd:abcd:abcd:abcd:${index.toString(16).padStart(4, "0")}/128`);
      const input = adminAccessInputSchema.parse({ revision: settings.status().revision, enabled: true, cidrs });
      settings.saveAdminAccess(input, ADMIN);
      assert.equal(settings.adminAccess().cidrs.length, 100);
      const adminChange = latestContext(database, "settings.admin_access_updated").changes.find(change => change.field === "admin_access");
      assert.ok(adminChange && adminChange.kind === "value");
      assert.equal((adminChange.after as { cidrs: unknown[] }).cidrs.length, 100);
      const accounts = new AlipayAccountStore(database, MASTER_KEY);
      const ids = Array.from({ length: 100 }, (_, index) => accounts.create({ name: `账号${index}`, enabled: true,
        environment: "PRODUCTION", app_id: null, code_payload: null }, ADMIN).id);
      const sites = new SiteStore(database, MASTER_KEY);
      const site = sites.create({ operation_id: randomUUID(), configuration: { name: "一百个账号", accepting_orders: true, notifications_enabled: false,
        notification_origin: null, return_origin: null, collection: { mode: "WEIGHTED", accounts: ids.map(account_id => ({ account_id, weight: 1 })) }, policy: sites.defaults().policy } }, ADMIN);
      const next = sites.update(site.clientId, { revision: 0, configuration: { ...site.configuration,
        collection: { mode: "WEIGHTED", accounts: ids.map(account_id => ({ account_id, weight: 1_000_000 })) } } }, ADMIN);
      assert.equal(next.configuration.collection?.accounts.length, 100);
      const collectionChange = latestContext(database, "site.updated").changes.find(change => change.field === "collection.accounts");
      assert.ok(collectionChange && collectionChange.kind === "value");
      assert.equal((collectionChange.before as unknown[]).length, 100);
      assert.equal((collectionChange.after as unknown[]).length, 100);
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("rolls the business change, core event and context back together when context insertion fails", async () => {
    await withDatabase(database => {
      const settings = new RuntimeSettingsStore(database, MASTER_KEY);
      settings.initialize();
      const before = database.read(db => ({ settings: db.prepare("SELECT revision, backup_interval_seconds, backup_keep_count FROM runtime_configuration").get(),
        audit: db.prepare("SELECT * FROM audit_events ORDER BY sequence").all(), contexts: db.prepare("SELECT * FROM audit_event_context").all() }));
      database.write(db => db.exec("CREATE TEMP TRIGGER reject_core_context BEFORE INSERT ON audit_event_context BEGIN SELECT RAISE(ABORT, 'injected context failure'); END"));
      const scope = createAuditContext({ actorType: "ADMIN", actorId: "admin" });
      assert.throws(() => runWithAuditContext(scope, () => settings.saveBackup({ revision: settings.status().revision, interval_seconds: 7_200, keep_count: 3 }, ADMIN)), /injected context failure/);
      const after = database.read(db => ({ settings: db.prepare("SELECT revision, backup_interval_seconds, backup_keep_count FROM runtime_configuration").get(),
        audit: db.prepare("SELECT * FROM audit_events ORDER BY sequence").all(), contexts: db.prepare("SELECT * FROM audit_event_context").all() }));
      assert.deepEqual(after, before);
      assert.deepEqual(scope.coreEventIds, []);
      database.write(db => db.exec("DROP TRIGGER reject_core_context"));
      assert.equal(database.integrityCheck().ok, true);
    });
  });

  it("audits real order creation, closure and expiry once without changing idempotency fingerprints", async () => {
    await withHttpFixture(async fixture => {
      let now = Date.now();
      const orders = new OrderService(fixture.database, () => fixture.services.settings.instanceSnapshot(), () => now, fixture.services.sites, "default");
      orders.initialize();
      const request = createOrderRequestSchema.parse({ idempotency_key: "audit-order-idempotency", merchant_order_no: "audit-order-merchant", amount_cents: 2_000, product_name: "审计测试订单" });
      const scope = createAuditContext({ actorType: "API_CLIENT", actorId: "default", requestId: "first-request", sourceAddress: "192.0.2.70", userAgent: "Client/1" });
      const first = runWithAuditContext(scope, () => orders.create(request));
      const retryScope = createAuditContext({ actorType: "API_CLIENT", actorId: "default", requestId: "second-request", sourceAddress: "192.0.2.71", userAgent: "Client/2" });
      const second = runWithAuditContext(retryScope, () => orders.create(request));
      assert.equal(first.created, true); assert.equal(second.created, false);
      assert.equal(first.order.orderId, second.order.orderId);
      const fingerprint = fixture.database.read(db => db.prepare("SELECT request_fingerprint FROM payment_orders WHERE order_id = ?").get(first.order.orderId))!.request_fingerprint;
      assert.equal(fingerprint, fingerprintCreateOrderRequest(request));
      assert.equal(scope.coreEventIds.length, 1);
      assert.equal(retryScope.coreEventIds.length, 0);
      runWithAuditContext(retryScope, () => orders.close(first.order.orderId));
      runWithAuditContext(retryScope, () => orders.close(first.order.orderId));
      const expiring = orders.create({ ...request, idempotency_key: "audit-expiry-idem", merchant_order_no: "audit-expiry-merchant" });
      now = expiring.order.checkout.expiresAt + 1;
      assert.equal(orders.get(expiring.order.orderId).checkout.status, "EXPIRED");
      const actions = fixture.database.read(db => db.prepare("SELECT action FROM audit_events WHERE subject_id = ? ORDER BY sequence").all(first.order.orderId)) as { action: string }[];
      assert.deepEqual(actions.map(row => row.action), ["orders.created", "orders.checkout_closed"]);
      const expiry = fixture.database.read(db => db.prepare("SELECT actor_type FROM audit_events WHERE action = 'orders.checkout_expired' AND subject_id = ?").all(expiring.order.orderId));
      assert.equal(expiry.length, 1); assert.equal(expiry[0]!.actor_type, "SYSTEM");
      assert.equal(latestContext(fixture.database, "orders.created").site_id, "default");
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });

  it("rolls back financial state on core failure and keeps the committed operation fingerprint independent of retry context", async () => {
    await withHttpFixture(async fixture => {
      const order = fixture.createOrder("audit-financial", 2_700);
      const entry = fixture.recordCredit("audit-financial-credit", order.payableAmountCents, 1);
      const snapshot = () => fixture.database.read(db => Object.fromEntries(["financial_operations", "payment_matches", "match_candidates", "outbox_events", "order_events", "payment_orders"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const before = snapshot();
      fixture.database.write(db => db.exec("CREATE TEMP TRIGGER reject_financial_audit BEFORE INSERT ON audit_events WHEN NEW.action LIKE 'financial.%' BEGIN SELECT RAISE(ABORT, 'injected financial audit failure'); END"));
      assert.throws(() => fixture.reconciliation.reconcileEntry(entry.ledgerEntryId), /injected financial audit failure/);
      assert.deepEqual(snapshot(), before);
      fixture.database.write(db => db.exec("DROP TRIGGER reject_financial_audit"));
      const scope = createAuditContext({ actorType: "SYSTEM", actorId: "reconciliation" });
      const result = runWithAuditContext(scope, () => fixture.reconciliation.reconcileEntry(entry.ledgerEntryId));
      assert.equal(result.kind, "auto_settled");
      const financial = fixture.database.read(db => db.prepare("SELECT request_fingerprint, request_json FROM financial_operations ORDER BY rowid").all());
      const retryScope = createAuditContext({ actorType: "ADMIN", actorId: "admin", requestId: "manual-retry", sourceAddress: "192.0.2.90", userAgent: "Browser/3" });
      runWithAuditContext(retryScope, () => fixture.reconciliation.reconcileEntry(entry.ledgerEntryId));
      assert.deepEqual(fixture.database.read(db => db.prepare("SELECT request_fingerprint, request_json FROM financial_operations ORDER BY rowid").all()), financial);
      assert.equal(financial.length, 1);
      assert.equal(String(financial[0]!.request_json).includes(scope.activityId), false);
      assert.equal(String(financial[0]!.request_json).includes(retryScope.activityId), false);
      assert.equal(Number(fixture.database.read(db => db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'financial.auto_settlement'").get()!.n)), 1);
      assert.equal(scope.coreEventIds.length, 1);
      assert.equal(retryScope.coreEventIds.length, 0);
      const context = latestContext(fixture.database, "financial.auto_settlement");
      assert.equal(context.activity_id, scope.activityId);
      assert.equal(context.site_id, "default");
      assert.equal(context.source_address, null);
      assert.equal(fixture.database.integrityCheck().ok, true);
    });
  });
});
