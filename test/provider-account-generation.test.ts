import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { normalizeProviderIdentity } from "../src/ledger/model.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { fingerprintCollectionCodeProfile } from "../src/orders/collection-profile.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { SettingsError } from "../src/settings/store.ts";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";

const LEGACY_BOUND_AT = 1_800_000_000_000;
const LEGACY_IDENTITY = {
  providerAccountKey: "primary",
  providerKind: "alipay",
  endpoint: "https://openapi.alipay.com",
  externalAccountId: "2026000000000000",
} as const;
const applicationKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const applicationPrivateKey = applicationKeys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const platformPublicKey = platformKeys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

describe("provider account generation migration", () => {
  it("upgrades the existing primary binding into the first active generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-provider-generation-"));
    const databasePath = join(directory, "database.sqlite3");
    createSchemaThirteenDatabase(databasePath);

    const database = await AppDatabase.open(databasePath);
    try {
      const ledger = new LedgerStore(database);
      const active = ledger.activeProviderIdentity();
      assert.deepEqual(active, {
        ...normalizeProviderIdentity(LEGACY_IDENTITY),
        boundAt: LEGACY_BOUND_AT,
        activationId: "00000000-0000-4000-8000-000000000014",
        sequence: 1,
        previousProviderAccountKey: null,
        activatedAt: LEGACY_BOUND_AT,
        reason: "MIGRATION",
      });
      assert.equal(
        database.read((connection) => Number((connection.prepare(
          "SELECT MAX(version) AS version FROM schema_migrations",
        ).get() as { version: bigint }).version)),
        DATABASE_COMPATIBILITY.maximum,
      );
      assert.deepEqual(
        database.read((connection) => ({ ...(connection.prepare(
          `SELECT profile_id, provider_account_key
             FROM collection_profile_provider_accounts`,
        ).get() as Record<string, string>) })),
        {
          profile_id: "11111111-1111-4111-8111-111111111114",
          provider_account_key: "primary",
        },
      );
      assert.equal(database.integrityCheck().ok, true);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses the migrated generation when the administrator enters the same application", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-provider-generation-settings-"));
    const databasePath = join(directory, "database.sqlite3");
    createSchemaThirteenDatabase(databasePath);

    const database = await AppDatabase.open(databasePath);
    try {
      const ledger = new LedgerStore(database);
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, Buffer.alloc(32, 0x41)),
        providerHistory: () => ledger.providerIdentityHistory(),
      });
      settings.initialize();
      await settings.saveProvider({
        revision: 0,
        environment: "PRODUCTION",
        app_id: LEGACY_IDENTITY.externalAccountId,
        private_key: applicationPrivateKey,
        platform_public_key: platformPublicKey,
        timeout_milliseconds: 8_000,
        scan_interval_seconds: 10,
        maximum_success_age_seconds: 60,
      }, {
        actorId: "admin",
        requestId: "migrated-provider-settings",
        remoteAddressHash: "a".repeat(64),
      });

      assert.equal(settings.snapshot().activeProviderAccountKey, "primary");
      assert.deepEqual(database.read((connection) => ({
        bindings: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_bindings",
        ).get() as { count: bigint }).count),
        activations: Number((connection.prepare(
          "SELECT COUNT(*) AS count FROM provider_account_activations",
        ).get() as { count: bigint }).count),
      })), { bindings: 1, activations: 1 });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("guards a different application against the migrated active generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-provider-generation-guard-"));
    const databasePath = join(directory, "database.sqlite3");
    createSchemaThirteenDatabase(databasePath);

    const database = await AppDatabase.open(databasePath);
    try {
      const ledger = new LedgerStore(database);
      let guardedAccountKey: string | null = null;
      const settings = new RuntimeSettingsService({
        store: new RuntimeSettingsStore(database, Buffer.alloc(32, 0x42)),
        providerHistory: () => ledger.providerIdentityHistory(),
        guardProviderSwitch: ({ currentProviderAccountKey }) => {
          guardedAccountKey = currentProviderAccountKey;
          throw new SettingsError("provider_switch_blocked", "injected migration switch guard");
        },
      });
      settings.initialize();

      await assert.rejects(
        settings.saveProvider({
          revision: 0,
          environment: "PRODUCTION",
          app_id: "2026000000000099",
          private_key: applicationPrivateKey,
          platform_public_key: platformPublicKey,
          timeout_milliseconds: 8_000,
          scan_interval_seconds: 10,
          maximum_success_age_seconds: 60,
        }, {
          actorId: "admin",
          requestId: "migrated-provider-switch",
          remoteAddressHash: "b".repeat(64),
        }),
        (error: unknown) =>
          error instanceof SettingsError && error.code === "provider_switch_blocked",
      );
      assert.equal(guardedAccountKey, "primary");
      assert.equal(settings.snapshot().revision, 0);
      assert.equal(ledger.activeProviderIdentity()?.providerAccountKey, "primary");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createSchemaThirteenDatabase(databasePath: string): void {
  const connection = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    readBigInts: true,
  });
  try {
    connection.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const record = connection.prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at)
       VALUES (?, ?, ?, '2026-08-14T00:00:00.000Z')`,
    );
    for (const migration of migrations.slice(0, 13)) {
      connection.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration));
    }
    connection.prepare(
      `INSERT INTO checkout_token_keys(
         key_version, key_material, activated_at, retired_at
       ) VALUES (1, randomblob(32), ?, NULL)`,
    ).run(LEGACY_BOUND_AT);

    const identity = normalizeProviderIdentity(LEGACY_IDENTITY);
    connection.prepare(
      `INSERT INTO provider_account_bindings(
         provider_account_key, provider_kind, provider_endpoint,
         external_account_id, identity_fingerprint_version,
         identity_fingerprint, bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity.providerAccountKey,
      identity.providerKind,
      identity.endpoint,
      identity.externalAccountId,
      identity.identityFingerprintVersion,
      identity.identityFingerprint,
      LEGACY_BOUND_AT,
    );
    const codePayload = "https://qr.example.test/legacy-primary";
    const profile = fingerprintCollectionCodeProfile(codePayload);
    connection.prepare(
      `INSERT INTO collection_profiles(
         profile_id, version, provider_account_key, code_payload,
         payload_fingerprint, profile_fingerprint, evidence_policy, created_at
       ) VALUES (?, 1, 'primary', ?, ?, ?, 'UNIQUE_AMOUNT_AUTO', ?)`,
    ).run(
      "11111111-1111-4111-8111-111111111114",
      codePayload,
      profile.payloadFingerprint,
      profile.profileFingerprint,
      LEGACY_BOUND_AT,
    );
    connection.prepare(
      `INSERT INTO active_collection_profile(singleton_key, profile_id, activated_at)
       VALUES (1, ?, ?)`,
    ).run("11111111-1111-4111-8111-111111111114", LEGACY_BOUND_AT);
    connection.prepare(
      `INSERT INTO collection_profile_activations(
         activation_id, sequence, profile_id, previous_profile_id,
         activated_at, reason
       ) VALUES (?, 1, ?, NULL, ?, 'CONFIG_SYNC')`,
    ).run(
      "22222222-2222-4222-8222-222222222214",
      "11111111-1111-4111-8111-111111111114",
      LEGACY_BOUND_AT,
    );
  } finally {
    connection.close();
  }
}
