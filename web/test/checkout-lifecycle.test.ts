import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderCheckoutPage } from "../../src/http/web/checkout";

vi.mock("../../src/http/web/assets", () => ({ WEB_ASSET_URLS: {
  alipayIcon: "/assets/app/alipay.png", checkoutStylesheet: "/assets/app/checkout.css", checkoutScript: "/assets/app/checkout.js",
} }));

const script = readFileSync(resolve(process.cwd(), "static/app/checkout.js"), "utf8");
const now = Date.parse("2026-09-08T04:00:00.000Z");
const qrPath = "/api/public/v1/checkouts/pct1_lifecycle-test/qr.svg";

function mount(wallClockOffset = 0, loadingDelay = 0) {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const expiresAt = now + 2_000;
  const html = renderCheckoutPage({
    checkoutToken: "pct1_lifecycle-test", qrImageUrl: qrPath, initialError: null,
    checkout: {
      merchantOrderNo: "lifecycle-test", requestedAmountCents: 100, currency: "CNY", productName: "测试订单", returnUrl: null,
      paymentInstructions: { payableAmountCents: 101, currency: "CNY", collectionCodePayload: "https://qr.alipay.com/test" },
      checkout: { status: "OPEN", expiresAt, closedAt: null },
      payment: { status: "UNPAID", basis: "NONE", receivedAmountCents: null }, refund: { status: "NONE" },
    },
  });
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  vi.setSystemTime(now + wallClockOffset + loadingDelay);
  const browserEvents = new Map<string, () => void>();
  const documentEvents = new Map<string, () => void>();
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener) => { documentEvents.set(type, listener as () => void); });
  let elapsed = loadingDelay;
  const navigator = { onLine: true };
  const fetchMock = vi.fn<() => Promise<Response>>(async () => { throw new Error("network unavailable"); });
  const host = {
    location: { origin: "http://localhost:6190" }, performance: { now: () => elapsed, getEntriesByType: () => [{ responseStart: 0 }] },
    addEventListener: (type: string, listener: () => void) => browserEvents.set(type, listener),
    setInterval, clearInterval, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; },
  };
  runInNewContext(script, {
    window: host, document, navigator, Date, URL, AbortController, fetch: fetchMock,
    HTMLElement, HTMLImageElement, HTMLDialogElement, HTMLAnchorElement, HTMLTimeElement,
  });
  const panel = document.querySelector<HTMLElement>("[data-qr-panel]")!;
  const image = document.querySelector<HTMLImageElement>("[data-qr-image]")!;
  const download = document.querySelector<HTMLAnchorElement>("[data-qr-download]")!;
  const dialog = document.querySelector<HTMLDialogElement>("[data-qr-dialog]")!;
  return {
    panel, image, download, dialog, fetchMock,
    offline: () => { navigator.onLine = false; browserEvents.get("offline")!(); },
    online: () => { navigator.onLine = true; browserEvents.get("online")!(); },
    advance: async (milliseconds: number) => { elapsed += milliseconds; await vi.advanceTimersByTimeAsync(milliseconds); },
    sleep: async (milliseconds: number) => { await vi.advanceTimersByTimeAsync(milliseconds); },
    confirm: (status: "OPEN" | "CONFIRMED") => {
      fetchMock.mockImplementation(async () => Response.json({ data: {
        merchant_order_no: "lifecycle-test", requested_amount_cents: 100, currency: "CNY", product_name: "测试订单", return_url: null,
        checkout: { status: "OPEN", expires_at: new Date(now + 30_000).toISOString() },
        payment: { status: status === "CONFIRMED" ? "CONFIRMED" : "UNPAID", basis: status === "CONFIRMED" ? "INFERRED" : "NONE", received_amount_cents: status === "CONFIRMED" ? 101 : null },
        refund: { status: "NONE" }, payment_instructions: status === "CONFIRMED" ? null : { payable_amount_cents: 101, currency: "CNY" },
      } }, { headers: { date: new Date(now + elapsed).toUTCString() } }));
    },
  };
}

afterEach(() => { document.body.innerHTML = ""; vi.clearAllTimers(); });

describe("public checkout expiry", () => {
  it("does not extend the payment window while the page script is loading", () => {
    const page = mount(0, 5_000);
    expect(page.panel.hidden).toBe(true);
    expect(page.image).not.toHaveAttribute("src");
  });

  it("expires while the operating system suspends its performance clock", async () => {
    const page = mount(); page.offline();
    await page.sleep(5_000);
    expect(page.panel.hidden).toBe(true);
    expect(page.image).not.toHaveAttribute("src");
  });

  it.each(["offline", "network failure"])("removes every payment entry after the known deadline during %s", async (failure) => {
    const page = mount();
    expect(page.panel.hidden).toBe(false);
    page.dialog.showModal();
    if (failure === "offline") page.offline();
    await page.advance(3_000);
    expect(page.panel.hidden).toBe(true);
    expect(page.dialog.open).toBe(false);
    expect(page.image).not.toHaveAttribute("src");
    expect(page.download).not.toHaveAttribute("href");
    expect(document.querySelector("[data-qr-dialog-image]")).not.toHaveAttribute("src");
    expect(document.querySelector<HTMLElement>("[data-payment-guidance]")!.hidden).toBe(true);
    expect(document.querySelector("[data-status-heading]")).toHaveTextContent("请暂勿付款");
    expect(document.querySelector("[data-checkout-root]")).toHaveAttribute("data-payment-status", "UNPAID");
    expect(document.querySelector<HTMLElement>("[data-checkout-refresh]")!.hidden).toBe(false);
    page.image.dispatchEvent(new Event("load"));
    expect(document.querySelector<HTMLElement>(".checkout-code-actions")!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-qr-expand]")!.click();
    document.querySelector<HTMLButtonElement>("[data-qr-reload]")!.click();
    expect(page.dialog.open).toBe(false);
    expect(page.image).not.toHaveAttribute("src");
  });

  it.each([-3_600_000, 3_600_000])("uses server time rather than a client clock offset of %s milliseconds", async (offset) => {
    const page = mount(offset);
    expect(page.panel.hidden).toBe(false);
    page.offline();
    await page.advance(3_000);
    expect(page.panel.hidden).toBe(true);
  });

  it("reopens payment only after the server confirms a valid payment window", async () => {
    const page = mount(); page.offline();
    await page.advance(3_000);
    expect(page.panel.hidden).toBe(true);
    page.confirm("OPEN"); page.online();
    await page.advance(1);
    expect(page.panel.hidden).toBe(false);
    expect(page.image).toHaveAttribute("src", qrPath);
    expect(page.download).toHaveAttribute("href", qrPath);
    expect(document.querySelector("[data-status-heading]")).toHaveTextContent("支付宝付款");
  });

  it("displays a late confirmed payment without reopening the QR code", async () => {
    const page = mount(); page.offline();
    await page.advance(3_000);
    page.confirm("CONFIRMED"); page.online();
    await page.advance(1);
    expect(document.querySelector("[data-status-heading]")).toHaveTextContent("付款已确认");
    expect(page.panel.hidden).toBe(true);
    expect(page.image).not.toHaveAttribute("src");
    expect(page.download).not.toHaveAttribute("href");
  });
});

function orderResponse(options: {
  payment?: "UNPAID" | "CONFIRMED" | "DISPUTED";
  checkout?: "OPEN" | "CLOSED" | "EXPIRED";
  refund?: "NONE" | "PARTIAL" | "FULL";
  amount?: number;
  returnUrl?: string | null;
} = {}) {
  const payment = options.payment ?? "UNPAID";
  const checkout = options.checkout ?? "OPEN";
  return Response.json({ data: {
    merchant_order_no: "lifecycle-test", requested_amount_cents: 100, currency: "CNY",
    product_name: "测试订单", return_url: options.returnUrl ?? null,
    checkout: { status: checkout, expires_at: new Date(now + 60_000).toISOString() },
    payment: { status: payment, basis: payment === "UNPAID" ? "NONE" : "INFERRED", received_amount_cents: payment === "UNPAID" ? null : options.amount ?? 101 },
    refund: { status: options.refund ?? "NONE" },
    payment_instructions: payment === "UNPAID" && checkout === "OPEN" ? { payable_amount_cents: options.amount ?? 101, currency: "CNY" } : null,
  } }, { headers: { date: new Date(now).toUTCString() } });
}

describe("compact checkout presentation", () => {
  it("keeps a single main amount above the QR and secondary controls before the query action", () => {
    mount();
    const amount = document.querySelector("[data-payable-amount]")!;
    const qr = document.querySelector("[data-qr-image]")!;
    const query = document.querySelector("[data-checkout-refresh]")!;
    expect(document.querySelectorAll("[data-payable-amount]")).toHaveLength(1);
    expect(amount.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector("[data-qr-expand]")!.compareDocumentPosition(query) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".checkout-footer, .checkout-exact-note, img[aria-hidden]" )).toBeNull();
    expect(document.querySelector("[data-qr-dialog-amount]")).toHaveTextContent("¥ 1.01");
  });

  it("updates the main and enlarged-code amounts from the same response", async () => {
    const page = mount();
    page.fetchMock.mockResolvedValueOnce(orderResponse({ amount: 123 }));
    document.querySelector<HTMLButtonElement>("[data-checkout-refresh]")!.click();
    await page.advance(1);
    expect(document.querySelector("[data-payable-amount]")).toHaveTextContent("1.23");
    expect(document.querySelector("[data-qr-dialog-amount]")).toHaveTextContent("¥ 1.23");
    expect(document.querySelector("[data-amount-accessible]")).toHaveTextContent("应付金额 1.23 元");
    expect(document.querySelector("[data-checkout-refresh-label]")).toHaveTextContent("查询付款状态");
  });

  it.each([
    { payment: "CONFIRMED" as const, heading: "付款已确认", refund: "PARTIAL" as const },
    { payment: "DISPUTED" as const, heading: "付款需要核实" },
    { checkout: "CLOSED" as const, heading: "订单已关闭" },
    { checkout: "EXPIRED" as const, heading: "订单已过期" },
  ])("removes payment actions and announces $heading without a second status panel", async options => {
    const page = mount();
    page.dialog.showModal();
    page.fetchMock.mockResolvedValueOnce(orderResponse({ ...options, returnUrl: "https://shop.example.com/orders/1" }));
    document.querySelector<HTMLButtonElement>("[data-checkout-refresh]")!.click();
    await page.advance(1);
    expect(document.querySelector("[data-status-heading]")).toHaveTextContent(options.heading);
    expect(document.querySelector("[data-state-announcement]")).toHaveTextContent(options.heading);
    expect(page.dialog.open).toBe(false);
    expect(page.image).not.toHaveAttribute("src");
    expect(page.download).not.toHaveAttribute("href");
    expect(document.querySelector<HTMLElement>("[data-payment-column]")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-update-message]")!.hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("[data-status-heading]"));
    const returnLink = document.querySelector<HTMLAnchorElement>("[data-return-merchant]")!;
    expect(returnLink.hidden).toBe(options.payment !== "CONFIRMED");
    if (options.payment !== "CONFIRMED") expect(returnLink).not.toHaveAttribute("href");
    if (options.refund) expect(document.querySelector<HTMLElement>("[data-refund-message]")!.hidden).toBe(false);
  });

  it("hides the countdown and QR during service failure, then recovers from a fresh response", async () => {
    const page = mount(); page.dialog.showModal();
    page.fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "reconciliation_not_ready" } }, { status: 503, headers: { "retry-after": "5" } }));
    document.querySelector<HTMLButtonElement>("[data-checkout-refresh]")!.click();
    await page.advance(1);
    expect(page.panel.hidden).toBe(true);
    expect(page.dialog.open).toBe(false);
    expect(page.download).not.toHaveAttribute("href");
    expect(document.querySelector<HTMLElement>("[data-countdown-wrap]")!.hidden).toBe(true);
    expect(document.querySelector("[data-status-detail]")).toHaveTextContent("请勿付款");
    expect(document.querySelector("[data-service-alert]")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-status-heading]"));
    page.fetchMock.mockResolvedValue(orderResponse());
    await page.advance(5_000);
    expect(page.panel.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("[data-countdown-wrap]")!.hidden).toBe(false);
    expect(document.querySelector("[data-status-heading]")).toHaveTextContent("支付宝付款");
  });
  it("keeps a QR image failure visible across status polling until the image is retried", async () => {
    const page = mount(); page.dialog.showModal();
    page.image.dispatchEvent(new Event("error"));
    expect(page.dialog.open).toBe(false);
    expect(document.querySelector<HTMLElement>("[data-qr-error]")!.hidden).toBe(false);
    page.fetchMock.mockResolvedValue(orderResponse());
    document.querySelector<HTMLButtonElement>("[data-checkout-refresh]")!.click();
    await page.advance(1);
    expect(page.image.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-qr-error]")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".checkout-code-actions")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("[data-payment-guidance]")!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-qr-reload]")!.click();
    expect(page.image.getAttribute("src")).toContain("retry=");
    page.image.dispatchEvent(new Event("load"));
    expect(page.image.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("[data-qr-error]")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".checkout-code-actions")!.hidden).toBe(false);
  });

});
