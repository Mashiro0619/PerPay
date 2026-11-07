import assert from "node:assert/strict";
import { it } from "node:test";
import { LedgerRetentionScheduler } from "../src/ledger/retention-scheduler.ts";
import { INGEST_RETENTION_INTERVAL_MILLISECONDS } from "../src/ledger/retention.ts";

it("yields between cleanup batches, waits between sweeps and cancels pending work on shutdown", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const deleted: number[] = [];
  const scheduler = new LedgerRetentionScheduler({
    prune: () => ({ scannedRuns: 1, deletedRuns: ++calls === 1 ? 1 : 0, deletedPages: 1, deletedEvents: 0, deletedObservations: 1, hasMore: calls === 1 }),
    onPruned: result => deleted.push(result.deletedRuns),
    onError: error => { throw error; },
  });
  scheduler.start();
  scheduler.start();
  assert.equal(calls, 0);
  context.mock.timers.tick(5_000);
  assert.equal(calls, 1);
  assert.deepEqual(deleted, [1]);
  context.mock.timers.tick(249);
  assert.equal(calls, 1);
  context.mock.timers.tick(1);
  assert.equal(calls, 2);
  context.mock.timers.tick(INGEST_RETENTION_INTERVAL_MILLISECONDS - 1);
  assert.equal(calls, 2);
  context.mock.timers.tick(1);
  assert.equal(calls, 3);
  scheduler.stop();
  context.mock.timers.tick(INGEST_RETENTION_INTERVAL_MILLISECONDS * 2);
  assert.equal(calls, 3);
});

it("reports a failed sweep and retries on the next interval", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = new Error("storage busy");
  const errors: unknown[] = [];
  let calls = 0;
  const scheduler = new LedgerRetentionScheduler({
    prune: () => {
      if (++calls === 1) throw failure;
      return { scannedRuns: 0, deletedRuns: 0, deletedPages: 0, deletedEvents: 0, deletedObservations: 0, hasMore: false };
    },
    onPruned: () => assert.fail("no deletion occurred"),
    onError: error => errors.push(error),
  });
  scheduler.start();
  context.mock.timers.tick(5_000);
  assert.deepEqual(errors, [failure]);
  context.mock.timers.tick(INGEST_RETENTION_INTERVAL_MILLISECONDS);
  assert.equal(calls, 2);
  scheduler.stop();
});
