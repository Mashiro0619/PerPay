import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { SiteStore } from "../src/sites/store.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { OrderService } from "../src/orders/service.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { SiteWebhookProcessor } from "../src/notifications/site-processor.ts";
import { webhookSignature } from "../src/notifications/model.ts";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { withLegacyPaymentFixture } from "./legacy-payment-fixture.ts";
import { recordLedgerEntry } from "./reconciliation-http-fixture.ts";

const audit = { actorId: "admin" };
function temporary() { return mkdtempSync(join(tmpdir(), "perpay-sites-startup-")); }
function remove(directory: string) {
  const path = resolve(directory);
  assert.equal(dirname(path), resolve(tmpdir()));
  assert.ok(basename(path).startsWith("perpay-sites-startup-"));
  rmSync(path, { recursive: true });
}
function stores(database: AppDatabase, masterKey: Uint8Array) {
  const settings = new RuntimeSettingsStore(database, masterKey);
  settings.initialize();
  return { settings, sites: new SiteStore(database, masterKey) };
}

it("boots the current schema without an implicit website and persists independent keys through two restarts and backup", async () => {
  const directory = temporary(), path = join(directory, "db.sqlite3"), masterKey = randomBytes(32);
  let database = await AppDatabase.open(path, { masterKey });
  try {
    let { sites } = stores(database, masterKey);
    assert.deepEqual(sites.list(), []);
    assert.equal(database.read(db => db.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version), BigInt(DATABASE_COMPATIBILITY.maximum));
    const created = ["网站 A", "网站 B"].map(name => sites.create({ operation_id: randomUUID(), configuration: {
      name, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: sites.defaults().policy,
    } }, audit));
    const secrets = created.map(site => {
      assert.equal(sites.credential(site.clientId), null);
      const api = sites.rotateSecret(site.clientId, "api_secret", site.revision, audit);
      const webhook = sites.rotateSecret(site.clientId, "webhook_secret", api.site.revision, audit);
      return { clientId: site.clientId, api: api.secret, webhook: webhook.secret };
    });
    for (let restart = 0; restart < 2; restart++) {
      database.close(); database = await AppDatabase.open(path, { masterKey });
      ({ sites } = stores(database, masterKey));
      assert.equal(sites.get("default"), null);
      for (const secret of secrets) {
        assert.equal(sites.credential(secret.clientId)?.secret, secret.api);
        assert.equal(sites.notificationSecret(secret.clientId), secret.webhook);
        const current = sites.get(secret.clientId)!;
        secret.webhook = sites.rotateSecret(secret.clientId, "webhook_secret", current.revision, audit).secret;
      }
      assert.equal(database.integrityCheck().ok, true);
    }
    const backup = join(directory, "backup.sqlite3");
    await database.backup(backup);
    const restored = await AppDatabase.open(backup, { masterKey });
    try {
      const { sites: restoredSites } = stores(restored, masterKey);
      assert.deepEqual(restoredSites.list(), sites.list());
      for (const secret of secrets) assert.equal(restoredSites.notificationSecret(secret.clientId), secret.webhook);
      assert.equal(restored.integrityCheck().ok, true);
    } finally { restored.close(); }
  } finally { database.close(); remove(directory); }
});

it("rolls back a real 0.3.2 upgrade without the correct master key, then preserves historical orders and key identities", async () => {
  const directory = temporary();
  const secret = randomBytes(32).toString("base64url");
  const legacy = await createConfiguredLegacyHttpServices({ directory, apiSecret: secret, collectionCodePayload: "https://qr.alipay.com/upgrade-history" });
  let database: AppDatabase | undefined;
  try {
    const created = legacy.orders.create(createOrderRequestSchema.parse({ idempotency_key: "historical", merchant_order_no: "historical", product_name: "旧订单", amount_cents: 100 })).order;
    legacy.orders.close(created.orderId);
    const history = (db: Pick<AppDatabase, "read">) => db.read(connection => Object.fromEntries(
      ["payment_orders", "amount_slots", "checkout_sessions", "order_events", "api_client_keys", "api_nonces", "collection_profiles", "audit_events"].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ));
    const before = history(legacy.database);
    const encrypted = legacy.database.read(db => db.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all());
    legacy.database.close();
    for (const masterKey of [undefined, randomBytes(32)]) {
      await assert.rejects(AppDatabase.open(legacy.config.databasePath, masterKey ? { masterKey } : {}), /migration 34/);
      const connection = new DatabaseSync(legacy.config.databasePath, { readBigInts: true });
      try {
        assert.equal(connection.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version, 33n);
        assert.deepEqual(connection.prepare("SELECT * FROM runtime_secrets ORDER BY secret_name").all(), encrypted);
        assert.equal(connection.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sites'").get(), undefined);
      } finally { connection.close(); }
    }
    for (let restart = 0; restart < 2; restart++) {
      database = await AppDatabase.open(legacy.config.databasePath, { masterKey: legacy.config.masterKey });
      const { sites, settings } = stores(database, legacy.config.masterKey);
      assert.equal(sites.credential("default")?.secret, secret);
      assert.deepEqual(history(database), before);
      const orders = new OrderService(database, () => settings.instanceSnapshot(), undefined, sites, "default");
      assert.equal(orders.get(created.orderId).checkoutToken, created.checkoutToken);
      assert.equal(database.integrityCheck().ok, true);
      database.close(); database = undefined;
    }
  } finally { database?.close(); legacy.database.close(); remove(directory); }
});

it("preserves historical notification attempts and signature references before rotating two websites after upgrade", async () => {
  await withLegacyPaymentFixture(async f => {
    const { notifyUrl } = f.enableNotifications();
    f.createSettlement("historical-notice", 500, notifyUrl);
    f.webhooks.materialize(10, Date.now());
    const claim = f.webhooks.claimNext({ now: Date.now(), leaseMilliseconds: 30_000, maximumAttempts: 2 });
    assert.ok(claim);
    f.webhooks.completeAttempt({ deliveryId: claim.delivery.deliveryId, attemptId: claim.attempt.attemptId,
      leaseToken: claim.attempt.leaseToken, outcome: "RETRYABLE_FAILURE", now: Date.now(), maximumAttempts: 2,
      retryBaseMilliseconds: 1000, retryMaximumMilliseconds: 60_000, errorCode: "transport_timeout" });
    const history = (db: Pick<AppDatabase, "read">) => db.read(connection => ({
      keys: connection.prepare("SELECT key_version, key_id, secret_fingerprint, activated_at, retired_at FROM webhook_signing_keys ORDER BY key_version").all(),
      ...Object.fromEntries(["outbox_events", "webhook_targets", "webhook_deliveries", "webhook_attempts", "payment_orders", "audit_events"].map(table =>
        [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    }));
    const before = history(f.database), secret = f.services.settings.snapshot().webhook.secret;
    f.database.close();
    for (let restart = 0; restart < 2; restart++) {
      const database = await AppDatabase.open(f.services.config.databasePath, { masterKey: f.services.config.masterKey });
      try {
        const { sites } = stores(database, f.services.config.masterKey);
        assert.deepEqual(history(database), before);
        assert.equal(sites.notificationSecret("default"), secret);
        if (restart === 1) {
          const second = sites.create({ operation_id: randomUUID(), configuration: {
            name: "第二网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: sites.defaults().policy,
          } }, audit);
          sites.rotateSecret(second.clientId, "webhook_secret", second.revision, audit);
          sites.rotateSecret("default", "webhook_secret", sites.get("default")!.revision, audit);
          const historicalVersion: number = database.read(connection => Number(connection.prepare("SELECT key_version FROM webhook_attempts WHERE attempt_id = ?").get(claim.attempt.attemptId)?.key_version));
          assert.equal(historicalVersion, claim.key.keyVersion);
        }
        assert.equal(database.integrityCheck().ok, true);
      } finally { database.close(); }
    }
  });
});

it("upgrades an old instance, delivers and rotates both websites, then repeats delivery across two consecutive restarts", async () => {
  await withLegacyPaymentFixture(async f => {
    f.enableNotifications();
    const originalApi = f.services.settings.snapshot().apiSecret;
    const originalWebhook = f.services.settings.snapshot().webhook.secret;
    f.database.close();
    let database = await AppDatabase.open(f.services.config.databasePath, { masterKey: f.services.config.masterKey });
    try {
      let { sites, settings } = stores(database, f.services.config.masterKey);
      assert.equal(sites.credential("default")?.secret, originalApi);
      assert.equal(sites.notificationSecret("default"), originalWebhook);
      const second = sites.create({ operation_id: randomUUID(), configuration: {
        name: "第二网站", accepting_orders: true, notifications_enabled: false,
        notification_origin: "https://second.example.com", return_origin: null, policy: sites.defaults().policy,
      } }, audit);
      const api = sites.rotateSecret(second.clientId, "api_secret", second.revision, audit);
      const webhook = sites.rotateSecret(second.clientId, "webhook_secret", api.site.revision, audit);
      sites.update(second.clientId, { revision: webhook.site.revision,
        configuration: { ...webhook.site.configuration, notifications_enabled: true } }, audit);
      const clients = ["default", second.clientId];
      const evidence = () => database.read(connection => Object.fromEntries([
        "sites", "site_secrets", "api_client_keys", "webhook_signing_keys", "payment_orders",
        "webhook_targets", "outbox_events", "webhook_deliveries", "webhook_attempts",
      ].map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
      const timestamp = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
      for (let restart = 0; restart <= 2; restart++) {
        const orders = new OrderService(database, () => settings.instanceSnapshot(), undefined, sites);
        const ledger = new LedgerStore(database), reconciliation = new ReconciliationStore(database);
        const secrets = new Map(clients.map(clientId => [clientId, sites.notificationSecret(clientId)!]));
        for (const clientId of clients) {
          const site = sites.get(clientId)!;
          const order = orders.forSite(clientId).create(createOrderRequestSchema.parse({
            idempotency_key: "restart-" + restart, merchant_order_no: "restart-" + restart,
            product_name: "重启后投递", amount_cents: 1000 + restart * 1000,
            notify_url: site.configuration.notification_origin + "/notify",
          })).order;
          const entry = recordLedgerEntry(ledger, {
            start: timestamp(order.createdAt - 60_000), end: timestamp(order.createdAt + 60_000),
          }, randomUUID(), order.payableAmountCents, order.createdAt + 1000, order.createdAt - 60_000,
          "CREDIT", settings.instanceSnapshot().activeProviderAccountKey!);
          assert.equal(reconciliation.reconcileEntry(entry.ledgerEntryId).kind, "auto_settled");
        }
        const sent: string[] = [];
        const processor = new SiteWebhookProcessor({ sites, webhooks: new WebhookStore(database), transport: (clientId, origin) => ({
          async post(input) {
            sent.push(clientId);
            assert.equal(new URL(input.targetUrl).origin, origin);
            const keyId = input.headers["x-perpay-webhook-key-id"]!;
            const key = database.read(connection => connection.prepare("SELECT client_id, site_key_version FROM webhook_signing_keys WHERE key_id = ?").get(keyId));
            assert.equal(key?.client_id, clientId);
            assert.equal(Number(key?.site_key_version), restart + 1);
            assert.equal(input.headers["x-perpay-webhook-signature"], webhookSignature({
              secret: secrets.get(clientId)!, keyId, timestamp: Number(input.headers["x-perpay-webhook-timestamp"]),
              deliveryId: input.headers["x-perpay-webhook-delivery-id"]!, eventId: input.headers["x-perpay-webhook-event-id"]!,
              attemptNumber: Number(input.headers["x-perpay-webhook-attempt"]), body: input.body,
            }));
            const body = Buffer.from(JSON.stringify({ schema: "perpay:webhook-ack:v1", ack: true,
              event_id: input.headers["x-perpay-webhook-event-id"], delivery_id: input.headers["x-perpay-webhook-delivery-id"] }));
            return { status: 200, contentType: "application/json", contentEncoding: "identity", body,
              responseFingerprint: createHash("sha256").update(body).digest("hex"),
              resolvedAddressesFingerprint: "a".repeat(64), connectedAddress: "8.8.8.8" };
          },
        }) });
        for (let attempt = 0; attempt < clients.length; attempt++) {
          assert.equal((await processor.processOne()).outcome, "ACKNOWLEDGED");
        }
        assert.deepEqual(new Set(sent), new Set(clients));
        assert.equal((await processor.processOne()).processed, false);
        assert.equal(database.integrityCheck().ok, true);
        if (restart === 2) break;
        const credentials = clients.map(clientId => {
          const api = sites.rotateSecret(clientId, "api_secret", sites.get(clientId)!.revision, audit);
          const webhook = sites.rotateSecret(clientId, "webhook_secret", api.site.revision, audit);
          assert.notEqual(webhook.secret, secrets.get(clientId));
          return { clientId, api: api.secret, webhook: webhook.secret };
        });
        assert.equal(database.integrityCheck().ok, true);
        const before = evidence();
        database.close();
        database = await AppDatabase.open(f.services.config.databasePath, { masterKey: f.services.config.masterKey });
        ({ sites, settings } = stores(database, f.services.config.masterKey));
        assert.deepEqual(evidence(), before, "reopening must not alter business keys or delivery evidence");
        for (const expected of credentials) {
          assert.equal(sites.credential(expected.clientId)?.secret, expected.api);
          assert.equal(sites.notificationSecret(expected.clientId), expected.webhook);
        }
        assert.equal(database.integrityCheck().ok, true);
      }
    } finally { database.close(); }
  });
});
