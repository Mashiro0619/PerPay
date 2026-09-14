import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../src/database/database.ts";
import { adminWorkItemPage, ignoreAllAdminWorkItems } from "../src/http/admin-work-items.ts";
import { financialExceptionDetailsFingerprint, financialExceptionFingerprint } from "../src/reconciliation/model.ts";
import { withHttpFixture } from "./reconciliation-http-fixture.ts";

it("takes ignore-all membership inside the SQLite write transaction and leaves a concurrent post-transaction insertion active", async () => {
  await withHttpFixture(async (fixture) => {
    const entry = fixture.recordCredit("transaction-cutoff", 100, 1);
    const original = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId); assert.equal(original.kind, "unmatched");
    const newId = randomUUID();
    const provider = fixture.services.settings.snapshot().activeProviderAccountKey!;
    const details = JSON.stringify({ reason: "isolated concurrent insertion" });
    const shared = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(`
      const { workerData, parentPort } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const flags = new Int32Array(workerData.shared);
      const database = new DatabaseSync(workerData.path, { enableForeignKeyConstraints: true });
      try {
        database.exec("PRAGMA busy_timeout = 15000");
        parentPort.postMessage("ready");
        Atomics.wait(flags, 0, 0);
        Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
        database.exec("BEGIN IMMEDIATE");
        database.prepare(workerData.sql).run(...workerData.parameters);
        database.exec("COMMIT");
        Atomics.store(flags, 2, 1); parentPort.postMessage("committed");
      } finally { database.close(); }
    `, { eval: true, execArgv: [], workerData: {
      path: fixture.services.config.databasePath, shared: shared.buffer,
      sql: "INSERT INTO financial_exceptions(exception_id, provider_account_key, exception_type, ledger_entry_id, order_id, candidate_id, context_key, details_json, exception_fingerprint, status, created_at, details_fingerprint) VALUES (?, ?, 'UNMATCHED_CREDIT', ?, NULL, NULL, 'concurrent-cutoff', ?, ?, 'OPEN', ?, ?)",
      parameters: [newId, provider, entry.ledgerEntryId, details, financialExceptionFingerprint({ providerAccountKey: provider, exceptionType: "UNMATCHED_CREDIT", ledgerEntryId: entry.ledgerEntryId, orderId: null, candidateId: null, contextKey: "concurrent-cutoff" }), Date.now(), financialExceptionDetailsFingerprint(details)],
    } });
    const exit = once(worker, "exit");
    try {
      assert.deepEqual(await once(worker, "message", { signal: AbortSignal.timeout(15000) }), ["ready"]);
      const committed = once(worker, "message", { signal: AbortSignal.timeout(15000) });
      const intercepted = {
        read: fixture.database.read.bind(fixture.database),
        write<T>(operation: (connection: DatabaseSync) => T): T {
          return fixture.database.write((connection) => {
            // The other writer is released only after BEGIN IMMEDIATE holds the database lock.
            Atomics.store(shared, 0, 1); Atomics.notify(shared, 0);
            if (Atomics.load(shared, 1) === 0) Atomics.wait(shared, 1, 0, 15000);
            assert.equal(Atomics.load(shared, 1), 1);
            const result = operation(connection);
            assert.equal(Atomics.load(shared, 2), 0, "the competing writer cannot commit during this transaction");
            return result;
          });
        },
      } as unknown as AppDatabase;
      const input = { operation_id: randomUUID(), type: "ALL" as const };
      const context = { actorId: "admin" };
      const ignored = ignoreAllAdminWorkItems(intercepted, input, context);
      assert.equal(ignored.ignored_count, 1);
      assert.deepEqual(await committed, ["committed"]);
      assert.deepEqual(await exit, [0]);
      assert.deepEqual(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.map((item) => item.itemId), [newId]);
      assert.deepEqual(ignoreAllAdminWorkItems(fixture.database, input, context), ignored);
      assert.deepEqual(adminWorkItemPage(fixture.database, { type: "ALL", cursor: null, limit: 20 }).items.map((item) => item.itemId), [newId]);
      assert.equal(fixture.database.integrityCheck().ok, true);
    } finally { await worker.terminate(); }
  });
});
