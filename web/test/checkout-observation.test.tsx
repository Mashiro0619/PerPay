import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import { createCheckoutController } from "../src/checkout/controller";
import type { CheckoutInitial, CheckoutViewOrder } from "../../src/shared/checkout-view";

const epoch = Date.UTC(2026, 9, 8);
const disposers: Array<() => void> = [];
function initial(status: "OPEN" | "EXPIRED" | "CLOSED" = "OPEN"): CheckoutInitial {
  return {
    serverTime: epoch, apiUrl: "/api/public/v1/checkouts/pct1_observation",
    qrUrl: "/api/public/v1/checkouts/pct1_observation/qr.svg", qrAvailable: true, initialError: null,
    checkout: {
      merchant_order_no: "timely-payment", product_name: "观察付款结果", requested_amount_cents: 1000,
      currency: "CNY", return_url: null,
      payment_instructions: status === "OPEN" ? { payable_amount_cents: 1001, currency: "CNY" } : null,
      checkout: { status, expires_at: new Date(epoch + 60000).toISOString(), closed_at: status === "OPEN" ? null : new Date(epoch).toISOString() },
      payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null }, refund: { status: "NONE" },
    },
  };
}
function response(order: CheckoutViewOrder) { return Response.json({ data: order }); }
function controller(value = initial()) {
  const view = createCheckoutController(value);
  disposers.push(view.start());
  return view;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(epoch);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); });

describe("observing payment after checkout ends", () => {
  it.each(["EXPIRED", "CLOSED"] as const)("continues GET polling after an %s response and discovers timely payment", async status => {
    const ended = initial(status).checkout!;
    const confirmed = { ...ended, payment: { status: "CONFIRMED" as const, basis: "INFERRED" as const, received_amount_cents: 1001 } };
    const fetch = vi.fn().mockResolvedValueOnce(response(ended)).mockResolvedValueOnce(response(confirmed));
    vi.stubGlobal("fetch", fetch);
    const view = controller();
    await vi.advanceTimersByTimeAsync(1500);
    expect(view.getSnapshot().visual).toBe(status);
    await vi.advanceTimersByTimeAsync(29999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.getSnapshot().visual).toBe("CONFIRMED");
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["GET", "GET"]);
  });

  it.each(["EXPIRED", "CLOSED"] as const)("offers manual GET queries for an initially %s checkout without a return link", async status => {
    const value = initial(status);
    const fetch = vi.fn(async (_url: URL, _options?: RequestInit) => response(value.checkout!));
    vi.stubGlobal("fetch", fetch);
    render(<CheckoutApp initial={value} />);
    expect(screen.queryByRole("button", { name: "保存二维码" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "查询付款状态" })); });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "GET" }));
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/checkouts\/pct1_observation$/);
  });

  it("uses the current anchored clock at send time when OPEN locally expires between ticks", async () => {
    const fetch = vi.fn(async (_url: URL, _options?: RequestInit) => response(initial("EXPIRED").checkout!));
    vi.stubGlobal("fetch", fetch);
    const view = controller();
    expect(view.getSnapshot().suspended).toBe(false);
    // Move wall time without firing the periodic clock update.
    vi.setSystemTime(epoch + 60000);
    await view.refresh(true);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "GET" }));
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/checkouts\/pct1_observation$/);
  });

  it("keeps manual verification POST before the payment deadline", async () => {
    const fetch = vi.fn(async () => response(initial().checkout!));
    vi.stubGlobal("fetch", fetch);
    const view = controller();
    await view.refresh(true);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ method: "POST" }));
  });

  it("stops ended-checkout observation permanently when the server returns 404", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const view = controller(initial("EXPIRED"));
    await vi.advanceTimersByTimeAsync(30000);
    expect(view.getSnapshot().visual).toBe("NOT_FOUND");
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.advanceTimersByTimeAsync(90000);
    await view.refresh(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["online", "visibilitychange"] as const)("refreshes an ended checkout on %s while honoring Retry-After", async event => {
    const ended = initial("CLOSED");
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "60" } })).mockResolvedValue(response(ended.checkout!));
    vi.stubGlobal("fetch", fetch);
    controller(ended);
    (event === "online" ? window : document).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    (event === "online" ? window : document).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(59999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
