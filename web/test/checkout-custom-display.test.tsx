import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import type { CheckoutInitial, CheckoutViewOrder } from "../../src/shared/checkout-view";
import type { PublicCheckoutDisplay } from "../../src/shared/checkout-display";

const epoch = Date.UTC(2026, 10, 23, 10, 0, 0);

function makeOrder(
  overrides: Partial<CheckoutViewOrder> = {},
  displayOverrides: Partial<PublicCheckoutDisplay> = {},
): CheckoutViewOrder {
  return {
    display: {
      name: "星河商城",
      help_url: "https://help.example.com",
      help_label: null,
      show_product_name: true,
      show_merchant_order_no: true,
      show_countdown: true,
      show_amount_adjustment: true,
      show_qr_tools: true,
      show_alipay_launch: true,
      show_theme_toggle: true,
      payment_instructions: null,
      adjustment_hint: null,
      notice: null,
      confirmed_detail: null,
      expired_detail: null,
      disputed_detail: null,
      closed_detail: null,
      ...displayOverrides,
    },
    merchant_order_no: "ORD_CUSTOM_1001",
    product_name: "专业版会员年卡",
    currency: "CNY",
    requested_amount_cents: 1900,
    return_url: "https://shop.example.com/return",
    payment_instructions: {
      payable_amount_cents: 1901,
      currency: "CNY",
      collection_code_payload: "https://qr.alipay.com/fkx123456",
    },
    checkout: {
      status: "OPEN",
      expires_at: new Date(epoch + 600_000).toISOString(),
      closed_at: null,
    },
    payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null },
    refund: { status: "NONE" },
    ...overrides,
  };
}

function makeInitial(order: CheckoutViewOrder | null, extra: Partial<CheckoutInitial> = {}): CheckoutInitial {
  return {
    serverTime: epoch,
    apiUrl: order ? "/api/public/v1/checkouts/pct1_custom" : "",
    qrUrl: order ? "/api/public/v1/checkouts/pct1_custom/qr.svg" : "",
    qrAvailable: Boolean(order?.payment_instructions),
    alipayLaunchAvailable: Boolean(order?.payment_instructions),
    initialError: order ? null : { status: 404, code: "checkout_not_found", message: "not found", retryAfterSeconds: null },
    checkout: order,
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: makeOrder() }), { headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("admin-customizable checkout display and copy", () => {
  it("hides toggled-off modules and collapses to single-column when no summary content remains", () => {
    const order = makeOrder(
      {},
      {
        show_product_name: false,
        show_merchant_order_no: false,
        show_countdown: false,
        show_amount_adjustment: false,
        show_qr_tools: false,
        show_alipay_launch: false,
        show_theme_toggle: false,
      },
    );
    const { container } = render(<CheckoutApp initial={makeInitial(order)} />);
    expect(container.querySelector("[data-product-name]")).toBeNull();
    expect(container.querySelector("[data-merchant-order-no]")).toBeNull();
    expect(container.querySelector("[data-countdown]")).toBeNull();
    expect(container.querySelector("[data-checkout-amount-hint]")).toBeNull();
    expect(container.querySelector("[data-checkout-breakdown]")).toBeNull();
    expect(container.querySelector("[data-checkout-qr-tools]")).toBeNull();
    expect(container.querySelector("[data-alipay-launch]")).toBeNull();
    expect(container.querySelector(".checkout-theme-control")).toBeNull();
    expect(container.querySelector("[data-checkout-summary]")).toBeNull();
    expect(container.querySelector("[data-checkout-layout]")).not.toHaveAttribute("data-two-column");
    // Exact payable amount is always preserved so buyers never mispay.
    expect(container.querySelector("[data-payable-amount]")).toHaveTextContent("¥19.01");
  });

  it("renders custom payment instructions, adjustment hint, notice, help label and template tokens", () => {
    const order = makeOrder(
      {},
      {
        help_label: "联系售后客服",
        payment_instructions: "请用支付宝严格支付 {amount}，支付后自动发货。",
        adjustment_hint: "已自动微调 +{offset} 用于区分订单",
        notice: "如 3 分钟未到账请联系客服微信：demo_support",
      },
    );
    const { container } = render(<CheckoutApp initial={makeInitial(order)} />);
    expect(container.querySelector("[data-checkout-payment-instructions]")).toHaveTextContent(
      "请用支付宝严格支付 ¥19.01，支付后自动发货。",
    );
    expect(container.querySelector("[data-checkout-amount-hint]")).toHaveTextContent(
      "已自动微调 +¥0.01 用于区分订单",
    );
    expect(container.querySelector("[data-checkout-custom-notice]")).toHaveTextContent(
      "如 3 分钟未到账请联系客服微信：demo_support",
    );
    expect(screen.getByRole("link", { name: "联系售后客服" })).toHaveAttribute(
      "href",
      "https://help.example.com/",
    );
  });

  it("uses custom terminal copy when configured and falls back to built-in copy when null", () => {
    const expiredCustom = makeOrder(
      {
        payment_instructions: null,
        checkout: { status: "EXPIRED", expires_at: new Date(epoch - 1000).toISOString(), closed_at: new Date(epoch - 1000).toISOString() },
      },
      { expired_detail: "订单已超时，请联系店铺人工核实。" },
    );
    const htmlCustom = renderToString(<CheckoutApp initial={makeInitial(expiredCustom)} />);
    expect(htmlCustom).toContain("订单已超时，请联系店铺人工核实。");
    expect(htmlCustom).not.toContain("如已完成付款，请点击下方");

    const expiredDefault = makeOrder(
      {
        payment_instructions: null,
        checkout: { status: "EXPIRED", expires_at: new Date(epoch - 1000).toISOString(), closed_at: new Date(epoch - 1000).toISOString() },
      },
      { expired_detail: null },
    );
    const htmlDefault = renderToString(<CheckoutApp initial={makeInitial(expiredDefault)} />);
    expect(htmlDefault).toContain("如已完成付款，请点击下方“刷新付款状态”；若仍未确认，请联系商家，勿重复付款。");

    const confirmedCustom = makeOrder(
      {
        payment_instructions: null,
        checkout: { status: "CLOSED", expires_at: new Date(epoch + 1000).toISOString(), closed_at: new Date(epoch).toISOString() },
        payment: { status: "CONFIRMED", basis: "INFERRED", received_amount_cents: 1901 },
      },
      { confirmed_detail: "卡密已发送至您的邮箱，请注意查收。" },
    );
    const htmlConfirmed = renderToString(<CheckoutApp initial={makeInitial(confirmedCustom)} />);
    expect(htmlConfirmed).toContain("卡密已发送至您的邮箱，请注意查收。");
  });

  it("renders global custom 404 detail and escapes hostile markup", () => {
    const html = renderToString(
      <CheckoutApp
        initial={makeInitial(null, {
          notFoundDetail: "订单已失效 <script>alert(1)</script>，请返回官网重新下单。",
        })}
      />,
    );
    expect(html).toContain("订单已失效 &lt;script&gt;alert(1)&lt;/script&gt;，请返回官网重新下单。");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
