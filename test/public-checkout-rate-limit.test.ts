import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";

describe("public checkout rate limiter", () => {
  it("isolates source budgets and does not charge source-rejected requests globally", () => {
    const limiter = new PublicCheckoutRateLimiter({
      sourceBurst: 1,
      sourceRequestsPerSecond: 1,
      globalBurst: 2,
      globalRequestsPerSecond: 1,
      maximumTrackedSources: 10,
      sourceIdleTtlMilliseconds: 1_000,
      cleanupIntervalMilliseconds: 100,
    });

    assert.equal(limiter.take("198.51.100.1", 0), true);
    assert.equal(limiter.take("198.51.100.1", 0), false);
    assert.equal(limiter.take("198.51.100.2", 0), true);
    assert.equal(limiter.take("198.51.100.3", 0), false);
  });

  it("enforces a hard global budget across otherwise eligible sources", () => {
    const limiter = new PublicCheckoutRateLimiter({
      sourceBurst: 10,
      sourceRequestsPerSecond: 1,
      globalBurst: 3,
      globalRequestsPerSecond: 1,
      maximumTrackedSources: 10,
      sourceIdleTtlMilliseconds: 1_000,
      cleanupIntervalMilliseconds: 100,
    });

    assert.equal(limiter.take("198.51.100.1", 0), true);
    assert.equal(limiter.take("198.51.100.2", 0), true);
    assert.equal(limiter.take("198.51.100.3", 0), true);
    assert.equal(limiter.take("198.51.100.4", 0), false);
    assert.equal(limiter.take("198.51.100.4", 1_000), true);
  });

  it("bounds tracked sources, shares overflow capacity, and expires idle buckets", () => {
    const limiter = new PublicCheckoutRateLimiter({
      sourceBurst: 1,
      sourceRequestsPerSecond: 1,
      globalBurst: 100,
      globalRequestsPerSecond: 100,
      maximumTrackedSources: 2,
      sourceIdleTtlMilliseconds: 100,
      cleanupIntervalMilliseconds: 50,
    });

    assert.equal(limiter.take("198.51.100.1", 0), true);
    assert.equal(limiter.take("198.51.100.2", 0), true);
    assert.equal(limiter.trackedSourceCount, 2);
    assert.equal(limiter.take("198.51.100.3", 0), true);
    assert.equal(limiter.take("198.51.100.4", 0), false);
    assert.equal(limiter.trackedSourceCount, 2);

    assert.equal(limiter.take("198.51.100.3", 101), true);
    assert.equal(limiter.trackedSourceCount, 1);
  });
});
