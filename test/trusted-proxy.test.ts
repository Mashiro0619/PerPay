import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ForwardedAddressError,
  parseTrustedProxyPolicy,
  resolveForwardedClientAddress,
} from "../src/infrastructure/network/trusted-proxy.ts";

describe("trusted proxy address resolution", () => {
  it("ignores forwarding headers unless the direct peer is trusted", () => {
    const policy = parseTrustedProxyPolicy("");
    assert.deepEqual(policy.cidrs, []);
    assert.equal(
      resolveForwardedClientAddress(policy, "127.0.0.1", "198.51.100.7"),
      "127.0.0.1",
    );
    assert.equal(
      resolveForwardedClientAddress(policy, "::ffff:127.0.0.1", "not-an-address"),
      "127.0.0.1",
    );
    assert.equal(resolveForwardedClientAddress(policy, undefined, "198.51.100.7"), "unknown");
  });

  it("walks a trusted chain from right to left", () => {
    const policy = parseTrustedProxyPolicy("10.0.0.0/8,192.0.2.10,2001:db8::/32");
    assert.deepEqual(policy.cidrs, ["10.0.0.0/8", "192.0.2.10", "2001:db8::/32"]);
    assert.equal(
      resolveForwardedClientAddress(
        policy,
        "10.0.0.5",
        "198.51.100.8, 192.0.2.10, 10.9.8.7",
      ),
      "198.51.100.8",
    );
    assert.equal(
      resolveForwardedClientAddress(policy, "2001:db8::1", "2001:db8::2, 10.0.0.2"),
      "2001:db8::2",
    );
    assert.equal(
      resolveForwardedClientAddress(
        policy,
        "2001:0db8:0:0:0:0:0:1",
        "2001:0db8:0:0:0:0:0:7, 10.0.0.2",
      ),
      "2001:db8::7",
    );
  });

  it("returns the leftmost address when every forwarded hop is trusted", () => {
    const policy = parseTrustedProxyPolicy("127.0.0.0/8,10.0.0.0/8");
    assert.equal(
      resolveForwardedClientAddress(policy, "::ffff:127.0.0.1", "10.0.0.1, 127.0.0.2"),
      "10.0.0.1",
    );
  });

  it("rejects malformed trusted proxy configuration", () => {
    for (const value of [
      ",",
      "127.0.0.1,",
      "proxy.internal",
      "127.0.0.1:8080",
      "127.0.0.1/033",
      "0.0.0.0/0",
      "127.0.0.1/33",
      "::/0",
      "2001:db8::1/129",
      "127.0.0.1/32/1",
      "fe80::1%eth0",
      "x".repeat(4 * 1024 + 1),
    ]) {
      assert.throws(() => parseTrustedProxyPolicy(value), /PERPAY_TRUSTED_PROXY_CIDRS/);
    }
  });

  it("rejects malformed forwarding chains from a trusted peer", () => {
    const policy = parseTrustedProxyPolicy("127.0.0.0/8");
    const malformed = [
      "",
      "198.51.100.8,",
      "198.51.100.8,,127.0.0.2",
      "proxy.internal",
      "198.51.100.8:8080",
      "fe80::1%eth0",
      Array.from({ length: 33 }, () => "127.0.0.1").join(","),
      "x".repeat(4 * 1024 + 1),
    ];
    for (const value of malformed) {
      assert.throws(
        () => resolveForwardedClientAddress(policy, "127.0.0.1", value),
        ForwardedAddressError,
      );
    }
  });
});
