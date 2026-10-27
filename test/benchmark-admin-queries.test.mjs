import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of [[], ["work-items"]]) {
  it(`runs the disposable admin query benchmark in ${mode[0] ?? "default"} mode`, { timeout: 30_000 }, () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/benchmark-admin-queries.ts", "100", ...mode], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 25_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.count, 100);
    assert.ok(report.rows.some(row => row.resource === "orders" && row.returned === 20));
    assert.ok(report.rows.some(row => row.resource === "webhooks/deliveries" && row.returned === 20));
    assert.ok(report.rows.some(row => row.resource === "orders/export" && row.returned === 100));
    if (mode.length) assert.ok(report.rows.some(row => row.resource === "work-items" && row.returned === 20));
  });
}
