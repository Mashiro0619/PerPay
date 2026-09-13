import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

describe("administrator HTTP rate limits", () => {
  for (const proxied of [false, true]) {
    it("shares IPv6 failures through the " + (proxied ? "trusted proxy" : "direct peer") + " path", async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-auth-http-"));
      const now = 2_000_000_000_000;
      const services = await createConfiguredHttpServices({
        directory, apiSecret: Buffer.alloc(32, 7).toString("base64url"),
        collectionCodePayload: "https://qr.alipay.com/rate-limit-test", identityClock: () => now,
        environment: { PERPAY_TRUSTED_PROXY_CIDRS: proxied ? "127.0.0.1/32" : "" },
      });
      const app = createApp({ ...services, startedAt: new Date(now) });
      const request = (address: string, password: string, extraHeaders = {}) => app.request(
        "http://localhost:6190/api/admin/v1/session/login", {
          method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:6190",
            ...(proxied ? { "x-forwarded-for": address } : {}), ...extraHeaders },
          body: JSON.stringify({ password }),
        }, { incoming: { socket: { remoteAddress: proxied ? "127.0.0.1" : address, remotePort: 12345, remoteFamily: proxied ? "IPv4" : "IPv6" } } },
      );
      try {
        for (let i = 1; i <= 5; i += 1) {
          const response = await request("2001:db8:1:2::" + i, "incorrect-password");
          assert.equal(response.status, 401);
        }
        const blocked = await request("2001:0db8:0001:0002::99", HTTP_TEST_ADMIN_PASSWORD);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get("retry-after"), "30");
        if (!proxied) {
          assert.equal((await request("2001:db8:1:2::1", HTTP_TEST_ADMIN_PASSWORD,
            { "x-forwarded-for": "198.51.100.90" })).status, 429);
        }
        assert.equal((await request("2001:db8:1:3::1", HTTP_TEST_ADMIN_PASSWORD)).status, 200);
        for (let i = 4; i <= 6; i += 1) {
          assert.equal((await request("2001:db8:1:" + i + "::1", "incorrect-password")).status, 401);
        }
        // Setup + five failures + one success + three failures consume the burst.
        const globalBlocked = await request("2001:db8:1:7::1", HTTP_TEST_ADMIN_PASSWORD);
        assert.equal(globalBlocked.status, 429);
        assert.equal(globalBlocked.headers.get("retry-after"), "5");
      } finally { services.database.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
