// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID, sign, verify } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertDatabaseIntegrity } from "../src/database/database.ts";
import { EpayStore, insertEpayOrder } from "../src/epay/store.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

const audit = { actorId: "admin" };

test("epay merchant identity survives public ID changes and website deletion", async () => {
  const f = await createSitePaymentFixture();
  try {
    const store = f.settings.epayStore()!;
    assert.ok(store.get("default").pid);
    const site = f.createSite("接入网站");
    const initial = store.get(site.clientId);
    assert.match(initial.pid, /^[1-9]\d*$/);
    assert.equal(initial.v1KeyVersion, 0);
    assert.equal(initial.merchantPublicKey, null);
    const renamed = f.sites.changeClientId(site.clientId, { operation_id: randomUUID(), revision: site.revision, client_id: "renamed-shop" }, audit);
    assert.equal(store.get(site.clientId).pid, initial.pid);
    assert.equal(store.get(site.clientId).clientId, "renamed-shop");
    f.sites.delete(site.clientId, renamed.revision, audit);
    assert.equal(store.credential(initial.pid), null);
    const next = f.createSite("下一个网站");
    assert.notEqual(store.get(next.clientId).pid, initial.pid);
    assert.equal(f.database.read(db => db.prepare("SELECT site_id FROM epay_sites WHERE pid = ?").get(initial.pid)?.site_id), site.clientId);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("epay key material is encrypted, versioned, auditable and reloadable", async () => {
  const f = await createSitePaymentFixture();
  try {
    const store = f.settings.epayStore()!;
    const site = f.createSite("密钥网站");
    const configured = store.update(site.clientId, { revision: 0, v1_enabled: true, v2_enabled: true }, audit);
    const credential = store.credential(configured.pid, { protocol: "epay_v2", forCreation: true })!;
    assert.match(credential.v1Key!, /^[a-f0-9]{32}$/);
    assert.equal(credential.merchantKeyVersion, 1);
    assert.equal(credential.platformKeyVersion, 1);
    const message = Buffer.from("key directions stay independent");
    const signature = sign("RSA-SHA256", message, credential.merchantPrivateKey!);
    assert.equal(verify("RSA-SHA256", message, credential.merchantPublicKey!, signature), true);
    assert.equal(verify("RSA-SHA256", message, credential.platformPublicKey!, signature), false);
    const encrypted = f.database.read(db => db.prepare("SELECT ciphertext FROM epay_credentials WHERE site_id = ?").all(site.clientId));
    assert.equal(encrypted.length, 3);
    for (const row of encrypted) {
      const text = Buffer.from(row.ciphertext as Uint8Array).toString();
      assert.ok(!text.includes("PRIVATE KEY"));
      assert.notEqual(text, credential.v1Key);
    }
    const reloaded = new EpayStore(f.database, f.config.masterKey);
    assert.equal(reloaded.reveal(site.clientId, "v2_merchant", audit).secret, credential.merchantPrivateKey);
    assert.throws(() => new EpayStore(f.database, Buffer.alloc(32, 99)).credential(configured.pid), /could not be decrypted/);
    assert.throws(() => store.update(site.clientId, { revision: 0, v1_enabled: false, v2_enabled: false }, audit), { code: "epay_revision_conflict" });
    const rotated = store.rotate(site.clientId, "v1_key", configured.revision, audit);
    assert.equal(rotated.configuration.v1KeyVersion, 2);
    assert.notEqual(rotated.credentials.v1Key, credential.v1Key);
    assert.notEqual(rotated.credentials.v1KeyId, credential.v1KeyId);
    assert.equal(f.database.read(db => db.prepare("SELECT retired_at FROM epay_credentials WHERE credential_id = ?").get(credential.v1KeyId!)?.retired_at) !== null, true);
    const disabled = store.update(site.clientId, { revision: rotated.configuration.revision, v1_enabled: false, v2_enabled: false }, audit);
    assert.equal(store.credential(disabled.pid, { protocol: "epay_v1", forCreation: true }), null);
    assert.ok(store.credential(disabled.pid, { protocol: "epay_v1" }));
    const logs = JSON.stringify(f.database.read(db => db.prepare("SELECT details_json FROM audit_events WHERE subject_id = ?").all(site.clientId)));
    assert.ok(!logs.includes(credential.v1Key!));
    assert.ok(!logs.includes("PRIVATE KEY"));
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("complete native and epay exports validate one versioned snapshot and audit atomically", async () => {
  const f = await createSitePaymentFixture();
  try {
    const store = f.settings.epayStore()!;
    let site = f.createSite("导出网站");
    const api = f.sites.rotateSecret(site.clientId, "api_secret", site.revision, audit);
    const webhook = f.sites.rotateSecret(site.clientId, "webhook_secret", api.site.revision, audit);
    site = webhook.site;
    const native = store.exportConfiguration(site.clientId, { protocol: "native", siteRevision: site.revision, epayRevision: 0 }, audit);
    assert.equal(native.apiSecret, api.secret);
    assert.equal(native.webhookSecret, webhook.secret);
    const config = store.update(site.clientId, { revision: 0, v1_enabled: false, v2_enabled: true }, audit);
    const input = { protocol: "epay_v2" as const, siteRevision: site.revision, epayRevision: config.revision };
    const exported = store.exportConfiguration(site.clientId, input, audit);
    assert.equal(store.exportConfiguration(site.clientId, input, audit).credentials!.merchantPrivateKey, exported.credentials!.merchantPrivateKey);
    assert.throws(() => store.exportConfiguration(site.clientId, { ...input, siteRevision: site.revision - 1 }, audit), { code: "site_revision_conflict" });
    assert.throws(() => store.exportConfiguration(site.clientId, { ...input, epayRevision: 0 }, audit), { code: "epay_revision_conflict" });
    const before = f.database.read(db => db.prepare("SELECT count(*) AS count FROM audit_events").get()!.count);
    f.database.read(db => db.exec("CREATE TEMP TRIGGER reject_epay_export BEFORE INSERT ON audit_events WHEN NEW.action = 'epay.configuration_exported' BEGIN SELECT RAISE(ABORT, 'export audit failed'); END"));
    assert.throws(() => store.exportConfiguration(site.clientId, input, audit), /export audit failed/);
    assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS count FROM audit_events").get()!.count), before);
  } finally { f.close(); }
});

test("failed epay credential initialization rolls back configuration and secrets", async () => {
  const f = await createSitePaymentFixture();
  try {
    const store = f.settings.epayStore()!;
    const site = f.createSite("回滚网站");
    f.database.read(db => db.exec("CREATE TEMP TRIGGER reject_epay_key BEFORE INSERT ON audit_events WHEN NEW.action = 'epay.secret_rotated' BEGIN SELECT RAISE(ABORT, 'key audit failed'); END"));
    assert.throws(() => store.update(site.clientId, { revision: 0, v1_enabled: true, v2_enabled: true }, audit), /key audit failed/);
    assert.equal(store.get(site.clientId).revision, 0);
    assert.equal(store.get(site.clientId).v1Enabled, false);
    assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS count FROM epay_credentials WHERE site_id = ?").get(site.clientId)!.count), 0n);
  } finally { f.close(); }
});

test("compatibility metadata commits with the core order and is preserved in verified backups", async () => {
  const f = await createSitePaymentFixture();
  try {
    const store = f.settings.epayStore()!;
    const site = f.createSite("订单网站");
    const config = store.update(site.clientId, { revision: 0, v1_enabled: true, v2_enabled: false }, audit);
    const request = { idempotency_key: "epay-order-one", merchant_order_no: "USR1NOabc123", amount_cents: 1000, product_name: "商品" };
    const metadata = { siteId: site.clientId, protocol: "epay_v1" as const, configurationRevision: config.revision,
      requestFingerprint: "a".repeat(64), param: "0", returnUrl: null };
    const created = f.orders.forSite(site.clientId).create(request, undefined, metadata);
    const stored = store.order(created.order.orderId)!;
    assert.equal(stored.param, "0");
    assert.equal(stored.pid, config.pid);
    assert.match(stored.tradeNo, /^[1-9]\d*$/);
    assert.equal(store.findOrder(site.clientId, { outTradeNo: request.merchant_order_no })!.orderId, created.order.orderId);
    assert.equal(store.findOrder(site.clientId, { tradeNo: stored.tradeNo, outTradeNo: "ignored" })!.orderId, created.order.orderId);
    assert.equal(store.findOrder("default", { tradeNo: stored.tradeNo }), null);
    assert.equal(store.stats(site.clientId).total, 1);
    assert.equal(store.orders(site.clientId).length, 1);
    assert.equal(f.orders.forSite(site.clientId).create(request, undefined, metadata).created, false);
    assert.throws(() => f.orders.forSite(site.clientId).create(request, undefined, { ...metadata, param: "changed", requestFingerprint: "b".repeat(64) }), { code: "idempotency_conflict" });
    assert.throws(() => f.database.write(db => insertEpayOrder(db, { ...metadata, orderId: created.order.orderId, createdAt: stored.createdAt })), /uncommitted order/);
    const before = f.database.read(db => db.prepare("SELECT count(*) AS count FROM payment_orders").get()!.count);
    f.database.read(db => db.exec("CREATE TEMP TRIGGER fail_epay_order AFTER INSERT ON epay_orders BEGIN SELECT RAISE(ABORT, 'metadata failed'); END"));
    assert.throws(() => f.orders.forSite(site.clientId).create({ ...request, idempotency_key: "second", merchant_order_no: "USR2NOabc123" }, undefined, metadata), /metadata failed/);
    assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS count FROM payment_orders").get()!.count), before);
    f.database.read(db => db.exec("DROP TRIGGER fail_epay_order"));
    assert.equal(f.database.integrityCheck().ok, true);
    const path = join(f.config.backupDir, "epay-verified.sqlite3");
    await f.database.backup(path);
    const backup = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true, readBigInts: true });
    try {
      assertDatabaseIntegrity(backup, "epay backup");
      assert.equal(backup.prepare("SELECT param FROM epay_orders WHERE order_id = ?").get(created.order.orderId)!.param, "0");
      assert.equal(backup.prepare("SELECT count(*) AS count FROM epay_credentials WHERE site_id = ?").get(site.clientId)!.count, 1n);
    } finally { backup.close(); }
  } finally { f.close(); }
});
