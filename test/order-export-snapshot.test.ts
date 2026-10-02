import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { it } from "node:test";
import { exportOrders } from "../src/http/order-export.ts";
import type { AppDatabase } from "../src/database/database.ts";

it("exports one snapshot while another connection commits state changes", async () => {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, "perpay-export-snapshot-"));
  const path = join(directory, "synthetic.sqlite");
  const db = new DatabaseSync(path);
  let worker: Worker | undefined;
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE payment_orders(order_id TEXT PRIMARY KEY, merchant_order_no TEXT, product_name TEXT, requested_amount_cents INTEGER, payable_amount_cents INTEGER, received_amount_cents INTEGER, currency TEXT, payment_status TEXT, checkout_status TEXT, created_at INTEGER, expires_at INTEGER); CREATE TABLE order_events(order_id TEXT,event_type TEXT,occurred_at INTEGER);",
    );
    const now = Date.parse("2026-10-01T00:00:00Z");
    const insert = db.prepare(
      "INSERT INTO payment_orders VALUES(?,?,?,100,100,100,'CNY','CONFIRMED','OPEN',?,?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 1000; i++)
      insert.run(String(i), String(i), "snapshot", now, now + 300000);
    db.exec("COMMIT");
    worker = new Worker(
      `
      const {workerData,parentPort}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData);db.exec('PRAGMA busy_timeout=5000');
      parentPort.postMessage('ready');
      parentPort.once('message',()=>{
        for(let i=0;i<80;i++) {db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE payment_orders SET payment_status=?').run(i%2?'CONFIRMED':'DISPUTED');db.exec('COMMIT');}
        db.close();
      });
    `,
      { eval: true, workerData: path },
    );
    await once(worker, "message");
    const exited = once(worker, "exit");
    worker.postMessage("start");
    const owner = {
      read: <T>(operation: (connection: DatabaseSync) => T) => operation(db),
    } as AppDatabase;
    for (let i = 0; i < 20; i++) {
      const csv = exportOrders(
        owner,
        { created_from: "2026-10-01", created_to: "2026-10-01" },
        now,
      );
      const confirmed = (csv.match(/收款已确认/g) ?? []).length;
      const disputed = (csv.match(/需核对/g) ?? []).length;
      assert.equal(confirmed + disputed, 1000);
      assert.ok(
        confirmed === 1000 || disputed === 1000,
        "mixed commits must never appear in one export",
      );
    }
    assert.equal((await exited)[0], 0);
  } finally {
    await worker?.terminate();
    db.close();
    const target = realpathSync(directory);
    assert.equal(dirname(target), base);
    assert.ok(basename(target).startsWith("perpay-export-snapshot-"));
    rmSync(target, { recursive: true, force: true });
  }
});
