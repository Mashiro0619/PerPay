import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCheckoutController,
  retryDelay,
} from "../src/checkout/controller";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import {
  checkoutMoney,
  parseCheckoutPayload,
  type CheckoutInitial,
  type CheckoutViewOrder,
} from "../../src/shared/checkout-view";
const epoch = Date.UTC(2026, 8, 16, 6);
let hidden = false,
  online = true;
const cleanups: Array<() => void> = [];
function initial(overrides: Partial<CheckoutInitial> = {}): CheckoutInitial {
  return {
    serverTime: epoch,
    apiUrl: "/api/public/v1/checkouts/pct1_test",
    qrUrl: "/api/public/v1/checkouts/pct1_test/qr.svg",
    qrAvailable: true,
    initialError: null,
    checkout: {
      merchant_order_no: "preview-order",
      product_name: "测试商品",
      requested_amount_cents: 1000,
      currency: "CNY",
      return_url: "https://shop.example.com/done",
      payment_instructions: { payable_amount_cents: 1001, currency: "CNY" },
      checkout: {
        status: "OPEN",
        expires_at: new Date(epoch + 60000).toISOString(),
        closed_at: null,
      },
      payment: { status: "UNPAID", basis: "NONE", received_amount_cents: null },
      refund: { status: "NONE" },
    },
    ...overrides,
  };
}
function response(order: CheckoutViewOrder = initial().checkout!) {
  return new Response(JSON.stringify({ data: order }), {
    headers: {
      "content-type": "application/json",
      date: new Date(Date.now()).toUTCString(),
    },
  });
}
function controller(value = initial()) {
  const result = createCheckoutController(value);
  cleanups.push(result.start());
  return result;
}
function pendingFetch() {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    (_url: URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, finish: (response: Response) => finish(response) };
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
  vi.setSystemTime(epoch);
  hidden = false;
  online = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response()),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
});
describe("checkout payment layout", () => {
  it("places the brand above the QR and the inline amount below, with a single status countdown", () => {
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const brand = container.querySelector("[data-brand=alipay]")!;
    const amount = container.querySelector<HTMLElement>("[data-payable-amount]")!;
    const qr = container.querySelector("[data-qr-image]")!;
    expect(
      brand.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      qr.compareDocumentPosition(amount) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector("[data-amount-label]")).toHaveTextContent(
      /^应付金额$/,
    );
    const amountRow = container.querySelector("[data-checkout-amount]");
    expect(amountRow).toContainElement(amount);
    expect(amountRow).toContainElement(container.querySelector("[data-amount-label]"));
    expect(amountRow).toHaveClass("flex", "items-baseline", "justify-center");
    expect(amountRow).not.toHaveClass("flex-col", "flex-wrap");
    expect(screen.queryByText(/请勿修改|扫码付款/)).not.toBeInTheDocument();
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("剩余 01:00");
    expect(timer).toHaveAttribute(
      "dateTime",
      initial().checkout!.checkout.expires_at,
    );
    expect(timer.closest('[data-slot="badge"]')).toHaveTextContent(
      "等待付款",
    );
    expect(timer.closest('[data-slot="card-action"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-countdown]")).toHaveLength(1);
    expect(timer).toHaveAttribute("aria-live", "off");
  });
  it("updates the merged countdown without announcing each second or changing its badge", async () => {
    render(createElement(CheckoutApp, { initial: initial() }));
    const timer = screen.getByRole("timer");
    const badge = timer.closest('[data-slot="badge"]');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("timer")).toBe(timer);
    expect(timer.closest('[data-slot="badge"]')).toBe(badge);
    expect(timer).toHaveTextContent("剩余 00:59");
    expect(
      screen.getAllByRole("status").some((status) => status.contains(timer)),
    ).toBe(false);
  });
  it("keeps the hour segment for payment windows longer than one hour", () => {
    const value = initial();
    value.checkout!.checkout.expires_at = new Date(epoch + 3661000).toISOString();
    render(createElement(CheckoutApp, { initial: value }));
    expect(screen.getByRole("timer")).toHaveTextContent("剩余 01:01:01");
  });
  it("replaces the countdown with state confirmation and removes the QR at local expiry", async () => {
    const value = initial();
    value.checkout!.checkout.expires_at = new Date(epoch + 1000).toISOString();
    pendingFetch();
    const { container } = render(
      createElement(CheckoutApp, { initial: value }),
    );
    expect(screen.getByRole("timer")).toHaveTextContent("剩余 00:01");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).toHaveTextContent(
      "等待状态确认",
    );
    expect(container.querySelector("[data-qr-image]")).toBeNull();
  });
  it.each(["CONFIRMED", "DISPUTED", "CLOSED", "EXPIRED"] as const)(
    "does not retain a payment countdown after a %s response",
    async (status) => {
      const { finish } = pendingFetch();
      const { container } = render(
        createElement(CheckoutApp, { initial: initial() }),
      );
      expect(screen.getByRole("timer")).toBeInTheDocument();
      const order = initial().checkout!;
      order.payment_instructions = null;
      if (status === "CONFIRMED" || status === "DISPUTED") {
        order.payment = {
          status,
          basis: "INFERRED",
          received_amount_cents: 1001,
        };
      } else {
        order.checkout = { ...order.checkout, status };
      }
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "查询付款状态" }));
        finish(response(order));
      });
      expect(screen.queryByRole("timer")).not.toBeInTheDocument();
      expect(container.querySelector("[data-qr-image]")).toBeNull();
      expect(
        container.querySelector('[data-slot="badge"]'),
      ).not.toHaveTextContent("等待付款");
    },
  );
});

describe("checkout desktop composition", () => {
  it("separates the payment area from one order summary and its actions", () => {
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const payment = container.querySelector("[data-checkout-payment]")!;
    const summary = screen.getByRole("region", { name: "订单信息" });
    expect(payment).toContainElement(container.querySelector("[data-qr-image]"));
    expect(payment).toContainElement(container.querySelector("[data-payable-amount]"));
    expect(summary).toContainElement(screen.getByText("测试商品"));
    expect(summary).toContainElement(
      screen.getByRole("button", { name: "复制商户订单号" }),
    );
    expect(summary).toContainElement(
      screen.getByRole("button", { name: "查询付款状态" }),
    );
    expect(payment).not.toContainElement(summary);
    expect(container.querySelectorAll("[data-qr-image]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-payable-amount]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-countdown]")).toHaveLength(1);
    expect(summary.querySelector("[data-checkout-desktop-guide]")).toHaveTextContent(
      "支付宝扫描二维码",
    );
  });
  it("keeps the same QR and in-flight read while resizing instead of mounting another checkout", async () => {
    const { fetch: read, finish } = pendingFetch();
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const qr = container.querySelector("[data-qr-image]");
    const query = screen.getByRole("button", { name: "查询付款状态" });
    fireEvent.click(query);
    fireEvent(window, new Event("resize"));
    expect(container.querySelector("[data-qr-image]")).toBe(qr);
    expect(screen.getByRole("button", { name: "查询付款状态" })).toBe(query);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await act(async () => { finish(response()); });
    expect(container.querySelector("[data-checkout-actions]")).toContainElement(
      screen.getByText("已检查，暂未确认付款。"),
    );
  });
  it("puts the confirmed return action in the summary and removes desktop payment guidance", async () => {
    const { finish } = pendingFetch();
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const paid = initial().checkout!;
    paid.payment_instructions = null;
    paid.payment = {
      status: "CONFIRMED", basis: "INFERRED", received_amount_cents: 1001,
    };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查询付款状态" }));
      finish(response(paid));
    });
    const summary = screen.getByRole("region", { name: "订单信息" });
    expect(summary).toContainElement(screen.getByRole("link", { name: "返回商家" }));
    expect(container.querySelector("[data-checkout-desktop-guide]")).toBeNull();
    expect(container.querySelector("[data-qr-image]")).toBeNull();
    expect(container.querySelector("[data-countdown]")).toBeNull();
  });
  it.each([404, 429, 503] as const)(
    "uses a compact error view without an empty summary for a %i response",
    (status) => {
      const { container } = render(createElement(CheckoutApp, {
        initial: initial({
          checkout: null,
          qrAvailable: false,
          initialError: {
            status, code: "unavailable", message: "unavailable",
            retryAfterSeconds: status === 404 ? null : 5,
          },
        }),
      }));
      expect(screen.queryByRole("region", { name: "订单信息" })).not.toBeInTheDocument();
      expect(container.querySelector("[data-checkout-layout]")).toHaveAttribute(
        "data-has-order", "false",
      );
      expect(container.querySelector("[data-checkout-desktop-guide]")).toBeNull();
      expect(container.querySelector("[data-qr-image]")).toBeNull();
      expect(container.querySelector("[data-payable-amount]")).toBeNull();
    },
  );
});

describe("checkout compact QR and page shell", () => {
  it("uses the complete server QR without a second padded border in either view", () => {
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const image = container.querySelector("[data-qr-image]")!;
    const extraPadding = /(?:^|\s)(?:[\w-]+:)*p(?:[xytrblse])?-\S+/;
    expect(image.getAttribute("class")).not.toMatch(extraPadding);
    fireEvent.click(screen.getByRole("button", { name: "放大二维码" }));
    const expanded = document.querySelector("[data-qr-dialog-image]")!;
    expect(expanded.getAttribute("class")).not.toMatch(extraPadding);
    expect(expanded).toHaveAttribute("src", image.getAttribute("src"));
    expect(screen.getByRole("dialog")).toHaveTextContent("¥10.01");
  });
  it("centers an intrinsic-height checkout between flexible page tracks without fixing its position", () => {
    const { container } = render(
      createElement(CheckoutApp, { initial: initial() }),
    );
    const page = container.querySelector("[data-checkout-page]");
    expect(page).toHaveClass(
      "grid", "h-svh", "min-h-min", "grid-rows-[1fr_auto_1fr]",
    );
    expect(screen.getByRole("banner")).toHaveClass("self-start");
    expect(screen.getByRole("main")).not.toHaveClass("flex-1");
    expect(
      container.querySelector("[data-checkout-layout]"),
    ).not.toHaveClass("fixed", "absolute");
  });
});

describe("checkout compact order summary", () => {
  it.each([true, false])(
    "keeps one natural-flow action group and unboxed guidance when product visibility is %s",
    (showProductName) => {
      const { container } = render(
        createElement(CheckoutApp, { initial: initial({ showProductName }) }),
      );
      const summary = screen.getByRole("region", { name: "订单信息" });
      const guide = summary.querySelector("[data-checkout-desktop-guide]")!;
      expect(guide.tagName).toBe("P");
      expect(guide.closest('[data-slot="alert"]')).toBeNull();
      const actions = summary.querySelector("[data-checkout-actions]");
      expect(actions).not.toHaveClass("mt-auto");
      expect(actions).toHaveClass("md:contents");
      expect(actions).toContainElement(
        screen.getByRole("button", { name: "查询付款状态" }),
      );
      expect(summary.querySelectorAll("dt")).toHaveLength(showProductName ? 2 : 1);
      expect(container.querySelectorAll("[data-product-name]")).toHaveLength(
        showProductName ? 1 : 0,
      );
      expect(container.querySelectorAll("[data-brand=alipay]")).toHaveLength(1);
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    },
  );
});

describe("checkout controller", () => {
  it.each([429, 503] as const)(
    "preserves hidden product names when the initial %i page recovers",
    async (status) => {
      const { container } = render(
        createElement(CheckoutApp, {
          initial: initial({
            showProductName: false,
            checkout: null,
            qrAvailable: false,
            initialError: {
              status,
              code: "temporarily_unavailable",
              message: "wait",
              retryAfterSeconds: 1,
            },
          }),
        }),
      );
      expect(container.querySelector("[data-qr-image]")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(fetch).toHaveBeenCalled();
      expect(container.querySelector("[data-qr-image]")).not.toBeNull();
      expect(
        container.querySelector("[data-payable-amount]"),
      ).toHaveTextContent("¥10.01");
      expect(container.querySelector("[data-product-name]")).toBeNull();
      expect(screen.queryByText("测试商品")).not.toBeInTheDocument();
    },
  );
  it("keeps the product name hidden after a public polling response and retains the payment amount", async () => {
    const { container } = render(
      createElement(CheckoutApp, {
        initial: initial({ showProductName: false }),
      }),
    );
    expect(container.querySelector("[data-product-name]")).toBeNull();
    expect(container.querySelector("[data-brand=alipay]")).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查询付款状态" }));
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(fetch).toHaveBeenCalled();
    expect(container.querySelector("[data-product-name]")).toBeNull();
    expect(screen.queryByText("测试商品")).not.toBeInTheDocument();
    expect(container.querySelector("[data-payable-amount]")).toHaveTextContent(
      "¥10.01",
    );
    expect(container.querySelector("footer")).toBeNull();
  });
  it("does not extend a payment window while the client bundle loads", () => {
    vi.advanceTimersByTime(61000);
    const view = controller();
    expect(view.getSnapshot().suspended).toBe(true);
    expect(view.getSnapshot().now).toBeGreaterThanOrEqual(epoch + 61000);
  });
  it.each([-86400000, 86400000])(
    "uses server time despite a client clock offset of %i",
    (offset) => {
      vi.setSystemTime(epoch + offset);
      const view = controller();
      expect(view.getSnapshot().now).toBe(epoch);
      expect(view.getSnapshot().suspended).toBe(false);
    },
  );
  it("expires after OS suspension even when the performance clock stops", () => {
    const view = controller();
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.setSystemTime(epoch + 61000);
    vi.advanceTimersByTime(1000);
    expect(view.getSnapshot().suspended).toBe(true);
  });
  it("coalesces repeated manual checks into one request", async () => {
    const pending = pendingFetch();
    const view = controller();
    const first = view.refresh(true);
    await view.refresh(true);
    await view.refresh();
    expect(pending.fetch).toHaveBeenCalledOnce();
    pending.finish(response());
    await first;
    expect(view.getSnapshot().feedback).toBe("已检查，暂未确认付款。");
  });
  it.each(["offline", "hidden", "pagehide"])(
    "aborts an active request and rejects its late result on %s",
    async (event) => {
      const pending = pendingFetch();
      const view = controller();
      const request = view.refresh();
      const signal = pending.fetch.mock.calls[0]![1]!.signal!;
      if (event === "offline") {
        online = false;
        window.dispatchEvent(new Event("offline"));
      } else if (event === "hidden") {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      } else window.dispatchEvent(new Event("pagehide"));
      expect(signal.aborted).toBe(true);
      pending.finish(
        response({ ...initial().checkout!, product_name: "stale" }),
      );
      await request;
      expect(view.getSnapshot().order?.product_name).toBe("测试商品");
    },
  );
  it("counts time spent in BFCache before showing any payment entry", async () => {
    pendingFetch();
    const view = controller();
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(61000);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    expect(view.getSnapshot().suspended).toBe(true);
  });
  it("retains a retry-after deadline across offline/online transitions", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("", { status: 429, headers: { "retry-after": "10" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const view = controller();
    await view.refresh();
    online = false;
    window.dispatchEvent(new Event("offline"));
    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["manual", "visibility", "online", "bfcache"] as const)(
    "keeps a 503 Retry-After deadline across %s refreshes",
    async (cause) => {
      const fetch = vi
        .fn(async () => response())
        .mockResolvedValueOnce(
          new Response("", { status: 503, headers: { "retry-after": "10" } }),
        );
      vi.stubGlobal("fetch", fetch);
      const view = controller();
      await view.refresh();
      if (cause === "manual") await view.refresh(true);
      if (cause === "visibility") {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (cause === "online") {
        online = false;
        window.dispatchEvent(new Event("offline"));
        online = true;
        window.dispatchEvent(new Event("online"));
      }
      if (cause === "bfcache") {
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      }
      await vi.advanceTimersByTimeAsync(9999);
      expect(fetch).toHaveBeenCalledOnce();
      expect(view.getSnapshot()).toMatchObject({
        visual: "UNAVAILABLE",
        qrAvailable: false,
        retryAt: epoch + 10000,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(view.getSnapshot()).toMatchObject({
        visual: "UNPAID",
        retryAt: 0,
      });
    },
  );
  it("waits before retrying an initial route-level rate limit", async () => {
    const fetch = vi.mocked(globalThis.fetch);
    const view = controller(
      initial({
        checkout: null,
        qrAvailable: false,
        initialError: {
          status: 429,
          code: "limited",
          message: "wait",
          retryAfterSeconds: 5,
        },
      }),
    );
    await view.refresh(true);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("closes payment on a service failure and only restores it from a fresh server response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    const view = controller();
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({
      visual: "UNAVAILABLE",
      qrAvailable: false,
    });
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({
      visual: "UNPAID",
      qrAvailable: true,
      suspended: false,
    });
  });
  it("can show a late confirmed payment without reopening payment instructions", async () => {
    const value = initial();
    const paid = {
      ...value.checkout!,
      payment: {
        status: "CONFIRMED" as const,
        basis: "INFERRED" as const,
        received_amount_cents: 1001,
      },
      payment_instructions: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(paid)),
    );
    const view = controller(value);
    await vi.advanceTimersByTimeAsync(61000);
    await view.refresh(true);
    expect(view.getSnapshot()).toMatchObject({
      visual: "CONFIRMED",
      order: { payment_instructions: null },
    });
  });
  it.each([false, true])(
    "makes a final 404 inert across browser events (initial=%s)",
    async (fromStart) => {
      const fetch = vi.fn(async () => new Response("", { status: 404 }));
      vi.stubGlobal("fetch", fetch);
      const view = controller(
        fromStart
          ? initial({
              checkout: null,
              apiUrl: "",
              qrUrl: "",
              qrAvailable: false,
              initialError: {
                status: 404,
                code: "missing",
                message: "missing",
                retryAfterSeconds: null,
              },
            })
          : initial(),
      );
      if (!fromStart) await view.refresh();
      const count = fetch.mock.calls.length;
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120000);
      await view.refresh(true);
      expect(fetch).toHaveBeenCalledTimes(count);
      expect(view.getSnapshot()).toMatchObject({
        visual: "NOT_FOUND",
        order: null,
        qrAvailable: false,
        message: "",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("drops requests after unmount and aborts their signal", async () => {
    const pending = pendingFetch();
    const view = createCheckoutController(initial());
    const dispose = view.start();
    const request = view.refresh();
    dispose();
    expect(pending.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    pending.finish(response());
    await request;
    expect(view.getSnapshot().busy).toBe(false);
  });
  it("rejects malformed currency data and strips all admin-only properties", () => {
    const order = initial().checkout!;
    expect(
      parseCheckoutPayload({
        data: { ...order, refund_mark: { note: "private" }, note: "private" },
      }),
    ).toEqual(order);
    expect(() =>
      parseCheckoutPayload({ data: { ...order, requested_amount_cents: 1.5 } }),
    ).toThrow();
    expect(checkoutMoney(1)).toBe("¥0.01");
    expect(checkoutMoney(100000001)).toBe("¥1,000,000.01");
  });
  it("parses both forms of Retry-After without unbounded retry loops", () => {
    expect(retryDelay("5", 1000)).toBe(5000);
    expect(retryDelay(new Date(epoch + 10000).toUTCString(), 1000, epoch)).toBe(
      10000,
    );
    expect(retryDelay("invalid", 2000)).toBe(2000);
    expect(retryDelay("99999", 1000)).toBe(60000);
  });
});
function prepareDownload() {
  const callbacks: BlobCallback[] = [];
  const context = {
    imageSmoothingEnabled: true,
    fillStyle: "",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => {
      callbacks.push(callback);
    },
  );
  const create = vi.fn(() => "blob:" + location.origin + "/synthetic"),
    revoke = vi.fn();
  const ActualURL = globalThis.URL;
  vi.stubGlobal(
    "URL",
    class extends ActualURL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const view = render(createElement(CheckoutApp, { initial: initial() }));
  const image = screen.getByAltText("用于支付此订单的支付宝付款二维码");
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalWidth: { configurable: true, value: 256 },
  });
  return { ...view, callbacks, context, create, revoke, click, image };
}
describe("checkout shadcn view and PNG lifecycle", () => {
  it("exports the displayed same-origin QR as a white-backed PNG without another request", () => {
    const view = prepareDownload();
    fireEvent.click(screen.getByRole("button", { name: "保存二维码" }));
    expect(view.context.fillStyle).toBe("#ffffff");
    expect(view.context.fillRect).toHaveBeenCalledWith(0, 0, 1024, 1024);
    expect(view.context.imageSmoothingEnabled).toBe(false);
    expect(view.context.drawImage).toHaveBeenCalledWith(
      view.image,
      0,
      0,
      1024,
      1024,
    );
    act(() => view.callbacks[0]!(new Blob(["png"], { type: "image/png" })));
    expect(view.create).toHaveBeenCalledOnce();
    expect(view.click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["hidden", "pagehide", "expired", "unmount"])(
    "discards a late PNG result after %s",
    async (cause) => {
      const view = prepareDownload();
      fireEvent.click(screen.getByRole("button", { name: "保存二维码" }));
      if (cause === "hidden") {
        hidden = true;
        act(() => document.dispatchEvent(new Event("visibilitychange")));
      } else if (cause === "pagehide")
        act(() => window.dispatchEvent(new Event("pagehide")));
      else if (cause === "unmount") view.unmount();
      else {
        vi.stubGlobal(
          "fetch",
          vi.fn(() => new Promise<Response>(() => {})),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(61000);
        });
        expect(
          screen.queryByAltText("用于支付此订单的支付宝付款二维码"),
        ).not.toBeInTheDocument();
      }
      act(() => view.callbacks[0]!(new Blob(["png"], { type: "image/png" })));
      expect(view.create).not.toHaveBeenCalled();
      expect(view.click).not.toHaveBeenCalled();
    },
  );
  it("keeps a failed QR visible across polling until the user retries its image", async () => {
    const view = prepareDownload();
    fireEvent.error(view.image);
    expect(screen.getByText("二维码加载失败")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByText("二维码加载失败")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新加载二维码" }));
    expect(view.image.getAttribute("src")).toContain("retry=");
  });
  it("lets the user retry a PNG conversion without hiding the QR", () => {
    const view = prepareDownload();
    fireEvent.click(screen.getByRole("button", { name: "保存二维码" }));
    act(() => view.callbacks[0]!(null));
    expect(screen.getByText(/无法生成 PNG/)).toBeVisible();
    expect(view.image).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "保存二维码" }));
    expect(view.callbacks).toHaveLength(2);
  });
  it("prevents duplicate conversions and revokes an existing object URL when hidden", () => {
    const view = prepareDownload();
    const button = screen.getByRole("button", { name: "保存二维码" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(view.callbacks).toHaveLength(1);
    act(() => view.callbacks[0]!(new Blob(["png"], { type: "image/png" })));
    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.revoke).toHaveBeenCalledExactlyOnceWith(
      "blob:" + location.origin + "/synthetic",
    );
  });
  it("updates main and expanded amounts from the same public response", async () => {
    prepareDownload();
    fireEvent.click(screen.getByRole("button", { name: "放大二维码" }));
    expect(
      screen.getByRole("dialog", { name: "支付宝付款二维码" }),
    ).toHaveTextContent("¥10.01");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ...initial().checkout!,
          payment_instructions: { payable_amount_cents: 1002, currency: "CNY" },
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("¥10.02");
    expect(document.querySelector("[data-payable-amount]")).toHaveTextContent(
      "¥10.02",
    );
  });
});
