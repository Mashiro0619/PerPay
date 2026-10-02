import assert from "node:assert/strict";
import { it } from "node:test";
import { withHttpFixture, login } from "./reconciliation-http-fixture.ts";
it("exposes readable summaries and confirmation timestamps only to administrators", async () => {
  await withHttpFixture(async (f) => {
    const paid = f.createSettlement("summary-readable", 2300).order;
    const unpaid = f.createOrder("not-yet-paid", 2400);
    const auth = await login(f.app);
    const response = await f.app.request("/api/admin/v1/orders", {
      headers: { cookie: auth.cookie },
    });
    const data = (
      (await response.json()) as {
        data: Array<{ order_id: string; payment_confirmed_at: string | null }>;
      }
    ).data;
    assert.ok(
      data.find((o) => o.order_id === paid.orderId)!.payment_confirmed_at,
    );
    assert.equal(
      data.find((o) => o.order_id === unpaid.orderId)!.payment_confirmed_at,
      null,
    );
    const matches = await f.app.request(
      "/api/admin/v1/reconciliation/matches?q=summary-readable",
      { headers: { cookie: auth.cookie } },
    );
    const match = (
      (await matches.json()) as {
        data: Array<{
          order: { merchant_order_no: string; product_name: string };
        }>;
      }
    ).data[0]!;
    assert.equal(match.order.merchant_order_no, paid.merchantOrderNo);
    assert.equal(match.order.product_name, paid.productName);
    const pub = await f.app.request(
      "/api/public/v1/checkouts/" + paid.checkoutToken,
    );
    assert.ok(
      !(
        "payment_confirmed_at" in ((await pub.json()) as { data: object }).data
      ),
    );
  });
});
