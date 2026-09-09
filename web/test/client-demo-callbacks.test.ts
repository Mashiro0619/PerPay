import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = readFileSync(resolve(process.cwd(), "examples/node-client/public/app.js"), "utf8");
const html = readFileSync(resolve(process.cwd(), "examples/node-client/public/index.html"), "utf8");
const origin = "http://127.0.0.1:6190";
const merchantNo = "DEMO-callback-page";

function mount(notifications = true) {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  const order = {
    merchant_order_no: merchantNo, product_name: "回调验收订单", amount_cents: 100, notifications, last_error: null,
    snapshot: { payable_amount_cents: 101, payment_status: "UNPAID", refund_status: "NONE", version: 1, source: "api", checkout_status: "OPEN", expires_at: new Date(Date.now() + 60_000).toISOString(), checkout_url: origin + "/checkout/pct1_synthetic-test" },
  };
  const state = { csrf: "synthetic-csrf", perpay_url: origin, notifications: true, orders: [order], events: [] as Array<Record<string, unknown>> };
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/demo/state") return Response.json(state);
    if (url === "/demo/orders/" + merchantNo + "/refresh") return Response.json({ merchant_order_no: merchantNo });
    throw Error("unexpected request: " + url);
  });
  runInNewContext(script, { document, crypto: { randomUUID: () => "synthetic-order-id" }, fetch: fetchMock, Date, URL, FormData, setInterval, clearInterval, setTimeout, clearTimeout });
  return { state, fetchMock };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
afterEach(() => { document.body.innerHTML = ""; vi.clearAllTimers(); vi.restoreAllMocks(); });

describe("callback-first caller demo page", () => {
  it("automatically displays verified local callback state without upstream polling", async () => {
    const { state, fetchMock } = mount(); await flush();
    expect(document.querySelector("#notification-hint")).toHaveTextContent("收到付款通知并验签后，订单状态自动更新");
    expect(document.querySelector("#orders")).toHaveTextContent("未确认付款");
    expect(document.querySelector(".actions")?.firstElementChild).toHaveTextContent("打开收银台");
    state.orders[0]!.snapshot.payment_status = "CONFIRMED";
    state.orders[0]!.snapshot.source = "webhook"; state.orders[0]!.snapshot.version = 2;
    state.events.push({ merchant_order_no: merchantNo, event_type: "PAYMENT_CONFIRMED", order_version: 2, disposition: "updated" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelector("#orders")).toHaveTextContent("已确认");
    expect(document.querySelector("#orders")).toHaveTextContent("来源：已验签通知");
    expect(document.querySelector("#events")).toHaveTextContent(merchantNo);
    expect(document.querySelector(".actions a")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/demo/state", "/demo/state"]);
  });
  it("retains manual compensation for legacy orders with no callback address", async () => {
    const { fetchMock } = mount(false); await flush();
    expect(document.querySelector("#orders")).toHaveTextContent("此旧订单没有回调地址，需手动查单");
    document.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click(); await flush();
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/demo/orders/" + merchantNo + "/refresh");
    expect(document.querySelector("#feedback")).toHaveTextContent("已向 PerPay 查询当前状态");
  });
  it("keeps keyboard focus during unchanged local polling and pauses while hidden", async () => {
    const { fetchMock } = mount(); await flush();
    const button = document.querySelector<HTMLButtonElement>('[data-action="refresh"]')!; button.focus();
    await vi.advanceTimersByTimeAsync(5000); expect(document.activeElement).toBe(button);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(10000); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
