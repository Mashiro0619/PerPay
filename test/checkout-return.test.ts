import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { OrderService } from "../src/orders/service.ts";
import { createOrderRequestSchema } from "../src/orders/model.ts";
import { readCheckoutInitial, checkoutText } from "./checkout-view-fixture.ts";
import { withHttpFixture } from "./reconciliation-http-fixture.ts";

const returnUrl = "https://shop.example.com/orders/result?source=checkout";
for (const state of ["UNPAID", "CONFIRMED", "CLOSED", "EXPIRED", "DISPUTED", "UNAVAILABLE", "NO_RETURN"] as const) {
  it(
    "preserves merchant navigation through the real checkout projection for " + state,
    async () => {
      await withHttpFixture(async (fixture) => {
        const { services, database, baseTime } = fixture;
        await services.settings.saveWebhook({
          revision: services.settings.view().revision,
          enabled: true,
          allowed_origin: "https://shop.example.com",
          timeout_milliseconds: 5000,
          maximum_attempts: 5,
          retry_base_seconds: 10,
          retry_maximum_seconds: 600,
        }, { actorId: "admin" });
        let now = baseTime + 1000;
        const orders = new OrderService(database, () => services.settings.snapshot(), () => now);
        const order = orders.create(createOrderRequestSchema.parse({
          idempotency_key: "checkout-return-" + state,
          merchant_order_no: "checkout-return-" + state,
          product_name: "合成返回入口测试订单",
          amount_cents: 1900,
          ...(state === "NO_RETURN" ? {} : { return_url: returnUrl }),
        })).order;
        if (state === "CONFIRMED" || state === "DISPUTED") {
          const entry = fixture.recordCredit("checkout-return-" + state, order.payableAmountCents, 0);
          now = baseTime + 65_000;
          const result = fixture.reconciliation.reconcileEntry(entry.ledgerEntryId, now);
          assert.equal(result.kind, "auto_settled");
          if (state === "DISPUTED" && result.kind === "auto_settled") {
            fixture.reconciliation.reverseSettlement({
              financialOperationId: randomUUID(), paymentMatchId: result.paymentMatchId,
              actorId: "admin", reason: "synthetic return-link regression", now: ++now,
            });
          }
        } else if (state === "CLOSED" || state === "NO_RETURN") orders.close(order.orderId);
        else if (state === "EXPIRED") now = order.checkout.expiresAt + 1;

        const healthy = () => ({
          enabled: true, state: "healthy" as const, inFlight: false,
          lastAttemptAt: now, lastSuccessAt: now, lastErrorCode: null, consecutiveFailures: 0,
        });
        const app = createApp({
          ...services, orders, startedAt: new Date(baseTime), clock: () => now,
          ...(state === "UNAVAILABLE" ? {} : {
            ledgerHealth: healthy,
            reconciliationHealth: () => ({ ...healthy(), pendingOrders: 0, continuationPending: false }),
          }),
        });
        const response = await app.request("/checkout/" + order.checkoutToken);
        assert.equal(response.status, state === "UNAVAILABLE" ? 503 : 200);
        const html = await response.text();
        const initial = readCheckoutInitial(html);
        assert.equal(initial.checkout?.return_url, state === "NO_RETURN" ? null : returnUrl);
        const body = checkoutText(html);
        if (state === "UNPAID" || state === "NO_RETURN") assert.doesNotMatch(body, /返回商家/);
        else {
          assert.ok(body.includes(state === "CONFIRMED" ? "返回商家" : "返回商家处理"));
          assert.ok(html.includes('href="' + returnUrl + '"'));
        }
        if (state !== "UNAVAILABLE") {
          const response = await app.request("/api/public/v1/checkouts/" + order.checkoutToken);
          assert.equal(response.status, 200);
          const { data } = await response.json() as { data: { return_url: string | null } };
          assert.equal(data.return_url, state === "NO_RETURN" ? null : returnUrl);
        }
      });
    },
  );
}

for (const mode of ["both", "notify-only", "return-only", "neither"] as const) {
  it("keeps notification delivery and browser return URLs independent: " + mode, async () => {
    await withHttpFixture(async (fixture) => {
      const { services, webhooks, baseTime } = fixture;
      const notifyUrl = "https://shop.example.com/webhooks/perpay";
      const helpUrl = "https://support.example.com/payment-guide";
      const hasNotify = mode === "both" || mode === "notify-only";
      const hasReturn = mode === "both" || mode === "return-only";
      await services.settings.saveWebhook({
        revision: services.settings.view().revision,
        enabled: true, allowed_origin: "https://shop.example.com",
        timeout_milliseconds: 5000, maximum_attempts: 5,
        retry_base_seconds: 10, retry_maximum_seconds: 600,
      }, { actorId: "admin" });
      await services.settings.saveDisplay({
        revision: services.settings.view().revision,
        checkout_show_product_name: true, dashboard_chart_type: "AREA",
        checkout_help_url: helpUrl,
      }, { actorId: "admin" });
      const order = services.orders.create(createOrderRequestSchema.parse({
        idempotency_key: "separate-urls-" + mode,
        merchant_order_no: "separate-urls-" + mode,
        product_name: "合成链接分离测试", amount_cents: 2900,
        ...(hasNotify ? { notify_url: notifyUrl } : {}),
        ...(hasReturn ? { return_url: returnUrl } : {}),
      })).order;
      assert.equal(order.notification.notifyUrl, hasNotify ? notifyUrl : null);
      assert.equal(order.returnUrl, hasReturn ? returnUrl : null);
      const entry = fixture.recordCredit("separate-urls-" + mode, order.payableAmountCents, 0);
      assert.equal(fixture.reconciliation.reconcileEntry(entry.ledgerEntryId, baseTime + 65_000).kind, "auto_settled");
      const html = await (await fixture.app.request("/checkout/" + order.checkoutToken)).text();
      const initial = readCheckoutInitial(html);
      assert.equal(initial.checkout?.return_url, hasReturn ? returnUrl : null);
      assert.equal(initial.helpUrl, helpUrl);
      assert.ok(html.includes('href="' + helpUrl + '"'));
      assert.equal(html.includes('href="' + returnUrl + '"'), hasReturn);
      assert.ok(!html.includes(notifyUrl), "notification target must not become a public checkout link");
      assert.equal(webhooks.materialize(10, baseTime + 66_000), hasNotify ? 1 : 0);
      const deliveries = webhooks.listDeliveriesForOrder({ orderId: order.orderId, limit: 10 });
      assert.equal(deliveries.deliveries.length, hasNotify ? 1 : 0);
      if (hasNotify) assert.equal(deliveries.deliveries[0]?.target.targetUrl, notifyUrl);
    });
  });
}
