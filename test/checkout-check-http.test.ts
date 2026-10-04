import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import type { CheckoutVerification } from "../src/shared/checkout-verification.ts";
it("keeps GET passive, guards manual POST and scopes progress to a valid checkout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-manual-check-"));
  const services = await createConfiguredHttpServices({
    directory,
    apiSecret: null,
    collectionCodePayload: "https://qr.alipay.com/check",
  });
  try {
    let calls = 0;
    const now = Date.now();
    const states = new Map<string, CheckoutVerification>();
    const order = services.orders.create(
      createOrderRequestSchema.parse({
        idempotency_key: "manual-check-1",
        merchant_order_no: "manual-check-1",
        amount_cents: 100,
        product_name: "check",
      }),
    ).order;
    const second = services.orders.create(
      createOrderRequestSchema.parse({
        idempotency_key: "manual-check-2",
        merchant_order_no: "manual-check-2",
        amount_cents: 100,
        product_name: "check",
      }),
    ).order;
    const health = {
      enabled: true,
      state: "healthy" as const,
      inFlight: false,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: null,
      consecutiveFailures: 0,
    };
    const dependencies = {
      ...services,
      startedAt: new Date(),
      clock: () => now,
      ledgerHealth: () => health,
      reconciliationHealth: () => ({
        ...health,
        pendingOrders: 0,
        continuationPending: false,
      }),
      checkoutVerification: (id: string) => states.get(id),
      requestCheckoutVerification: (id: string) => {
        calls++;
        const value = {
          id: "11111111-1111-4111-8111-111111111111",
          state: "WAITING" as const,
          requested_at: new Date(now).toISOString(),
          retry_after_seconds: 5,
        };
        states.set(id, value);
        return value;
      },
    };
    const app = createApp(dependencies);
    const url = "/api/public/v1/checkouts/" + order.checkoutToken;
    assert.equal((await app.request(url)).status, 200);
    assert.equal(calls, 0);
    const post = (target = url, origin = "http://localhost:6190") =>
      app.request(target + "/check", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await post(url, "https://attacker.example")).status, 403);
    assert.equal(calls, 0);
    const accepted = await post();
    assert.equal(accepted.status, 202);
    assert.equal(accepted.headers.get("retry-after"), "5");
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.equal(calls, 1);
    const body = (await (await app.request(url)).json()) as {
      data: { verification: CheckoutVerification };
    };
    assert.equal(body.data.verification.state, "WAITING");
    assert.equal(calls, 1);
    const other = (await (
      await app.request("/api/public/v1/checkouts/" + second.checkoutToken)
    ).json()) as { data: { verification?: CheckoutVerification } };
    assert.equal(other.data.verification, undefined);
    assert.equal((await post("/api/public/v1/checkouts/invalid")).status, 404);
    assert.equal(calls, 1);
    services.orders.close(order.orderId);
    assert.equal((await post()).status, 200);
    assert.equal(calls, 1);
    const demo = createApp({ ...dependencies, demoMode: true });
    assert.equal(
      (
        await demo.request(url + "/check", {
          method: "POST",
          headers: {
            origin: "http://localhost:6190",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(calls, 1);
  } finally {
    services.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
