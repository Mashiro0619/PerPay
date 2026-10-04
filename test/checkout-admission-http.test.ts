import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";
import { checkoutFrontend } from "../src/http/web/checkout-frontend.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

describe("checkout page admission", () => {
  for (const proxied of [false, true]) {
    it(`limits malformed tokens before rendering via ${proxied ? "trusted proxy" : "direct peer"}`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-checkout-admission-"));
      const services = await createConfiguredHttpServices({
        directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/admission-test",
        environment: { PERPAY_TRUSTED_PROXY_CIDRS: proxied ? "127.0.0.1/32" : "" },
      });
      try {
        const take = PublicCheckoutRateLimiter.prototype.take;
        t.mock.method(PublicCheckoutRateLimiter.prototype, "take", function (this: PublicCheckoutRateLimiter, address: string) {
          return take.call(this, address, 1_000);
        });
        const app = createApp({ ...services, startedAt: new Date() });
        const display = t.mock.method(services.settings, "display");
        const lookup = t.mock.method(services.orders, "publicCheckout");
        assert.ok(checkoutFrontend);
        const render = t.mock.method(checkoutFrontend, "render");
        const request = (token: string, address = "192.0.2.1", forwarded = address) => app.request(
          `/checkout/${token}`, { headers: { "x-forwarded-for": forwarded } },
          { incoming: { socket: { remoteAddress: proxied ? "127.0.0.1" : address, remotePort: 12345, remoteFamily: "IPv4" } } },
        );
        const canonical = `pct1_${Buffer.alloc(32, 23).toString("base64url")}`;
        assert.equal((await request(canonical)).status, 404);
        assert.equal(lookup.mock.callCount(), 1);
        display.mock.resetCalls(); lookup.mock.resetCalls(); render.mock.resetCalls();
        const missing = await request("invalid-token-do-not-echo");
        assert.equal(missing.status, 404);
        const html = await missing.text();
        assert.match(html, /收银台不存在/);
        assert.doesNotMatch(html, /invalid-token-do-not-echo|<script|<link|\/assets\//);
        for (let i = 0; i < 118; i++) assert.equal((await request(`invalid-${i}`)).status, 404);
        for (const token of ["bad", canonical]) {
          const denied = await request(token);
          assert.equal(denied.status, 429);
          assert.equal(denied.headers.get("retry-after"), "1");
          assert.equal(denied.headers.get("cache-control"), "no-store");
          assert.equal(denied.headers.get("x-content-type-options"), "nosniff");
          assert.ok(denied.headers.get("content-security-policy"));
          assert.match(await denied.text(), /请求过于频繁/);
        }
        assert.equal((await request("bad", "192.0.2.2")).status, 404);
        assert.equal((await request("bad", "192.0.2.1", proxied ? "malformed" : "192.0.2.3")).status, proxied ? 400 : 429);
        assert.equal(display.mock.callCount(), 0);
        assert.equal(lookup.mock.callCount(), 0);
        assert.equal(render.mock.callCount(), 0);
      } finally {
        services.database.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
