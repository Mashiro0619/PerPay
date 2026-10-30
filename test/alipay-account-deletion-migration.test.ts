import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { migrateAlipayAccounts } from "../src/alipay-accounts/migration.ts";
import { AlipayAccountStore } from "../src/alipay-accounts/store.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { createLegacySettingsDatabase } from "./legacy-settings-fixture.ts";
import { keyAudit, keyMaster, providerInput } from "./application-key-fixture.ts";

it("upgrades an actual schema 37 database without changing active or pending account keys and ownership evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-account-deletion-migration-"));
  const path = join(directory, "state.sqlite3");
  const legacy = createLegacySettingsDatabase(path);
  let upgraded: AppDatabase | null = null;
  try {
    const settings = new RuntimeSettingsService({ store: new RuntimeSettingsStore(legacy.owner, keyMaster) });
    settings.initialize();
    await settings.saveProvider(providerInput(0), keyAudit());
    await settings.saveCollection({ revision: settings.view().revision, code_payload: "https://qr.alipay.com/upgrade-delete",
      order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600 }, keyAudit());
    await settings.regenerateProviderApplicationKey({ revision: settings.view().revision, change_id: randomUUID(),
      base_fingerprint: settings.view().application_key_fingerprint! }, keyAudit());
    legacy.owner.write(db => {
      for (const migration of migrations.filter(item => item.version >= 34 && item.version <= 37)) {
        db.exec(migration.sql);
        if (migration.postApply === "migrate_websites_v1") migrateSiteData(db, keyMaster);
        if (migration.postApply === "migrate_alipay_accounts_v1") migrateAlipayAccounts(db, keyMaster);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
      }
    });
    assert.equal(Number(legacy.connection.prepare("SELECT max(version) AS version FROM schema_migrations").get()!.version), 37);
    assert.equal(legacy.owner.integrityCheck().ok, true);
    const beforeAccounts = legacy.connection.prepare("SELECT * FROM alipay_accounts ORDER BY account_id").all();
    const preservedTables = ["alipay_account_generations", "alipay_account_secrets", "alipay_application_key_changes",
      "provider_account_bindings", "collection_profiles", "collection_profile_provider_accounts", "sites"];
    const before = new Map(preservedTables.map(table => [table, legacy.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const previousMigrations = legacy.connection.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    legacy.owner.close();

    upgraded = await AppDatabase.open(path, { masterKey: keyMaster });
    assert.equal(Number(upgraded.read(db => db.prepare("SELECT max(version) AS version FROM schema_migrations").get()!.version)), 38);
    assert.deepEqual(upgraded.read(db => db.prepare("SELECT * FROM alipay_accounts ORDER BY account_id").all().map(account => ({ ...account }))),
      beforeAccounts.map(account => ({ ...account, deleted_at: null })));
    for (const table of preservedTables) assert.deepEqual(upgraded.read(db => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before.get(table), table);
    assert.deepEqual(upgraded.read(db => db.prepare("SELECT * FROM schema_migrations WHERE version <= 37 ORDER BY version").all()), previousMigrations);
    const accounts = new AlipayAccountStore(upgraded, keyMaster);
    accounts.verifySecrets();
    const account = accounts.view("default");
    assert.equal(account.configured, true);
    assert.ok(account.pending_application_key);
    assert.equal(upgraded.integrityCheck().ok, true);
  } finally {
    upgraded?.close(); legacy.owner.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    rmSync(directory, { recursive: true, force: true });
  }
});
