import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { AppDatabase } from "../src/database/database.ts";
import { createOperationalBackup } from "../src/database/maintenance.ts";
import {
  BACKUP_WRITE_RESERVE_BYTES,
  databaseStorageFootprintBytes,
  inspectStorageHeadroom,
  MINIMUM_RUNTIME_FREE_BYTES,
  requiredRuntimeFreeBytes,
} from "../src/infrastructure/storage/capacity.ts";

describe("storage capacity policy", () => {
  it("reserves enough space for one database-sized backup and runtime writes", () => {
    assert.equal(requiredRuntimeFreeBytes(0n), MINIMUM_RUNTIME_FREE_BYTES);
    assert.equal(
      requiredRuntimeFreeBytes(MINIMUM_RUNTIME_FREE_BYTES),
      MINIMUM_RUNTIME_FREE_BYTES + BACKUP_WRITE_RESERVE_BYTES,
    );
    assert.throws(() => requiredRuntimeFreeBytes(-1n), /must not be negative/);
  });

  it("reports real filesystem capacity with exact bigint arithmetic", () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-capacity-"));
    try {
      const headroom = inspectStorageHeadroom(directory, 1n);
      assert.ok(headroom.availableBytes > 0n);
      assert.equal(headroom.requiredBytes, 1n);
      assert.equal(headroom.sufficient, true);
      assert.equal(Object.isFrozen(headroom), true);
      const impossibleRequirement = headroom.availableBytes + (1n << 64n);
      const insufficient = inspectStorageHeadroom(
        directory,
        impossibleRequirement,
      );
      assert.equal(insufficient.requiredBytes, impossibleRequirement);
      assert.equal(insufficient.sufficient, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("includes uncheckpointed SQLite files in the required backup footprint", () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-capacity-footprint-"));
    const databasePath = join(directory, "perpay.sqlite3");
    try {
      writeFileSync(databasePath, Buffer.alloc(11));
      writeFileSync(`${databasePath}-wal`, Buffer.alloc(13));
      writeFileSync(`${databasePath}-journal`, Buffer.alloc(17));
      assert.equal(databaseStorageFootprintBytes(databasePath), 41n);
      rmSync(`${databasePath}-wal`);
      rmSync(`${databasePath}-journal`);
      assert.equal(databaseStorageFootprintBytes(databasePath), 11n);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails database health and backup creation closed when no headroom remains", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-capacity-gate-"));
    const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
    const originalStatfsSync = fs.statfsSync;
    const noHeadroomStatfsSync = ((...arguments_: unknown[]) => {
      const result = Reflect.apply(originalStatfsSync, fs, arguments_) as {
        bavail: bigint | number;
        [key: string]: unknown;
      };
      return { ...result, bavail: typeof result.bavail === "bigint" ? 0n : 0 };
    }) as typeof fs.statfsSync;
    assert.equal(Reflect.set(fs, "statfsSync", noHeadroomStatfsSync), true);
    syncBuiltinESMExports();
    try {
      assert.deepEqual(database.health(), {
        ok: false,
        result: "database_storage_low",
      });
      await assert.rejects(
        () => createOperationalBackup({ dataDirectory: directory }),
        /insufficient storage headroom/,
      );
      assert.deepEqual(
        readdirSync(directory).filter((name) =>
          name.includes(".backup-") || name.includes(".creating-")
        ),
        [],
      );
    } finally {
      assert.equal(Reflect.set(fs, "statfsSync", originalStatfsSync), true);
      syncBuiltinESMExports();
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  for (const shortage of ["headroom", "sqlite-full"] as const) {
    it(`publishes the existing valid snapshot when compaction lacks space (${shortage})`, async context => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-backup-space-"));
      const backupDirectory = join(directory, "backups");
      const database = await AppDatabase.open(join(directory, "perpay.sqlite3"));
      database.write(connection => connection.exec("CREATE TABLE padding(value BLOB); INSERT INTO padding VALUES (zeroblob(4194304)); DROP TABLE padding"));
      const instanceId = database.instanceId();
      const originalStatfs = fs.statfsSync;
      let capacityReads = 0;
      if (shortage === "headroom") {
        context.mock.method(fs, "statfsSync", (...args: Parameters<typeof fs.statfsSync>) => {
          const stats = Reflect.apply(originalStatfs, fs, args);
          return ++capacityReads === 1 ? stats : { ...stats, bavail: typeof stats.bavail === "bigint" ? 0n : 0 };
        });
        syncBuiltinESMExports();
      } else {
        const originalPrepare = DatabaseSync.prototype.prepare;
        context.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
          if (sql === "VACUUM INTO ?") return { run: (path: string) => {
            writeFileSync(path, "partial compaction");
            throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
          } } as unknown as ReturnType<typeof originalPrepare>;
          return originalPrepare.call(this, sql);
        });
      }
      try {
        const backup = await database.backupDetailed(join(backupDirectory, "snapshot.sqlite3"));
        context.mock.restoreAll();
        syncBuiltinESMExports();
        assert.deepEqual(readdirSync(backupDirectory), ["snapshot.sqlite3"]);
        const restored = await AppDatabase.open(backup.targetPath);
        try {
          assert.equal(restored.instanceId(), instanceId);
          assert.equal(restored.integrityCheck().ok, true);
        } finally { restored.close(); }
      } finally {
        context.mock.restoreAll();
        syncBuiltinESMExports();
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
