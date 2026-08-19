import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHECKOUT_PAGE_ASSETS,
  checkoutApiPath,
  checkoutQrPath,
  deriveCheckoutVisualState,
  renderCheckoutPage,
} from "../src/http/web/checkout.ts";
import type { PublicCheckoutProjection } from "../src/orders/model.ts";

const checkout = Object.freeze({
  merchantOrderNo: "merchant-order-1",
  requestedAmountCents: 1_000,
  currency: "CNY",
  description: "测试订单",
  paymentInstructions: Object.freeze({
    payableAmountCents: 1_001,
    currency: "CNY",
    collectionCodePayload: "https://qr.alipay.com/example",
  }),
  checkout: Object.freeze({
    status: "OPEN",
    expiresAt: Date.parse("2026-08-18T08:30:00.000Z"),
    closedAt: null,
  }),
  payment: Object.freeze({
    status: "UNPAID",
    basis: "NONE",
    receivedAmountCents: null,
  }),
  refund: Object.freeze({ status: "NONE" }),
}) satisfies PublicCheckoutProjection;

describe("public checkout renderer", () => {
  it("renders exact payable amount, same-origin assets, and no inline executable content", () => {
    const html = renderCheckoutPage({
      checkoutToken: "pct1_test-token",
      checkout,
      qrImageUrl: "/api/public/v1/checkouts/pct1_test-token/qr.svg",
      initialError: null,
    });

    assert.match(html, /data-payable-amount[^>]*>10\.01<\/strong>/);
    assert.match(html, /data-requested-amount>¥ 10\.00<\/dd>/);
    assert.match(html, /data-initial-state="UNPAID"/);
    assert.match(html, /付款后请停留在本页/);
    assert.match(html, /data-checkout-api-url="\/api\/public\/v1\/checkouts\/pct1_test-token"/);
    assert.match(html, /data-checkout-qr-url="\/api\/public\/v1\/checkouts\/pct1_test-token\/qr\.svg"/);
    assert.match(html, /data-checkout-refresh-label>立即检查支付状态/);
    assert.doesNotMatch(html, /data-checkout-refresh[^>]*hidden/);
    assert.match(html, new RegExp(`href="${escapeRegExp(CHECKOUT_PAGE_ASSETS.checkoutStylesheet)}"`));
    assert.equal((html.match(/<link rel="stylesheet"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`src="${escapeRegExp(CHECKOUT_PAGE_ASSETS.checkoutScript)}" defer`));
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
    assert.equal(html.includes(checkout.paymentInstructions.collectionCodePayload), false);
  });

  it("escapes all merchant-controlled text and attributes", () => {
    const hostileCheckout: PublicCheckoutProjection = {
      ...checkout,
      merchantOrderNo: `order"><script>alert(1)</script>`,
      description: `</dd><img src=x onerror="alert(1)"> & 'quoted'`,
    };
    const html = renderCheckoutPage({
      checkoutToken: `pct1_"><script>alert(2)</script>`,
      checkout: hostileCheckout,
      qrImageUrl: "/qr.svg?name=%22safe%22",
      initialError: null,
    });

    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.equal(html.includes("<script>alert(2)</script>"), false);
    assert.equal(html.includes("onerror=\"alert(1)\""), false);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&amp; &#39;quoted&#39;/);
  });

  it("does not render payment instructions for terminal states", () => {
    const confirmed: PublicCheckoutProjection = {
      ...checkout,
      paymentInstructions: null,
      payment: { status: "CONFIRMED", basis: "INFERRED", receivedAmountCents: 1_001 },
      refund: { status: "PARTIAL" },
    };
    const html = renderCheckoutPage({
      checkoutToken: "pct1_confirmed",
      checkout: confirmed,
      qrImageUrl: "/qr.svg",
      initialError: null,
    });

    assert.equal(deriveCheckoutVisualState(confirmed), "CONFIRMED");
    assert.match(html, /data-initial-state="CONFIRMED"/);
    assert.match(html, /data-qr-panel hidden/);
    assert.match(html, /已自动确认/);
    assert.match(html, /款项已部分退款/);
    assert.match(html, /data-checkout-refresh[^>]*hidden/);
  });

  it("renders retryable 503 and final 404 states without exposing a QR panel", () => {
    const unavailable = renderCheckoutPage({
      checkoutToken: "pct1_unavailable",
      checkout: null,
      qrImageUrl: "/qr.svg",
      initialError: {
        status: 503,
        code: "reconciliation_not_ready",
        message: "internal message is not presentation copy",
        retryAfterSeconds: 5,
      },
    });
    assert.match(unavailable, /data-initial-state="UNAVAILABLE"/);
    assert.match(unavailable, /请暂勿付款/);
    assert.match(unavailable, /data-retry-after-seconds="5"/);
    assert.match(unavailable, /data-checkout-content hidden/);
    assert.match(unavailable, /data-checkout-refresh[^>]*hidden/);
    assert.match(unavailable, /data-route-error[^>]*role="alert"[^>]*aria-live="assertive"/);
    assert.match(unavailable, /data-route-error-title tabindex="-1"/);
    assert.match(unavailable, /data-checkout-qr-url="\/qr\.svg"/);

    const rateLimited = renderCheckoutPage({
      checkoutToken: "pct1_rate_limited",
      checkout: null,
      qrImageUrl: null,
      initialError: {
        status: 429,
        code: "public_checkout_rate_limited",
        message: "rate limited",
        retryAfterSeconds: 1,
      },
    });
    assert.match(
      rateLimited,
      /data-checkout-qr-url="\/api\/public\/v1\/checkouts\/pct1_rate_limited\/qr\.svg"/,
    );
    assert.match(rateLimited, /data-qr-image\s+data-original-src=""/);

    const missing = renderCheckoutPage({
      checkoutToken: "pct1_missing",
      checkout: null,
      qrImageUrl: null,
      initialError: {
        status: 404,
        code: "checkout_not_found",
        message: "not found",
        retryAfterSeconds: null,
      },
    });
    assert.match(missing, /data-initial-state="NOT_FOUND"/);
    assert.match(missing, /找不到这个订单/);
    assert.match(missing, /data-checkout-retry hidden/);
    assert.match(missing, /data-checkout-refresh[^>]*hidden/);
    assert.doesNotMatch(missing, /<img\s+src=""/);
  });

  it("rejects external QR assets and preserves token path encoding", () => {
    assert.throws(
      () => renderCheckoutPage({
        checkoutToken: "pct1_external",
        checkout,
        qrImageUrl: "https://example.com/qr.svg",
        initialError: null,
      }),
      /same-origin absolute path/,
    );
    assert.equal(
      checkoutApiPath("pct1_a/b?c"),
      "/api/public/v1/checkouts/pct1_a%2Fb%3Fc",
    );
    assert.equal(
      checkoutQrPath("pct1_a/b?c"),
      "/api/public/v1/checkouts/pct1_a%2Fb%3Fc/qr.svg",
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
