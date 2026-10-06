import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { inspectDatabaseIntegrity, type AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";

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
  const owner = {
    close() { if (connection.isOpen) connection.close(); },
    integrityCheck() { return inspectDatabaseIntegrity(connection); },
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
