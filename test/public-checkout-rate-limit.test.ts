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

  it("bounds tracked sources with least-recently-used eviction and expires idle buckets", () => {
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
    assert.equal(limiter.take("198.51.100.2", 1), true);
    assert.equal(limiter.trackedSourceCount, 2);
    assert.equal(limiter.take("198.51.100.1", 2), false);
    assert.equal(limiter.take("198.51.100.3", 2), true);
    assert.equal(limiter.take("198.51.100.2", 2), true);
    assert.equal(limiter.trackedSourceCount, 2);

    assert.equal(limiter.take("198.51.100.3", 102), true);
    assert.equal(limiter.trackedSourceCount, 1);
  });

  it("shares one source budget across an IPv6 /64 prefix", () => {
    const limiter = new PublicCheckoutRateLimiter({
      sourceBurst: 1,
      sourceRequestsPerSecond: 1,
      globalBurst: 100,
      globalRequestsPerSecond: 100,
      maximumTrackedSources: 10,
      sourceIdleTtlMilliseconds: 1_000,
      cleanupIntervalMilliseconds: 100,
    });

    assert.equal(limiter.take("2001:db8:abcd:1234::1", 0), true);
    assert.equal(limiter.take("2001:db8:abcd:1234:ffff::2", 0), false);
    assert.equal(limiter.take("2001:db8:abcd:1235::1", 0), true);
    assert.equal(limiter.trackedSourceCount, 2);
  });

  it("treats IPv4-mapped IPv6 addresses as their IPv4 source", () => {
    const limiter = new PublicCheckoutRateLimiter({
      sourceBurst: 1,
      sourceRequestsPerSecond: 1,
      globalBurst: 100,
      globalRequestsPerSecond: 100,
      maximumTrackedSources: 10,
      sourceIdleTtlMilliseconds: 1_000,
      cleanupIntervalMilliseconds: 100,
    });

    assert.equal(limiter.take("::ffff:192.0.2.1", 0), true);
    assert.equal(limiter.take("192.0.2.1", 0), false);
    assert.equal(limiter.take("::ffff:c000:202", 0), true);
    assert.equal(limiter.trackedSourceCount, 2);
  });
});
