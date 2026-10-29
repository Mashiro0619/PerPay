import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createVerifiedDatabaseBackup, inspectDatabaseIntegrity, type AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";

/** Build an actual pre-1.0 database for upgrade tests, not an alternate production startup path. */
export function createLegacySettingsDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const connection = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  connection.exec(`CREATE TABLE app_lease (
      lease_key INTEGER PRIMARY KEY CHECK (lease_key = 1),
      owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_host TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;`);
  connection.exec("PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT, applied_at TEXT NOT NULL) STRICT;");
  for (const migration of migrations.filter(item => item.version <= 33)) {
    connection.exec(migration.sql);
    connection.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
  }
  connection.prepare("INSERT INTO system_metadata(key, value, updated_at) VALUES ('last_started_version', '0.3.2', ?)").run(new Date().toISOString());
  // A real 0.3.2 startup creates its checkout signing key before serving requests.
  connection.prepare("INSERT INTO checkout_token_keys(key_version, key_material, activated_at, retired_at) VALUES (1, ?, ?, NULL)").run(randomBytes(32), Date.now());
  return legacyOwner(path, connection);
}

/** Reopens the historical schema for legacy service tests without applying an upgrade. */
export function openLegacySettingsDatabase(path: string) {
  const connection = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  const version = Number(connection.prepare("SELECT max(version) AS version FROM schema_migrations").get()!.version);
  if (version > 33) { connection.close(); throw new Error("legacy settings fixture expects a pre-website schema"); }
  return legacyOwner(path, connection);
}

/** Actual schema 36, for tests of upgrades which predate multiple accounts. */
export function createPreAccountDatabase(path: string) {
  const fixture = createLegacySettingsDatabase(path);
  const connection = fixture.connection;
  connection.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of migrations.filter(item => item.version >= 34 && item.version <= 36)) {
      connection.exec(migration.sql);
      if (migration.postApply === "migrate_websites_v1") migrateSiteData(connection);
      connection.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
    }
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); connection.close(); throw error; }
  return fixture;
}

function legacyOwner(path: string, connection: DatabaseSync) {
  const owner = {
    close() { if (connection.isOpen) connection.close(); },
    integrityCheck() { return inspectDatabaseIntegrity(connection); },
    backupDetailed(targetPath: string) { return createVerifiedDatabaseBackup(connection, path, targetPath); },
    read<T>(operation: (connection: DatabaseSync) => T): T { return operation(connection); },
    write<T>(operation: (connection: DatabaseSync) => T): T {
      connection.exec("BEGIN IMMEDIATE");
      try { const result = operation(connection); connection.exec("COMMIT"); return result; }
      catch (error) { if (connection.isTransaction) connection.exec("ROLLBACK"); throw error; }
    },
    instanceId: () => String(connection.prepare("SELECT value FROM system_metadata WHERE key = 'instance_id'").get()!.value),
  } as AppDatabase;
  return { connection, owner };
}
