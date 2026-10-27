import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import type { CheckoutInitial } from "../../src/shared/checkout-view";

const epoch = Date.UTC(2026, 9, 27, 2);
function initial(payable = 1001): CheckoutInitial {
  return {
    serverTime: epoch, apiUrl: "/api/public/v1/checkouts/pct1_test",
    qrUrl: "/api/public/v1/checkouts/pct1_test/qr.svg", qrAvailable: true, initialError: null,
    checkout: {
      merchant_order_no: "guidance-order", product_name: "测试商品", requested_amount_cents: 1000,
      currency: "CNY", return_url: null,
      payment_instructions: { payable_amount_cents: payable, currency: "CNY" },
      checkout: { status: "OPEN", expires_at: new Date(epoch + 60000).toISOString(), closed_at: null },
      payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null }, refund: { status: "NONE" },
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(epoch);
  vi.stubGlobal("innerWidth", 320);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: initial().checkout }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => { vi.useRealTimers(); });

describe("checkout payment guidance", () => {
  it("shows the exact payable amount and confirmation guidance in the main phone view", () => {
    render(<CheckoutApp initial={initial()} />);
    const guide = screen.getByText("用支付宝扫码，核对收款方。请输入准确金额 ¥10.01（含识别尾数），否则无法自动确认。");
    expect(guide).toBeVisible();
    expect(guide.closest('[role="dialog"]')).toBeNull();
    expect(screen.getByText("付款后会自动查账确认；页面约每 2.5 秒更新状态。到账记录可能延迟，请勿重复付款。")).toBeVisible();
  });
  it("removes payment instructions when the local payment deadline is reached", async () => {
    render(<CheckoutApp initial={initial()} />);
    expect(screen.getByText(/请输入准确金额/)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(screen.queryByText(/请输入准确金额/)).not.toBeInTheDocument();
    expect(screen.queryByText(/付款后会自动查账确认/)).not.toBeInTheDocument();
  });
});
