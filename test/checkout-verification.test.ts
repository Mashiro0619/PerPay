import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CheckoutVerifier } from "../src/runtime/checkout-verification.ts";
import type { LedgerScanResult } from "../src/ledger/service.ts";
import type { LedgerIngestScheduler } from "../src/ledger/scheduler.ts";
const result = (status: LedgerScanResult["status"] = "COMPLETED") =>
  ({ status, normalCompleted: status === "COMPLETED" }) as LedgerScanResult;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe("checkout verification progress", () => {
  it("coalesces an order and waits for reconciliation after actual collection", async () => {
    const scan = deferred<LedgerScanResult>(),
      reconciliation = deferred<void>();
    let calls = 0,
      running = false;
    const scheduler = {
      trigger: () => {
        calls++;
        return scan.promise;
      },
      health: () => ({ inFlight: running }),
      nextRunAt: () => 10000,
    } as unknown as LedgerIngestScheduler;
    const verifier = new CheckoutVerifier(() => 5000);
    const first = verifier.request(
      "order-a",
      scheduler,
      () => reconciliation.promise,
      () => true,
    );
    assert.equal(first.state, "WAITING");
    assert.equal(first.retry_after_seconds, 5);
    assert.equal(
      verifier.request(
        "order-a",
        scheduler,
        () => reconciliation.promise,
        () => true,
      ).id,
      first.id,
    );
    assert.equal(calls, 1);
    assert.equal(verifier.get("order-b"), undefined);
    running = true;
    assert.equal(verifier.get("order-a")?.state, "SCANNING");
    scan.resolve(result());
    await setImmediate();
    assert.equal(verifier.get("order-a")?.state, "RECONCILING");
    reconciliation.resolve();
    await setImmediate();
    assert.equal(verifier.get("order-a")?.state, "COMPLETED");
    assert.equal(
      verifier.request(
        "order-a",
        scheduler,
        async () => {},
        () => true,
      ).id,
      first.id,
    );
  });
  for (const failure of ["scan", "reconcile", "runtime"])
    it("never calls a failed " + failure + " check complete", async () => {
      const scheduler = {
        trigger: async () =>
          result(failure === "scan" ? "FAILED" : "COMPLETED"),
        health: () => ({ inFlight: false }),
        nextRunAt: () => null,
      } as unknown as LedgerIngestScheduler;
      const verifier = new CheckoutVerifier();
      verifier.request(
        "a",
        scheduler,
        async () => {
          if (failure === "reconcile") throw Error("failure");
        },
        () => failure !== "runtime",
      );
      await setImmediate();
      assert.equal(verifier.get("a")?.state, "FAILED");
    });
  it("keeps progress ephemeral across coordinator replacement", () => {
    const verifier = new CheckoutVerifier();
    assert.equal(verifier.get("unknown"), undefined);
  });
});


describe("checkout verification capacity", () => {
  for (const terminal of ["COMPLETED", "FAILED"] as const) {
    it("evicts old " + terminal + " results before rejecting a new order", async () => {
      let now = 0;
      const scheduler = {
        trigger: async () => result(terminal),
        health: () => ({ inFlight: false }), nextRunAt: () => null,
      } as unknown as LedgerIngestScheduler;
      const verifier = new CheckoutVerifier(() => now);
      for (let index = 0; index < 256; index++) {
        verifier.request("order-" + index, scheduler, async () => {}, () => true);
        await setImmediate();
        now++;
      }
      assert.equal(verifier.get("order-0")?.state, terminal);
      const recentId = verifier.get("order-255")?.id;
      const next = verifier.request("order-256", scheduler, async () => {}, () => true);
      assert.ok(next.id);
      assert.equal(verifier.get("order-0"), undefined);
      assert.equal(verifier.get("order-1")?.state, terminal);
      assert.equal(verifier.request("order-255", scheduler, async () => {}, () => true).id, recentId);
      await setImmediate();
      assert.equal(verifier.get("order-256")?.state, terminal);
    });
  }

  it("keeps an unfinished order coalesced when completed records are evicted", async () => {
    const scan = deferred<LedgerScanResult>();
    let activeCalls = 0;
    const active = {
      trigger: () => { activeCalls++; return scan.promise; },
      health: () => ({ inFlight: true }), nextRunAt: () => null,
    } as unknown as LedgerIngestScheduler;
    const completed = {
      trigger: async () => result(), health: () => ({ inFlight: false }), nextRunAt: () => null,
    } as unknown as LedgerIngestScheduler;
    const verifier = new CheckoutVerifier(() => 1000);
    const first = verifier.request("active", active, async () => {}, () => true);
    for (let index = 0; index < 255; index++) {
      verifier.request("done-" + index, completed, async () => {}, () => true);
      await setImmediate();
    }
    verifier.request("new", completed, async () => {}, () => true);
    assert.equal(verifier.get("done-0"), undefined);
    assert.equal(verifier.get("active")?.id, first.id);
    assert.equal(verifier.request("active", active, async () => {}, () => true).id, first.id);
    assert.equal(activeCalls, 1);
    scan.resolve(result());
    await setImmediate();
    assert.equal(verifier.get("active")?.state, "COMPLETED");
  });

  it("still rejects overflow when all records are active and recovers when they finish", async () => {
    const scan = deferred<LedgerScanResult>();
    const scheduler = {
      trigger: () => scan.promise, health: () => ({ inFlight: true }), nextRunAt: () => null,
    } as unknown as LedgerIngestScheduler;
    const verifier = new CheckoutVerifier(() => 1000);
    for (let index = 0; index < 256; index++) verifier.request("active-" + index, scheduler, async () => {}, () => true);
    assert.throws(() => verifier.request("overflow", scheduler, async () => {}, () => true), /capacity exceeded/);
    const firstId = verifier.get("active-0")?.id;
    assert.equal(verifier.request("active-0", scheduler, async () => {}, () => true).id, firstId);
    scan.resolve(result());
    await setImmediate();
    assert.ok(verifier.request("overflow", scheduler, async () => {}, () => true).id);
    await setImmediate();
    assert.equal(verifier.get("overflow")?.state, "COMPLETED");
  });
});
