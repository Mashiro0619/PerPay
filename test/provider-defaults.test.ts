import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { RuntimeSettingsService, RuntimeSettingsStore } from "../src/settings/index.ts";
import { PROVIDER_TIMING_DEFAULTS } from "../src/shared/provider-defaults.ts";

async function withDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "perpay-provider-defaults-"));
  try {
    await run(join(directory, "perpay.sqlite3"));
  } finally {
    const target = realpathSync(directory);
    assert.equal(resolve(target), resolve(directory));
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("perpay-provider-defaults-"));
    rmSync(target, { recursive: true, force: true });
  }
}

// Apply the unchanged historical SQL, before the new first-start initializer.
// All post-apply data transforms are no-ops for this empty fixture.
function historicalDatabase(databasePath: string, version: number, started = false): void {
  const connection = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    connection.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT, applied_at TEXT NOT NULL) STRICT",
    );
    for (const migration of migrations.filter((item) => item.version <= version)) {
      connection.exec(migration.sql);
      connection.prepare(
        "INSERT INTO schema_migrations VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      ).run(migration.version, migration.name, migrationChecksum(migration));
    }
    if (started) {
      connection.exec(
        "INSERT INTO system_metadata VALUES ('last_started_version', '0.2.2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      );
    }
  } finally {
    connection.close();
  }
}

function timings(connection: DatabaseSync) {
  const row = connection.prepare(
    `SELECT revision, payment_revision, provider_scan_interval_milliseconds AS normal,
            provider_active_scan_interval_milliseconds AS active,
            provider_maximum_success_age_milliseconds AS freshness
       FROM runtime_configuration WHERE singleton_key = 1`,
  ).get() as Record<string, bigint | number>;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

const initialTimings = { revision: 0, payment_revision: 0, normal: 60_000, active: 8_000, freshness: 120_000 };

describe("provider timing defaults", () => {
  it("seeds new databases from shared defaults without configuring a provider or advancing revisions", async () => {
    assert.deepEqual(PROVIDER_TIMING_DEFAULTS, {
      scanIntervalSeconds: 60, activeScanIntervalSeconds: 8, maximumSuccessAgeSeconds: 120,
    });
    await withDatabasePath(async (databasePath) => {
      const database = await AppDatabase.open(databasePath);
      try {
        assert.deepEqual(database.read(timings), initialTimings);
        const settings = new RuntimeSettingsService({
          store: new RuntimeSettingsStore(database, Buffer.alloc(32, 0x31)),
        });
        settings.initialize();
        assert.equal(settings.view().provider, null);
        assert.equal(settings.status().complete, false);
        assert.equal(settings.status().revision, 0);
        assert.throws(() => database.write((connection) => connection.exec(
          "UPDATE runtime_configuration SET provider_active_scan_interval_milliseconds = 5000",
        )), /runtime configuration revision is invalid/);
        assert.equal(database.integrityCheck().ok, true);
      } finally {
        database.close();
      }
      const reopened = await AppDatabase.open(databasePath);
      try {
        assert.deepEqual(reopened.read(timings), initialTimings);
        assert.equal(reopened.integrityCheck().ok, true);
      } finally {
        reopened.close();
      }
    });
  });

  it("finishes first-start seeding after schema creation was interrupted before startup completed", async () => {
    await withDatabasePath(async (databasePath) => {
      historicalDatabase(databasePath, 26);
      const database = await AppDatabase.open(databasePath);
      try {
        assert.deepEqual(database.read(timings), initialTimings);
        assert.equal(database.integrityCheck().ok, true);
      } finally {
        database.close();
      }
    });
  });

  it("preserves a previously started installation's old defaults and migration checksums", async () => {
    await withDatabasePath(async (databasePath) => {
      historicalDatabase(databasePath, 26, true);
      const database = await AppDatabase.open(databasePath);
      try {
        assert.deepEqual(database.read(timings), {
          revision: 0, payment_revision: 0, normal: 10_000, active: 10_000, freshness: 60_000,
        });
        const applied = database.read((connection) => connection.prepare(
          "SELECT version, checksum FROM schema_migrations ORDER BY version",
        ).all());
        assert.deepEqual(applied.map((row) => ({ version: Number(row.version), checksum: row.checksum })),
          migrations.map((migration) => ({ version: migration.version, checksum: migrationChecksum(migration) })));
        assert.equal(database.integrityCheck().ok, true);
      } finally {
        database.close();
      }
    });
  });

  for (const started of [false, true]) {
    it("preserves saved timings and revisions (startup marker present: " + started + ")", async () => {
      await withDatabasePath(async (databasePath) => {
        historicalDatabase(databasePath, 26, started);
        const raw = new DatabaseSync(databasePath);
        try {
          raw.exec(`UPDATE runtime_configuration
            SET revision = 1, payment_revision = 1,
                provider_scan_interval_milliseconds = 30000,
                provider_active_scan_interval_milliseconds = 12000,
                provider_maximum_success_age_milliseconds = 180000`);
        } finally {
          raw.close();
        }
        const database = await AppDatabase.open(databasePath);
        try {
          assert.deepEqual(database.read(timings), {
            revision: 1, payment_revision: 1, normal: 30_000, active: 12_000, freshness: 180_000,
          });
          assert.equal(database.integrityCheck().ok, true);
        } finally {
          database.close();
        }
      });
    });
  }
});
