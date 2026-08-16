import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

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
      const insufficient = inspectStorageHeadroom(
        directory,
        headroom.availableBytes + 1n,
      );
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
});
