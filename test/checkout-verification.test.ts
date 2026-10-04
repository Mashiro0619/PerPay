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
