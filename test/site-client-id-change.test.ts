import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { migrations, migrationChecksum } from "../src/database/migrations.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { migrateAlipayAccounts } from "../src/alipay-accounts/migration.ts";
import { SITE_API_CLIENT_IDS_SCHEMA_SQL } from "../src/sites/migrations/api-client-ids.ts";
import { countSiteDomainViolations } from "../src/sites/integrity.ts";
import { SiteStore } from "../src/sites/store.ts";
import { SiteWebhookProcessor } from "../src/notifications/site-processor.ts";
import { webhookSignature } from "../src/notifications/model.ts";
import { createSiteFixture } from "./site-fixture.ts";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { enableNotifications, withHttpFixture } from "./reconciliation-http-fixture.ts";

const audit = { actorId: "admin" };
function prepared() {
  const fixture = createSiteFixture();
  fixture.migrate();
  fixture.connection.exec(SITE_API_CLIENT_IDS_SCHEMA_SQL);
  const store = fixture.store();
  const create = (client_id: string) => ({ operation_id: randomUUID(), client_id, configuration: {
    name: client_id, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: store.defaults().policy,
  } });
  return { ...fixture, store, create };
}

describe("public client ID changes", () => {
  it("keeps stable ownership and idempotent commands across two changes, no-ops and deletion", () => {
    const f = prepared();
    try {
      const original = f.create("Original.Shop");
      const site = f.store.create(original, audit, 10);
      const api = f.store.rotateSecret(site.clientId, "api_secret", site.revision, audit, 11);
      const notification = f.store.rotateSecret(site.clientId, "webhook_secret", api.site.revision, audit, 12);
      const ciphertext = f.connection.prepare("SELECT * FROM site_secrets ORDER BY secret_name").all();
      const first = { operation_id: randomUUID(), revision: notification.site.revision, client_id: "Public.Shop" };
      const renamed = f.store.changeClientId(site.clientId, first, audit, 20);
      assert.equal(renamed.clientId, site.clientId);
      assert.equal(renamed.apiClientId, first.client_id);
      assert.equal(renamed.revision, first.revision + 1);
      assert.equal(f.store.credential(site.clientId), null);
      assert.equal(f.store.credential(first.client_id)?.secret, api.secret);
      assert.equal(f.store.credential(first.client_id)?.clientId, site.clientId);
      assert.equal(f.store.notificationSecret(site.clientId), notification.secret);
      assert.deepEqual(f.connection.prepare("SELECT * FROM site_secrets ORDER BY secret_name").all(), ciphertext);
      assert.equal(f.store.list(null, 20, "public.shop")[0]?.clientId, site.clientId);
      assert.equal(f.store.create(original, audit).apiClientId, first.client_id);
      assert.deepEqual(f.store.changeClientId(site.clientId, first, audit, 21), renamed);
      assert.throws(() => f.store.changeClientId(site.clientId, { ...first, client_id: "Changed.Payload" }, audit), { code: "site_operation_conflict" });
      assert.throws(() => f.store.changeClientId(site.clientId, { ...first, operation_id: randomUUID() }, audit), { code: "site_revision_conflict" });

      const noop = { operation_id: randomUUID(), revision: renamed.revision, client_id: renamed.apiClientId };
      assert.equal(f.store.changeClientId(site.clientId, noop, audit, 100).revision, renamed.revision);
      const second = f.store.changeClientId(site.clientId, { operation_id: randomUUID(), revision: renamed.revision, client_id: "Final.Shop" }, audit, 50);
      assert.equal(f.store.changeClientId(site.clientId, first, audit).apiClientId, second.apiClientId);
      assert.equal(f.store.changeClientId(site.clientId, noop, audit).apiClientId, second.apiClientId);
      assert.equal(f.store.credential(first.client_id), null);
      assert.equal(f.store.credential(second.apiClientId)?.secret, api.secret);
      for (const client_id of [site.clientId, first.client_id]) {
        assert.throws(() => f.store.changeClientId(site.clientId, { operation_id: randomUUID(), revision: second.revision, client_id }, audit), { code: "site_client_id_conflict" });
        assert.throws(() => f.store.create(f.create(client_id), audit), { code: "site_client_id_conflict" });
      }
      assert.equal(countSiteDomainViolations(f.connection), 0);
      f.store.delete(site.clientId, second.revision, audit, 60);
      assert.equal(f.store.credential(second.apiClientId), null);
      assert.throws(() => f.store.create(f.create(second.apiClientId), audit), { code: "site_client_id_conflict" });
      assert.notEqual(f.store.changeClientId(site.clientId, first, audit).deletedAt, null);
      assert.equal(countSiteDomainViolations(f.connection), 0);
    } finally { f.close(); }
  });

  it("rolls back alias retirement, revision and operation records when audit append fails", () => {
    const f = prepared();
    try {
      const site = f.store.create(f.create("Rollback.Shop"), audit);
      const snapshot = () => ["sites", "site_api_client_ids", "site_client_id_changes", "audit_events"].map(table => f.connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all());
      const before = snapshot();
      f.connection.exec("CREATE TEMP TRIGGER block_id_audit BEFORE INSERT ON audit_events WHEN NEW.action='site.client_id_changed' BEGIN SELECT RAISE(ABORT,'injected rename audit failure'); END");
      const command = { operation_id: randomUUID(), revision: site.revision, client_id: "Available.Shop" };
      assert.throws(() => f.store.changeClientId(site.clientId, command, audit), /injected rename audit failure/);
      assert.deepEqual(snapshot(), before);
      f.connection.exec("DROP TRIGGER block_id_audit");
      assert.equal(f.store.changeClientId(site.clientId, command, audit).apiClientId, command.client_id);
      assert.equal(countSiteDomainViolations(f.connection), 0);
    } finally { f.close(); }
  });

  it("detects mapping and rename-history tampering with a structurally valid schema", () => {
    const f = prepared();
    try {
      const site = f.store.create(f.create("Integrity.Shop"), audit);
      const changed = f.store.changeClientId(site.clientId, { operation_id: randomUUID(), revision: 0, client_id: "Integrity.Public" }, audit);
      assert.equal(countSiteDomainViolations(f.connection), 0);
      const trigger = f.connection.prepare("SELECT sql FROM sqlite_schema WHERE name='site_api_client_ids_retirement_guard'").get()!.sql as string;
      f.connection.exec("DROP TRIGGER site_api_client_ids_retirement_guard");
      f.connection.prepare("UPDATE site_api_client_ids SET retired_at=created_at WHERE api_client_id=?").run(changed.apiClientId);
      f.connection.exec(trigger);
      assert.ok(countSiteDomainViolations(f.connection) > 0);
    } finally { f.close(); }
  });
});

it("migrates actual schema 39 identities, ciphertext, audit hashes and historical reservations into schema 40", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-public-id-migration-"));
  const legacy = await createConfiguredLegacyHttpServices({ directory, apiSecret: Buffer.alloc(32, 9).toString("base64url"), collectionCodePayload: "https://qr.alipay.com/public-id-migration" });
  let upgraded: AppDatabase | undefined;
  try {
    legacy.database.write(connection => {
      for (const migration of migrations.filter(item => item.version >= 34 && item.version <= 39)) {
        connection.exec(migration.sql);
        if (migration.postApply === "migrate_websites_v1") migrateSiteData(connection, legacy.config.masterKey);
        if (migration.postApply === "migrate_alipay_accounts_v1") migrateAlipayAccounts(connection, legacy.config.masterKey);
        connection.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
      }
      connection.prepare("INSERT INTO api_client_idempotency_namespaces(client_id,namespace_id,recorded_at) VALUES ('default','Historical.Shop',1)").run();
    });
    const oldSites = new SiteStore(legacy.database, legacy.config.masterKey);
    const policy = oldSites.defaults().policy;
    const tombstone = oldSites.create({ operation_id: randomUUID(), client_id: "Deleted.Shop", configuration: {
      name: "Deleted", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy,
    } }, audit);
    oldSites.delete(tombstone.clientId, 0, audit);
    const tables = ["sites", "site_secrets", "site_creation_requests", "api_client_config", "api_client_keys", "webhook_signing_keys", "audit_events"];
    const before = legacy.database.read(connection => tables.map(table => connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()));
    const credential = oldSites.credential("default");
    assert.ok(credential);
    assert.equal(legacy.database.integrityCheck().ok, true);
    legacy.database.close();
    upgraded = await AppDatabase.open(legacy.config.databasePath, { masterKey: legacy.config.masterKey });
    assert.equal(upgraded.read(connection => connection.prepare("SELECT max(version) AS version FROM schema_migrations").get()!.version), BigInt(migrations.at(-1)!.version));
    assert.deepEqual(upgraded.read(connection => tables.map(table => connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all())), before);
    const sites = new SiteStore(upgraded, legacy.config.masterKey);
    assert.deepEqual(sites.credential("default"), credential);
    assert.equal(sites.get("default")?.apiClientId, "default");
    const reserved = upgraded.read(connection => connection.prepare("SELECT * FROM site_api_client_ids WHERE api_client_id IN ('Historical.Shop','Deleted.Shop') ORDER BY api_client_id").all());
    assert.equal(reserved.length, 2);
    assert.ok(reserved.every(row => row.retired_at !== null));
    assert.equal(upgraded.integrityCheck().ok, true);
  } finally {
    upgraded?.close();
    legacy.database.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("preserves financial evidence and delivers a pre-rename notification with the original signing key", async () => {
  await withHttpFixture(async fixture => {
    const { notifyUrl } = enableNotifications(fixture);
    const { order } = fixture.createSettlement("public-id-history", 999, notifyUrl);
    const sites = fixture.services.sites;
    const credential = sites.credential("default")!;
    const notificationSecret = sites.notificationSecret("default")!;
    const now = Date.now();
    fixture.webhooks.materialize(100, now);
    const tables = ["payment_orders", "checkout_sessions", "order_events", "financial_operations", "outbox_events", "webhook_targets", "webhook_deliveries", "site_secrets", "api_client_keys", "webhook_signing_keys"];
    const before = fixture.database.read(connection => tables.map(table => connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()));
    const current = sites.get("default")!;
    sites.changeClientId("default", { operation_id: randomUUID(), revision: current.revision, client_id: "Payment.Public" }, audit);
    const recorded = fixture.database.read(connection => connection.prepare(`SELECT context.site_id, context.context_json
      FROM audit_events AS event JOIN audit_event_context AS context USING(event_id)
      WHERE event.action='site.client_id_changed' AND event.subject_id='default'`).get())!;
    assert.equal(recorded.site_id, "default");
    assert.deepEqual(JSON.parse(String(recorded.context_json)).changes,
      [{ field: "api_client_id", kind: "value", before: "default", after: "Payment.Public" }]);
    assert.deepEqual(fixture.database.read(connection => tables.map(table => connection.prepare("SELECT * FROM " + table + " ORDER BY rowid").all())), before);
    assert.equal(sites.credential("default"), null);
    assert.equal(sites.credential("Payment.Public")?.secret, credential.secret);
    assert.equal(fixture.services.orders.adminCheckoutToken(order.orderId), order.checkoutToken);
    const processor = new SiteWebhookProcessor({ sites, webhooks: fixture.webhooks, clock: () => now + 1000, transport: clientId => ({
      async post(input) {
        assert.equal(clientId, "default");
        const headers = input.headers;
        assert.equal(headers["x-perpay-webhook-signature"], webhookSignature({ secret: notificationSecret,
          keyId: headers["x-perpay-webhook-key-id"]!, timestamp: Number(headers["x-perpay-webhook-timestamp"]),
          deliveryId: headers["x-perpay-webhook-delivery-id"]!, eventId: headers["x-perpay-webhook-event-id"]!,
          attemptNumber: Number(headers["x-perpay-webhook-attempt"]), body: input.body }));
        const body = Buffer.from(JSON.stringify({ schema: "perpay:webhook-ack:v1", ack: true,
          event_id: headers["x-perpay-webhook-event-id"], delivery_id: headers["x-perpay-webhook-delivery-id"] }));
        return { status: 200, contentType: "application/json", contentEncoding: "identity", body,
          responseFingerprint: createHash("sha256").update(body).digest("hex"), resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8" };
      },
    }) });
    assert.equal((await processor.processOne()).outcome, "ACKNOWLEDGED");
    assert.equal(fixture.database.integrityCheck().ok, true);
    const target = join(fixture.directory, "renamed-backup.sqlite3");
    await fixture.database.backup(target);
    const restored = await AppDatabase.open(target, { masterKey: fixture.services.config.masterKey });
    try {
      const reopened = new SiteStore(restored, fixture.services.config.masterKey);
      assert.equal(reopened.get("default")?.apiClientId, "Payment.Public");
      assert.equal(reopened.credential("Payment.Public")?.secret, credential.secret);
      assert.equal(restored.integrityCheck().ok, true);
    } finally { restored.close(); }
  });
});
