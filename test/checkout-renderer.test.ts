import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKOUT_PAGE_ASSETS,
  checkoutApiPath,
  checkoutQrPath,
  deriveCheckoutVisualState,
  renderCheckoutPage,
} from "../src/http/web/checkout.ts";
import { initialCheckoutState } from "../src/shared/checkout-view.ts";
import { alipayQrLaunchUrl } from "../src/shared/collection-code.ts";
import type { PublicCheckoutProjection } from "../src/orders/model.ts";
import { checkoutText, readCheckoutInitial } from "./checkout-view-fixture.ts";
const checkout = Object.freeze({
  merchantOrderNo: "merchant-order-1",
  requestedAmountCents: 1_000,
  currency: "CNY",
  returnUrl: null,
  productName: "测试订单",
  paymentInstructions: Object.freeze({
    payableAmountCents: 1_001,
    currency: "CNY",
    collectionCodePayload: "https://qr.alipay.com/example",
  }),
  checkout: Object.freeze({
    status: "OPEN",
    expiresAt: Date.now() + 300_000,
    closedAt: null,
  }),
  payment: Object.freeze({
    status: "UNPAID",
    basis: "NONE",
    receivedAmountCents: null,
  }),
  refund: Object.freeze({ status: "NONE" }),
}) satisfies PublicCheckoutProjection;

describe("public checkout SSR", () => {
  it("renders exact money but keeps payment disabled until the client guards start", () => {
    const html = renderCheckoutPage({
      checkoutToken: "pct1_test-token",
      checkout,
      qrImageUrl: "/api/public/v1/checkouts/pct1_test-token/qr.svg",
      initialError: null,
    });
    const initial = readCheckoutInitial(html);
    assert.equal(
      initial.checkout?.payment_instructions?.payable_amount_cents,
      1001,
    );
    assert.equal(initial.checkout?.requested_amount_cents, 1000);
    assert.equal(initial.apiUrl, "/api/public/v1/checkouts/pct1_test-token");
    assert.equal(
      initial.qrUrl,
      "/api/public/v1/checkouts/pct1_test-token/qr.svg",
    );
    assert.match(html, /data-payable-amount[^>]*>¥10\.01<\/strong>/);
    assert.doesNotMatch(html, /data-qr-image|data-countdown|放大二维码|保存二维码/);
    assert.match(checkoutText(html), /正在加载收银台…/);
    assert.match(checkoutText(html), /页面正在准备中，请稍候；如长时间未显示二维码，请刷新页面或更换浏览器打开/);
    assert.match(html, /<a[^>]+href="\/checkout\/pct1_test-token"[^>]+data-checkout-reload/);
    assert.match(checkoutText(html), /应付金额/);
    assert.doesNotMatch(checkoutText(html), /请勿修改|扫码付款/);
    assert.match(checkoutText(html), /加载中/);
    assert.match(html, /data-brand="alipay"/);
    assert.match(html, /data-has-order="true"/);
    assert.match(html, /data-checkout-page/);
    assert.match(html, /data-checkout-payment/);
    assert.match(html, /<section[^>]*aria-label="订单信息"[^>]*data-checkout-summary/);
    assert.match(html, /data-checkout-actions/);
    assert.doesNotMatch(html, /<footer|金额需完全一致，付款后自动确认收款/);
    assert.match(checkoutText(html), /刷新页面/);
    assert.ok(
      html.includes('href="' + CHECKOUT_PAGE_ASSETS.checkoutStylesheet + '"'),
    );
    assert.ok(
      html.includes('src="' + CHECKOUT_PAGE_ASSETS.checkoutScript + '"'),
    );
    assert.match(html, /<script type="module" src="\/assets\/checkout\//);
    assert.doesNotMatch(
      html,
      /<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i,
    );
    assert.equal(
      html.includes(checkout.paymentInstructions.collectionCodePayload),
      false,
    );
    assert.equal((html.match(/data-payable-amount/g) ?? []).length, 1);
    assert.match(html, /name="color-scheme" content="light dark"/);
  });
  it("renders a compact summary without exposing or reserving the hidden product name", () => {
    const html = renderCheckoutPage({
      checkoutToken: "pct1_hidden-product",
      checkout,
      qrImageUrl: "/api/public/v1/checkouts/pct1_hidden-product/qr.svg",
      initialError: null,
      showProductName: false,
    });
    const initial = readCheckoutInitial(html);
    assert.equal(initial.showProductName, false);
    assert.equal(initial.checkout?.product_name, "");
    assert.doesNotMatch(html, /data-product-name|测试订单/);
    assert.match(html, /lg:max-w-3xl/);
    assert.doesNotMatch(html, /data-checkout-desktop-guide/);
    assert.match(checkoutText(html), /刷新页面.*商家订单号/);
    assert.doesNotMatch(html, /data-qr-image/);
  });
  it("escapes both the shared SSR view and the JSON bootstrap", () => {
    const hostile = {
      ...checkout,
      merchantOrderNo: 'order"><script>alert(1)</script>',
      productName: "</dd><img src=x onerror=\"alert(1)\"> & 'quoted'",
    };
    const html = renderCheckoutPage({
      checkoutToken: 'pct1_"><script>alert(2)</script>',
      checkout: hostile,
      qrImageUrl: "/qr.svg?name=%22safe%22",
      initialError: null,
    });
    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.equal(html.includes("<script>alert(2)</script>"), false);
    assert.equal(html.includes('onerror="alert(1)"'), false);
    assert.equal(
      readCheckoutInitial(html).checkout?.product_name,
      hostile.productName,
    );
    assert.ok(checkoutText(html).includes(hostile.productName));
  });
  it("never serializes administrator marks, notes, keys or full collection payloads", () => {
    const source = {
      ...checkout,
      refund_mark: { marked: true, note: "private-marker" },
      note: "private-note",
      private_key: "private-key",
    };
    const html = renderCheckoutPage({
      checkoutToken: "pct1_private",
      checkout: source,
      qrImageUrl: "/qr.svg",
      initialError: null,
    });
    assert.doesNotMatch(
      html,
      /private-marker|private-note|private-key|refund_mark|private_key/,
    );
    assert.doesNotMatch(html, /https:\/\/qr\.alipay\.com\/example/);
  });
  it("retains historical refunds without treating an administrator mark as a refund", () => {
    const confirmed: PublicCheckoutProjection = {
      ...checkout,
      paymentInstructions: null,
      payment: {
        status: "CONFIRMED",
        basis: "INFERRED",
        receivedAmountCents: 1001,
      },
      refund: { status: "PARTIAL" },
    };
    const html = renderCheckoutPage({
      checkoutToken: "pct1_paid",
      checkout: confirmed,
      qrImageUrl: "/qr.svg",
      initialError: null,
    });
    assert.equal(deriveCheckoutVisualState(confirmed), "CONFIRMED");
    assert.equal(readCheckoutInitial(html).checkout?.refund.status, "PARTIAL");
    assert.match(checkoutText(html), /付款成功/);
    assert.match(checkoutText(html), /订单已有部分退款记录/);
    assert.doesNotMatch(checkoutText(html), /付款时间推断|人工确认这笔收款/);
    assert.doesNotMatch(html, /data-qr-image/);
  });
  it("hides return during active payment and renders a safe confirmed return target", () => {
    const unpaid = renderCheckoutPage({
      checkoutToken: "pct1_return",
      checkout: { ...checkout, returnUrl: "https://shop.example.com/done" },
      qrImageUrl: "/qr.svg",
      initialError: null,
    });
    assert.doesNotMatch(
      unpaid,
      /<a[^>]+href="https:\/\/shop\.example\.com\/done"/,
    );
    const confirmed: PublicCheckoutProjection = {
      ...checkout,
      returnUrl: "https://shop.example.com/done",
      paymentInstructions: null,
      payment: {
        status: "CONFIRMED",
        basis: "INFERRED",
        receivedAmountCents: 1001,
      },
    };
    const html = renderCheckoutPage({
      checkoutToken: "pct1_return",
      checkout: confirmed,
      qrImageUrl: null,
      initialError: null,
    });
    assert.match(html, /<a[^>]+href="https:\/\/shop\.example\.com\/done"/);
    assert.match(checkoutText(html), /返回商家/);
    const unsafe = renderCheckoutPage({
      checkoutToken: "pct1_return",
      checkout: { ...confirmed, returnUrl: "javascript:alert(1)" },
      qrImageUrl: null,
      initialError: null,
    });
    assert.equal(readCheckoutInitial(unsafe).checkout?.return_url, null);
    assert.doesNotMatch(unsafe, /javascript:|返回商家/);
  });
  for (const state of ["CONFIRMED", "DISPUTED", "CLOSED", "EXPIRED"] as const)
    it("omits all payment controls for " + state, () => {
      const value: PublicCheckoutProjection =
        state === "CONFIRMED" || state === "DISPUTED"
          ? {
              ...checkout,
              paymentInstructions: null,
              payment: {
                status: state,
                basis: "INFERRED",
                receivedAmountCents: 1001,
              },
            }
          : {
              ...checkout,
              paymentInstructions: null,
              checkout: { ...checkout.checkout, status: state },
            };
      const html = renderCheckoutPage({
        checkoutToken: "pct1_terminal",
        checkout: value,
        qrImageUrl: null,
        initialError: null,
      });
      assert.equal(initialCheckoutState(readCheckoutInitial(html)), state);
      assert.doesNotMatch(
        html,
        /data-qr-image|data-countdown|放大二维码|保存二维码/,
      );
      const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
      assert.ok(buttons.every(button => !button.includes("我已付款，查询状态") && !button.includes("刷新付款状态")));
      assert.match(html, /data-product-name/);
    });
  for (const [status, state, heading] of [
    [503, "UNAVAILABLE", "收银台暂不可用"],
    [429, "RATE_LIMITED", "当前访问较多"],
    [404, "NOT_FOUND", "找不到这个订单"],
  ] as const)
    it("preserves the meaning of route status " + status, () => {
      const html = renderCheckoutPage({
        checkoutToken: "pct1_error",
        checkout: null,
        qrImageUrl: null,
        initialError: {
          status,
          code: "test-error",
          message: "internal-only-detail",
          retryAfterSeconds: status === 404 ? null : 5,
        },
      });
      const initial = readCheckoutInitial(html);
      assert.equal(initialCheckoutState(initial), state);
      assert.match(html, /data-has-order="false"/);
      assert.doesNotMatch(html, /data-checkout-summary|data-checkout-desktop-guide/);
      assert.equal(initial.initialError?.status, status);
      assert.equal(
        initial.initialError?.retryAfterSeconds,
        status === 404 ? null : 5,
      );
      assert.match(checkoutText(html), new RegExp(heading));
      assert.doesNotMatch(html, /data-qr-image|<img[^>]+src=""/);
      assert.doesNotMatch(checkoutText(html), /internal-only-detail/);
      if (status === 404) {
        assert.equal(initial.apiUrl, "");
        assert.equal(initial.qrUrl, "");
        assert.doesNotMatch(checkoutText(html), /重新获取订单|查询状态|刷新付款状态/);
      } else assert.match(checkoutText(html), /刷新页面/);
    });
  it("disables an existing order during a service outage", () => {
    const html = renderCheckoutPage({
      checkoutToken: "pct1_outage",
      checkout,
      qrImageUrl: null,
      initialError: {
        status: 503,
        code: "not-ready",
        message: "not ready",
        retryAfterSeconds: 5,
      },
    });
    assert.equal(
      initialCheckoutState(readCheckoutInitial(html)),
      "UNAVAILABLE",
    );
    assert.doesNotMatch(html, /data-qr-image/);
    assert.match(checkoutText(html), /刷新页面/);
  });
  it("rejects external QR assets and preserves token path encoding", () => {
    assert.throws(
      () =>
        renderCheckoutPage({
          checkoutToken: "pct1_bad",
          checkout,
          qrImageUrl: "https://elsewhere.test/qr.svg",
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

  it("advertises alipayLaunchAvailable only for validated Alipay QR payloads without leaking the raw payload into SSR HTML", () => {
    const validHtml = renderCheckoutPage({
      checkoutToken: "pct1_launch_ok",
      checkout,
      qrImageUrl: "/api/public/v1/checkouts/pct1_launch_ok/qr.svg",
      initialError: null,
    });
    assert.equal(readCheckoutInitial(validHtml).alipayLaunchAvailable, true);
    assert.equal(validHtml.includes("qr.alipay.com"), false);
    assert.equal(validHtml.includes("alipays://"), false);
    assert.equal(validHtml.includes("打开支付宝"), false);

    const nonAlipayHtml = renderCheckoutPage({
      checkoutToken: "pct1_launch_other",
      checkout: {
        ...checkout,
        paymentInstructions: {
          ...checkout.paymentInstructions,
          collectionCodePayload: "https://example.invalid/not-alipay",
        },
      },
      qrImageUrl: "/api/public/v1/checkouts/pct1_launch_other/qr.svg",
      initialError: null,
    });
    assert.equal(readCheckoutInitial(nonAlipayHtml).alipayLaunchAvailable, false);

    assert.equal(
      alipayQrLaunchUrl("https://qr.alipay.com/fkx12345?t=1"),
      "alipays://platformapi/startapp?saId=10000007&qrcode=https%3A%2F%2Fqr.alipay.com%2Ffkx12345%3Ft%3D1",
    );
    assert.equal(alipayQrLaunchUrl("javascript:alert(1)"), null);
    assert.equal(alipayQrLaunchUrl("alipays://platformapi/startapp?appId=20000123"), null);
  });

  it("applies site custom display flags, custom copy and global 404 copy on SSR without leaking hidden order numbers", () => {
    const customExpired: PublicCheckoutProjection = {
      ...checkout,
      display: {
        name: "自定义商户",
        help_url: "https://help.example.com",
        help_label: "联系售后",
        show_product_name: false,
        show_merchant_order_no: false,
        show_countdown: false,
        show_amount_adjustment: false,
        show_qr_tools: false,
        show_alipay_launch: false,
        show_theme_toggle: false,
        payment_instructions: null,
        adjustment_hint: null,
        notice: "客服工作时间 09:00-21:00",
        confirmed_detail: null,
        expired_detail: "订单已超时，请联系店铺补发链接。",
        disputed_detail: null,
        closed_detail: null,
      },
      paymentInstructions: null,
      checkout: { ...checkout.checkout, status: "EXPIRED" },
    };
    const html = renderCheckoutPage({
      checkoutToken: "pct1_custom_expired",
      checkout: customExpired,
      qrImageUrl: null,
      initialError: null,
    });
    const initial = readCheckoutInitial(html);
    assert.equal(initial.checkout?.product_name, "");
    assert.equal(initial.checkout?.merchant_order_no, "");
    assert.doesNotMatch(html, /merchant-order-1|测试订单|data-product-name|data-merchant-order-no|checkout-theme-control/);
    assert.match(checkoutText(html), /订单已超时，请联系店铺补发链接。/);
    assert.match(checkoutText(html), /客服工作时间 09:00-21:00/);
    assert.match(checkoutText(html), /联系售后/);

    const custom404 = renderCheckoutPage({
      checkoutToken: "pct1_missing",
      checkout: null,
      qrImageUrl: null,
      notFoundDetail: "该付款页已作废，请在原订单页重新发起。",
      initialError: {
        status: 404,
        code: "checkout_not_found",
        message: "not found",
        retryAfterSeconds: null,
      },
    });
    assert.match(checkoutText(custom404), /该付款页已作废，请在原订单页重新发起。/);
  });
});
