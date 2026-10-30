import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { AlipayAccountError, AlipayAccountService, AlipayAccountStore } from "../src/alipay-accounts/index.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { OrderService } from "../src/orders/service.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { WebhookStore } from "../src/notifications/store.ts";
import { createLocalBackup, restoreLocalBackup } from "../src/backup/repository.ts";
import { SiteError } from "../src/sites/store.ts";
import { keyAudit, keyMaster, privatePem, platformPem, nextPlatformPem } from "./application-key-fixture.ts";

function services(database: AppDatabase) {
  const settings = new RuntimeSettingsStore(database, keyMaster);
  settings.initialize();
  const store = new AlipayAccountStore(database, keyMaster);
  const orders = new OrderService(database, () => settings.instanceSnapshot(), undefined,
    settings.siteStore()!, undefined, { accounts: () => store.snapshots() });
  const runtime = new RuntimeController({ database, orders,
    ledger: new LedgerStore(database), reconciliation: new ReconciliationStore(database),
    webhooks: new WebhookStore(database), sites: settings.siteStore(), accounts: () => store.snapshots() });
  const accounts = new AlipayAccountService({ store,
    onMutationStarted: id => runtime.beginAccountTransition(id),
    onApplied: id => runtime.applyAccounts(id),
    guardProviderSwitch: ({ current }) => runtime.assertAccountProviderSwitchAllowed(current) });
  return { settings, store, runtime, accounts };
}

function immutableEvidence(database: AppDatabase) {
  return database.read(db => Object.fromEntries([
    "collection_profiles", "collection_profile_provider_accounts", "collection_profile_activations",
    "provider_account_bindings", "alipay_account_generations",
  ].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

it("deletes an unused account after real runtime profile creation and preserves its evidence across restart", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External fetch is forbidden in account deletion tests"); });
  const directory = mkdtempSync(join(tmpdir(), "perpay-account-deletion-"));
  const path = join(directory, "state.sqlite3");
  let database: AppDatabase | null = await AppDatabase.open(path, { masterKey: keyMaster });
  let current = services(database);
  try {
    await current.runtime.start(current.settings.instanceSnapshot());
    let account = await current.accounts.create({ name: "未使用账号", app_id: "unused-app", code_payload: "https://qr.alipay.com/unused-one" }, keyAudit());
    account = await current.accounts.generateApplicationKey(account.id, { revision: account.revision }, keyAudit());
    account = await current.accounts.update(account.id, { code_payload: "https://qr.alipay.com/unused-two",
      revision: account.revision, name: account.name, enabled: account.enabled, app_id: account.app_id,
      environment: account.environment, platform_public_key: undefined }, keyAudit());
    account = await current.accounts.update(account.id, { revision: account.revision, name: account.name,
      enabled: account.enabled, code_payload: account.code_payload, app_id: "replacement-app", environment: account.environment }, keyAudit());
    const evidence = immutableEvidence(database);
    assert.equal(evidence.collection_profiles!.length, 3);
    assert.equal(current.accounts.get(account.id).deletable, true);
    assert.equal(database.integrityCheck().ok, true);

    await current.accounts.remove(account.id, { revision: account.revision }, keyAudit());
    assert.equal(database.integrityCheck().ok, true);
    assert.deepEqual(immutableEvidence(database), evidence);
    assert.deepEqual(current.accounts.list(), []);
    assert.throws(() => current.accounts.get(account.id), error => error instanceof AlipayAccountError && error.code === "alipay_account_not_found");
    await assert.rejects(current.accounts.remove(account.id, { revision: account.revision }, keyAudit()),
      error => error instanceof AlipayAccountError && error.code === "alipay_account_not_found");
    assert.equal(database.read(db => Number(db.prepare("SELECT count(*) AS total FROM alipay_account_secrets WHERE account_id=?").get(account.id)!.total)), 0);
    assert.throws(() => database!.write(db => db.prepare("DELETE FROM collection_profiles").run()), /immutable/);
    assert.throws(() => database!.write(db => db.prepare("DELETE FROM collection_profile_provider_accounts").run()), /cannot be deleted/);

    await current.runtime.stop();
    database.close(); database = null;
    database = await AppDatabase.open(path, { masterKey: keyMaster });
    current = services(database);
    await current.runtime.start(current.settings.instanceSnapshot());
    assert.equal(database.integrityCheck().ok, true);
    assert.deepEqual(immutableEvidence(database), evidence);
    assert.deepEqual(current.accounts.list(), []);
    const replacement = await current.accounts.create({ name: "重新配置", app_id: "replacement-app" }, keyAudit());
    assert.notEqual(replacement.id, account.id);
    assert.equal(database.integrityCheck().ok, true);
  } finally {
    await current.runtime.stop(); database?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});

it("clears deleted-account secrets, retains key history and historical site assignments through backup restore", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External fetch is forbidden in account deletion tests"); });
  const directory = mkdtempSync(join(tmpdir(), "perpay-account-delete-backup-"));
  const dataDirectory = join(directory, "data"), backupDirectory = join(directory, "backups");
  mkdirSync(dataDirectory); mkdirSync(backupDirectory);
  const path = join(dataDirectory, "perpay.sqlite3");
  let database: AppDatabase | null = await AppDatabase.open(path, { masterKey: keyMaster });
  try {
    const settings = new RuntimeSettingsStore(database, keyMaster); settings.initialize();
    const store = new AlipayAccountStore(database, keyMaster);
    const accounts = new AlipayAccountService({ store, verifyProviderApplicationKey: async () => undefined });
    let account = await accounts.create({ name: "待删除账号", app_id: "removed-key-app", code_payload: "https://qr.alipay.com/removed",
      private_key: privatePem, platform_public_key: platformPem }, keyAudit());
    const sites = settings.siteStore()!;
    const configuration = { name: "历史网站", accepting_orders: false, notifications_enabled: false,
      notification_origin: null, return_origin: null, policy: sites.defaults().policy,
      collection: { mode: "FIXED" as const, accounts: [{ account_id: account.id, weight: 1 }] } };
    const site = sites.create({ operation_id: randomUUID(), configuration }, keyAudit());
    assert.equal(accounts.get(account.id).deletable, false);
    await assert.rejects(accounts.remove(account.id, { revision: account.revision }, keyAudit()),
      error => error instanceof AlipayAccountError && error.code === "alipay_account_in_use");
    sites.delete(site.clientId, site.revision, keyAudit());
    const historicalSite = database.read(db => db.prepare("SELECT * FROM sites WHERE client_id=?").get(site.clientId));

    account = await accounts.regenerateApplicationKey(account.id, { revision: account.revision, change_id: randomUUID(), base_fingerprint: account.application_key_fingerprint! }, keyAudit());
    const activatedChangeId = account.pending_application_key!.change_id;
    account = await accounts.activateApplicationKey(account.id, { revision: account.revision, change_id: activatedChangeId, platform_public_key: nextPlatformPem }, keyAudit());
    const activated = database.read(db => db.prepare("SELECT * FROM alipay_application_key_changes WHERE change_id=?").get(activatedChangeId));
    account = await accounts.regenerateApplicationKey(account.id, { revision: account.revision, change_id: randomUUID(), base_fingerprint: account.application_key_fingerprint! }, keyAudit());
    const pendingChangeId = account.pending_application_key!.change_id;
    await accounts.check(account.id);
    const revision = account.revision;
    await accounts.remove(account.id, { revision }, keyAudit());
    // A late check for the pre-deletion revision cannot restore stale status.
    store.recordCheck(account.id, revision, true, "late response", Date.now());
    assert.equal(database.integrityCheck().ok, true);
    assert.deepEqual(database.read(db => db.prepare("SELECT * FROM sites WHERE client_id=?").get(site.clientId)), historicalSite);
    assert.deepEqual(database.read(db => db.prepare("SELECT * FROM alipay_application_key_changes WHERE change_id=?").get(activatedChangeId)), activated);
    const discarded = database.read(db => db.prepare("SELECT * FROM alipay_application_key_changes WHERE change_id=?").get(pendingChangeId))!;
    assert.equal(discarded.state, "DISCARDED");
    for (const field of ["cipher_version", "nonce", "ciphertext", "authentication_tag"]) assert.equal(discarded[field], null);
    for (const table of ["alipay_account_secrets", "alipay_account_checks"]) {
      assert.equal(database.read(db => Number(db.prepare(`SELECT count(*) AS total FROM ${table} WHERE account_id=?`).get(account.id)!.total)), 0);
    }
    assert.throws(() => sites.create({ operation_id: randomUUID(), configuration }, keyAudit()),
      error => error instanceof SiteError && error.code === "site_collection_invalid");
    const { collection: _removed, ...defaultsOnly } = configuration;
    assert.throws(() => sites.create({ operation_id: randomUUID(), configuration: defaultsOnly }, keyAudit()),
      error => error instanceof SiteError && error.code === "site_collection_required");

    const backupConfig = { dataDirectory, backupDirectory, intervalMilliseconds: 86_400_000, keepCount: 7, masterKey: keyMaster };
    const backup = await createLocalBackup(backupConfig);
    database.close(); database = null;
    restoreLocalBackup(backupConfig, backup.name, backup.sha256, backup.instanceId);
    database = await AppDatabase.open(path, { masterKey: keyMaster });
    new RuntimeSettingsStore(database, keyMaster).initialize();
    const restored = new AlipayAccountStore(database, keyMaster);
    assert.deepEqual(restored.list(), []);
    restored.verifySecrets();
    assert.deepEqual(database.read(db => db.prepare("SELECT * FROM alipay_application_key_changes WHERE change_id=?").get(pendingChangeId)), discarded);
    assert.equal(database.integrityCheck().ok, true);
  } finally {
    database?.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});
