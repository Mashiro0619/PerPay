import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { StartupLeaseHeartbeat } from "../src/database/startup-lease-heartbeat.ts";

describe("database startup lease heartbeat", () => {
  it("renews from a worker while the main thread is blocked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-startup-lease-"));
    const databasePath = join(directory, "database.sqlite3");
    const connection = new DatabaseSync(databasePath, {
      readBigInts: true,
      timeout: 1_000,
    });
    const leaseToken = "startup-lease-test";
    try {
      connection.exec(`
        CREATE TABLE app_lease (
          lease_key INTEGER PRIMARY KEY,
          owner_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
      `);
      connection.prepare(
        "INSERT INTO app_lease(lease_key, owner_token, expires_at) VALUES (1, ?, ?)",
      ).run(leaseToken, Date.now() + 150);

      const heartbeat = await StartupLeaseHeartbeat.start({
        databasePath,
        leaseKey: 1,
        leaseToken,
        leaseTtlMilliseconds: 150,
        intervalMilliseconds: 25,
        sqliteTimeoutMilliseconds: 50,
      });
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        heartbeat.assertHealthy();
        const takeover = connection.prepare(
          `UPDATE app_lease
              SET owner_token = 'other'
            WHERE lease_key = 1 AND expires_at <= ?`,
        ).run(Date.now());
        assert.equal(Number(takeover.changes), 0);
      } finally {
        await heartbeat.stop(true);
      }

      const row = connection.prepare(
        "SELECT owner_token, expires_at FROM app_lease WHERE lease_key = 1",
      ).get() as { owner_token: string; expires_at: bigint | number };
      assert.equal(row.owner_token, leaseToken);
      assert.ok(Number(row.expires_at) > Date.now());
    } finally {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
