import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { systemAnalytics } from "../src/http/system-analytics.ts";

describe("system analytics", () => {
  it("returns a complete zero-filled daily series for an empty database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-analytics-"));
    const databasePath = join(directory, "database.sqlite3");
    try {
      const database = await AppDatabase.open(databasePath);
      const result = systemAnalytics(database, 7, Date.UTC(2026, 0, 15, 12));
      assert.equal(result.range_days, 7);
      assert.equal(result.daily.length, 7);
      assert.equal(result.orders.created, 0);
      assert.equal(result.confirmations.amount_cents, 0);
      assert.deepEqual(result.daily[0], {
        date: "2026-01-09",
        orders_created: 0,
        confirmations: 0,
        confirmed_amount_cents: 0,
        notifications_acknowledged: 0,
        notifications_failed: 0,
      });
      assert.deepEqual(result.daily[6], {
        date: "2026-01-15",
        orders_created: 0,
        confirmations: 0,
        confirmed_amount_cents: 0,
        notifications_acknowledged: 0,
        notifications_failed: 0,
      });
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
