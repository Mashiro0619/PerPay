// SPDX-License-Identifier: MIT
// Keep the real image database connection alive while its read-only backup runs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { assertIsolation, loadImageModules } from "./upgrade-fixture.mjs";

assertIsolation();
const modules = await loadImageModules();
const config = modules.loadConfig(process.env);
const database = await modules.AppDatabase.open(config.databasePath, { masterKey: config.masterKey });
assert.ok(existsSync(config.databasePath + "-wal"), "Online backup requires the writer WAL");
assert.ok(existsSync(config.databasePath + "-shm"), "Online backup requires the writer shared-memory file");
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  clearInterval(timer);
  database.close();
  process.exit(0);
});
console.log(JSON.stringify({ event: "validation_writer_ready", version: modules.APP_VERSION }));
