// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { EpayStore } from "../src/epay/store.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { SiteStore } from "../src/sites/store.ts";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { createSitePaymentFixture } from "./site-payment-fixture.ts";

const audit = { actorId: "admin" };

function creation(sites: SiteStore, name: string) {
  return { operation_id: randomUUID(), configuration: {
    name, accepting_orders: true, notifications_enabled: false,
    notification_origin: null, return_origin: null, policy: sites.defaults().policy,
  } };
}

function initializationState(database: AppDatabase) {
  const tables = ["sites", "api_client_config", "api_client_idempotency_namespaces", "site_api_client_ids",
    "site_creation_requests", "epay_sites", "epay_credentials", "audit_events", "runtime_master_key_guard"];
  return database.read(db => Object.fromEntries(tables.map(table => [
    table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ])));
}

async function createUninitializedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "perpay-epay-defaults-"));
  const legacy = await createConfiguredLegacyHttpServices({
    directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/epay-defaults",
  });
  const config = legacy.config;
  legacy.database.close();
  let database = await AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
  return {
    config,
    get database() { return database; },
    async reopen() {
      database.close();
      database = await AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
    },
    close() {
      database.close();
      const path = resolve(directory);
      assert.equal(dirname(path), resolve(tmpdir()));
      assert.ok(basename(path).startsWith("perpay-epay-defaults-"));
      rmSync(path, { recursive: true });
    },
  };
}

test("new websites initialize both protocols atomically and replay creation without rotating credentials", async () => {
  const f = await createSitePaymentFixture();
  try {
    const input = creation(f.sites, "默认接入网站");
    const site = f.sites.create(input, audit);
    const epay = new EpayStore(f.database, f.config.masterKey);
    const configured = epay.credentialsForSite(site.clientId)!;
    assert.equal(configured.revision, 1);
    assert.equal(configured.v1Enabled, true);
    assert.equal(configured.v2Enabled, true);
    assert.equal(configured.v1KeyVersion, 1);
    assert.equal(configured.merchantKeyVersion, 1);
    assert.equal(configured.platformKeyVersion, 1);
    assert.ok(configured.v1Key && configured.merchantPrivateKey && configured.platformPrivateKey);
    const before = initializationState(f.database);
    assert.deepEqual(f.sites.create(input, audit), site);
    assert.deepEqual(epay.credentialsForSite(site.clientId), configured);
    assert.deepEqual(initializationState(f.database), before);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("website creation rolls back identities, credentials and audit when key initialization or final audit fails", async () => {
  const f = await createSitePaymentFixture();
  try {
    for (const action of ["epay.secret_rotated", "site.created"]) {
      const input = creation(f.sites, `回滚 ${action}`);
      const before = initializationState(f.database);
      f.database.read(db => db.exec(`CREATE TEMP TRIGGER reject_default_creation BEFORE INSERT ON audit_events
        WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'default creation audit failed'); END`));
      assert.throws(() => f.sites.create(input, audit), /default creation audit failed/);
      assert.deepEqual(initializationState(f.database), before);
      f.database.read(db => db.exec("DROP TRIGGER reject_default_creation"));
      const recovered = f.sites.create(input, audit);
      const credentials = f.settings.epayStore()!.credentialsForSite(recovered.clientId)!;
      assert.equal(credentials.revision, 1);
      assert.equal(credentials.v1KeyVersion, 1);
      assert.equal(credentials.merchantKeyVersion, 1);
      assert.equal(credentials.platformKeyVersion, 1);
    }
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("startup initializes untouched upgraded websites once across a database reopen", async () => {
  const f = await createUninitializedFixture();
  try {
    const epay = new EpayStore(f.database, f.config.masterKey);
    assert.equal(epay.get("default").revision, 0);
    assert.equal(epay.get("default").v1KeyVersion, 0);
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    const configured = epay.credentialsForSite("default")!;
    assert.equal(configured.revision, 1);
    assert.equal(configured.v1Enabled, true);
    assert.equal(configured.v2Enabled, true);
    assert.equal(configured.v1KeyVersion, 1);
    assert.equal(configured.merchantKeyVersion, 1);
    assert.equal(configured.platformKeyVersion, 1);
    const logs = f.database.read(db => db.prepare("SELECT actor_type FROM audit_events WHERE action LIKE 'epay.%'").all());
    assert.ok(logs.length >= 3);
    assert.ok(logs.every(log => log.actor_type === "SYSTEM"));
    const before = initializationState(f.database);
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    assert.deepEqual(initializationState(f.database), before);
    await f.reopen();
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    assert.deepEqual(new EpayStore(f.database, f.config.masterKey).credentialsForSite("default"), configured);
    assert.deepEqual(initializationState(f.database), before);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("startup preserves explicitly disabled protocols and any prior credential material", async () => {
  const f = await createUninitializedFixture();
  try {
    const epay = new EpayStore(f.database, f.config.masterKey);
    epay.rotate("default", "v1_key", 0, audit);
    // Model a pre-initialization record that already has credential history.
    f.database.write(db => {
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'epay_sites_update_guard'").get()!.sql as string;
      db.exec("DROP TRIGGER epay_sites_update_guard");
      db.prepare("UPDATE epay_sites SET revision = 0 WHERE site_id = 'default'").run();
      db.exec(trigger);
    });
    const existing = epay.credentialsForSite("default")!;
    const sites = new SiteStore(f.database, f.config.masterKey);
    const site = sites.create(creation(sites, "主动关闭"), audit);
    const initialized = epay.get(site.clientId);
    epay.update(site.clientId, { revision: initialized.revision, v1_enabled: false, v2_enabled: false }, audit);
    const disabled = epay.credentialsForSite(site.clientId)!;
    const before = initializationState(f.database);
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    assert.deepEqual(epay.credentialsForSite("default"), existing);
    assert.deepEqual(epay.credentialsForSite(site.clientId), disabled);
    assert.deepEqual(initializationState(f.database), before);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("startup leaves deleted untouched websites uninitialized", async () => {
  const f = await createUninitializedFixture();
  try {
    const sites = new SiteStore(f.database, f.config.masterKey);
    sites.delete("default", sites.get("default")!.revision, audit);
    const before = initializationState(f.database);
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    assert.deepEqual(initializationState(f.database), before);
    assert.equal(f.database.read(db => db.prepare("SELECT revision FROM epay_sites WHERE site_id = 'default'").get()!.revision), 0n);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("startup initialization failures roll back defaults and retry cleanly", async () => {
  const f = await createUninitializedFixture();
  try {
    const before = initializationState(f.database);
    f.database.read(db => db.exec(`CREATE TEMP TRIGGER reject_default_startup BEFORE INSERT ON audit_events
      WHEN NEW.action = 'epay.secret_rotated' BEGIN SELECT RAISE(ABORT, 'default startup audit failed'); END`));
    assert.throws(() => new RuntimeSettingsStore(f.database, f.config.masterKey).initialize(), /default startup audit failed/);
    assert.deepEqual(initializationState(f.database), before);
    f.database.read(db => db.exec("DROP TRIGGER reject_default_startup"));
    new RuntimeSettingsStore(f.database, f.config.masterKey).initialize();
    const configured = new EpayStore(f.database, f.config.masterKey).get("default");
    assert.equal(configured.revision, 1);
    assert.equal(configured.v1Enabled, true);
    assert.equal(configured.v2Enabled, true);
    assert.equal(f.database.integrityCheck().ok, true);
  } finally { f.close(); }
});

test("incorrect master keys and missing guards reject startup and new websites without writing defaults", async () => {
  const f = await createUninitializedFixture();
  try {
    const wrongKey = randomBytes(32);
    const wrongSites = new SiteStore(f.database, wrongKey);
    const input = creation(wrongSites, "错误主密钥");
    const before = initializationState(f.database);
    assert.throws(() => new RuntimeSettingsStore(f.database, wrongKey).initialize(), /PERPAY_MASTER_KEY does not match/);
    assert.throws(() => wrongSites.create(input, audit), /PERPAY_MASTER_KEY does not match/);
    assert.deepEqual(initializationState(f.database), before);
    f.database.write(db => {
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'runtime_master_key_guard_no_delete'").get()!.sql as string;
      db.exec("DROP TRIGGER runtime_master_key_guard_no_delete");
      db.exec("DELETE FROM runtime_master_key_guard");
      db.exec(trigger);
    });
    const missingGuard = initializationState(f.database);
    assert.throws(() => new RuntimeSettingsStore(f.database, f.config.masterKey).initialize(), /guard is missing while encrypted settings still exist/);
    const correctSites = new SiteStore(f.database, f.config.masterKey);
    assert.throws(() => correctSites.create(creation(correctSites, "缺失主密钥校验"), audit), /guard is missing while encrypted settings still exist/);
    assert.deepEqual(initializationState(f.database), missingGuard);
  } finally { f.close(); }
});
