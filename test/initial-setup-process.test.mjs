import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { listAdminAssets, runAdminSmoke } from "../scripts/admin-smoke.mjs";

it("delivers a startup-only setup token through the real process and closes setup across restarts", { timeout: 90_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-setup-process-"));
  const masterKey = randomBytes(32).toString("hex");
  const password = randomBytes(32).toString("hex");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PERPAY_")));
  const harness = join(directory, "start.mjs");
  // IPC invokes the application's real graceful shutdown handler on Windows too.
  writeFileSync(harness, `process.on("message", value => {
    if (value === "stop") { process.emit("SIGTERM"); process.disconnect(); }
  });
  await import(${JSON.stringify(new URL("../src/main.ts", import.meta.url).href)});
  `);
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, "exit");
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      if (child.connected) child.send("stop");
      else child.kill();
      const [code] = await exit;
      assert.equal(code, 0, "application must release its database lease on shutdown");
    } finally { clearTimeout(deadline); }
  }
  async function start() {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((done, reject) => reservation.close(error => error ? reject(error) : done()));
    const baseUrl = `http://127.0.0.1:${port}`;
    const tokens = [];
    child = fork(harness, [], {
      cwd: resolve(import.meta.dirname, ".."),
      execArgv: ["--experimental-strip-types"],
      env: { ...environment, PERPAY_HOST: "127.0.0.1", PERPAY_PORT: String(port), PERPAY_PUBLIC_URL: baseUrl,
        PERPAY_DATA_DIR: join(directory, "data"), PERPAY_BACKUP_DIR: join(directory, "backups"), PERPAY_MASTER_KEY: masterKey },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // Keep startup secrets in this test's memory, never in test diagnostics.
    child.stderr.on("data", () => {});
    await new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("application startup timed out")), 30_000);
      const failed = code => { clearTimeout(deadline); reject(new Error(`application exited during startup (${code})`)); };
      child.once("exit", failed);
      let pending = "";
      child.stdout.on("data", chunk => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.event === "administrator_setup_required") tokens.push(entry.setup_token);
          if (entry.event === "server_started") { clearTimeout(deadline); child.off("exit", failed); done(); }
        }
      });
    });
    return { baseUrl, tokens };
  }
  try {
    const first = await start();
    assert.equal(first.tokens.length, 1);
    assert.equal(/^[0-9a-f]{64}$/.test(first.tokens[0]), true, "startup token must carry 32 random bytes");
    await stop();
    const next = await start();
    assert.equal(next.tokens.length, 1);
    assert.equal(first.tokens[0] === next.tokens[0], false, "uninitialized restart must rotate the token");
    const stale = await fetch(next.baseUrl + "/api/admin/v1/setup", { method: "POST",
      headers: { origin: next.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ password, setup_token: first.tokens[0] }),
    });
    assert.equal(stale.status, 403);
    const firstSmoke = await runAdminSmoke({ baseUrl: next.baseUrl, password, setupToken: next.tokens[0], initialize: true, isolated: true, assets: listAdminAssets() });
    await stop();
    const initialized = await start();
    assert.equal(initialized.tokens.length, 0, "initialized restart must not print a setup token");
    const secondSmoke = await runAdminSmoke({ baseUrl: initialized.baseUrl, password, isolated: true, assets: listAdminAssets() });
    assert.equal(secondSmoke.instanceId, firstSmoke.instanceId);
  } finally {
    await stop();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-setup-process-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
