import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { createApp } from "../src/http/app.ts";

describe("health endpoints", () => {
  it("reports process liveness and database readiness", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-http-"));
    const config = loadConfig({
      PERPAY_ADMIN_PASSWORD: "a-secure-local-password",
      PERPAY_DATA_DIR: directory,
    });
    const database = await AppDatabase.open(config.databasePath);
    const app = createApp({ config, database, startedAt: new Date(0) });
    try {
      const live = await app.request("/livez");
      assert.equal(live.status, 200);
      const liveBody = (await live.json()) as { status: string };
      assert.equal(liveBody.status, "alive");

      const ready = await app.request("/readyz");
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), {
        status: "ready",
        checks: { database: { ok: true, result: "ok" } },
      });

      const missing = await app.request("/missing");
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), "no-store");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
