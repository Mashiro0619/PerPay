import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";

const priorSchemaVersion = 19;

describe("adaptive ledger interval migration", () => {
  for (const interval of [5_000, 10_000, 30_000, 3_600_000]) {
    it("preserves an existing " + interval + "ms cadence and configuration revisions", async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-cadence-migration-"));
      const databasePath = join(directory, "database.sqlite3");
      try {
        // Start with a domain-valid initialized database, then restore its v19 structure.
        const initialized = await AppDatabase.open(databasePath);
        initialized.close();
        const legacy = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true, readBigInts: true });
        try {
          legacy.prepare(`UPDATE runtime_configuration
            SET revision = revision + 1, payment_revision = payment_revision + 1,
                provider_scan_interval_milliseconds = ?, provider_active_scan_interval_milliseconds = ?,
                provider_maximum_success_age_milliseconds = ?`)
            .run(interval, interval, interval * 2);
          legacy.exec(`
            DROP INDEX collection_profile_provider_accounts_account_idx;
            DROP INDEX payment_orders_active_scan_idx;
            DROP INDEX payment_orders_scan_tail_idx;
            ALTER TABLE runtime_configuration DROP COLUMN provider_active_scan_interval_milliseconds;
          `);
          legacy.prepare("DELETE FROM schema_migrations WHERE version > ?").run(priorSchemaVersion);
        } finally {
          legacy.close();
        }
        const database = await AppDatabase.open(databasePath);
        try {
          const values = database.read((connection) => connection.prepare(`SELECT revision, payment_revision,
            provider_scan_interval_milliseconds AS normal, provider_active_scan_interval_milliseconds AS active
            FROM runtime_configuration`).get()) as Record<string, bigint>;
          assert.deepEqual({ ...values }, { revision: 1n, payment_revision: 1n, normal: BigInt(interval), active: BigInt(interval) });
          assert.equal(database.integrityCheck().ok, true);
          assert.throws(() => database.write((connection) => connection.exec(
            "UPDATE runtime_configuration SET provider_active_scan_interval_milliseconds = 5000",
          )), /runtime configuration revision is invalid/);
        } finally {
          database.close();
        }
        const reopened = await AppDatabase.open(databasePath);
        reopened.close();
      } finally {
        assert.ok(directory.startsWith(join(tmpdir(), "perpay-cadence-migration-")));
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  it("enforces the active range and normal/active relationship at the database boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-cadence-constraints-"));
    const database = await AppDatabase.open(join(directory, "database.sqlite3"));
    try {
      for (const active of [4_999, 10_001, 3_600_001]) {
        assert.throws(() => database.write((connection) => connection.prepare(`UPDATE runtime_configuration
          SET revision = revision + 1, provider_active_scan_interval_milliseconds = ?`).run(active)), /constraint/i);
      }
      assert.throws(() => database.write((connection) => connection.exec(`UPDATE runtime_configuration
        SET revision = revision + 1, provider_scan_interval_milliseconds = 5000`)), /constraint/i);
      database.write((connection) => connection.exec(`UPDATE runtime_configuration
        SET revision = revision + 1, provider_scan_interval_milliseconds = 5000,
            provider_active_scan_interval_milliseconds = 5000`));
      assert.equal(database.integrityCheck().ok, true);
    } finally {
      database.close();
      assert.ok(directory.startsWith(join(tmpdir(), "perpay-cadence-constraints-")));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
