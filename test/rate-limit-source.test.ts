import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregateRateLimitSource } from "../src/infrastructure/network/rate-limit-source.ts";

describe("shared rate-limit source keys", () => {
  it("aggregates IPv6 interface addresses and equivalent spellings into one /64", () => {
    for (const address of ["2001:db8:1:2::1", "2001:0DB8:0001:0002:0000:0000:0000:ffff", "2001:db8:1:2:abcd:1234:5678:90ab"]) {
      assert.equal(aggregateRateLimitSource(address), "2001:db8:1:2::/64");
    }
    assert.notEqual(aggregateRateLimitSource("2001:db8:1:3::1"), "2001:db8:1:2::/64");
  });

  it("shares IPv4 and mapped IPv6 budgets without grouping unrelated IPv4 clients", () => {
    for (const address of ["192.0.2.1", "::ffff:192.0.2.1", "::ffff:c000:201", "0:0:0:0:0:FFFF:c000:0201"]) {
      assert.equal(aggregateRateLimitSource(address), "192.0.2.1");
    }
    assert.equal(aggregateRateLimitSource("192.0.2.2"), "192.0.2.2");
    assert.equal(aggregateRateLimitSource("unknown"), "unknown");
  });
});
