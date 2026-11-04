import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import type { CheckoutInitial } from "../../src/shared/checkout-view";

const epoch = Date.UTC(2026, 10, 4, 2);
function initial(): CheckoutInitial {
  return {
    serverTime: epoch,
    apiUrl: "/api/public/v1/checkouts/qr-recovery",
    qrUrl: "/api/public/v1/checkouts/qr-recovery/qr.svg",
    qrAvailable: true,
    initialError: null,
    checkout: {
      merchant_order_no: "qr-recovery",
      product_name: "二维码重试",
      requested_amount_cents: 1900,
      currency: "CNY",
      return_url: null,
      payment_instructions: { payable_amount_cents: 1901, currency: "CNY" },
      checkout: { status: "OPEN", expires_at: new Date(epoch + 60000).toISOString(), closed_at: null },
      payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null },
      refund: { status: "NONE" },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: initial().checkout })));
});

describe("checkout QR recovery", () => {
  it("replaces a failed image and retries with a new image source on every attempt", () => {
    render(<CheckoutApp initial={initial()} />);
    const first = screen.getByRole("img", { name: "用于支付此订单的支付宝付款二维码" });
    fireEvent.error(first);
    expect(screen.getByText("二维码加载失败")).toBeVisible();
    expect(first).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存二维码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "放大二维码" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新加载二维码" }));
    const second = screen.getByRole("img", { name: "用于支付此订单的支付宝付款二维码" });
    expect(second).toHaveAttribute("src", initial().qrUrl + "?retry=1");
    fireEvent.error(second);
    fireEvent.click(screen.getByRole("button", { name: "重新加载二维码" }));
    const third = screen.getByRole("img", { name: "用于支付此订单的支付宝付款二维码" });
    expect(third).toHaveAttribute("src", initial().qrUrl + "?retry=2");
    fireEvent.load(third);
    expect(screen.queryByText("二维码加载失败")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放大二维码" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存二维码" })).toBeEnabled();
  });

  it("returns an expanded-image failure to the same recoverable payment state", async () => {
    render(<CheckoutApp initial={initial()} />);
    fireEvent.click(screen.getByRole("button", { name: "放大二维码" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("dialog", { name: "支付宝付款二维码" })).toBeVisible();
    fireEvent.error(screen.getByRole("img", { name: "放大的支付宝付款二维码" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("二维码加载失败")).toBeVisible();
    expect(screen.queryByRole("img", { name: "用于支付此订单的支付宝付款二维码" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载二维码" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "重新加载二维码" }));
    expect(screen.getByRole("img", { name: "用于支付此订单的支付宝付款二维码" })).toBeVisible();
  });

  it("removes the failed QR and retry action when the payment deadline passes", async () => {
    render(<CheckoutApp initial={initial()} />);
    fireEvent.error(screen.getByRole("img", { name: "用于支付此订单的支付宝付款二维码" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(screen.queryByText("二维码加载失败")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新加载二维码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByText(/请输入准确金额/)).not.toBeInTheDocument();
  });
});
