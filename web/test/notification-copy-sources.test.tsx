import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { queryClient, type AdminOrderDetail, type ReconciliationOrder, type WebhookDeliverySummary } from "../src/api/client";
import Notifications, { NotificationDetail } from "../src/pages/Notifications";
import { DataTable } from "../src/components/data-table";
import { OrderFacts } from "../src/components/detail/DetailPrimitives";
import { DeliveryCard, OrderNotifications } from "../src/components/detail/NotificationEvidence";
import { WorkspaceProvider } from "../src/workspace";
import { delivery, failedAttempt, paidOrder, paymentMatch } from "./detail-fixtures";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";
import { recordAction } from "./menu-helper";

function mount(children: ReactNode, path = "/", scoped = false) {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}>
    {scoped ? <WorkspaceProvider>{children}</WorkspaceProvider> : children}
  </MemoryRouter></QueryClientProvider>);
}

describe("order and notification copy follows its actual source", () => {
  beforeEach(() => localStorage.clear());

  it.each([false, true])("shows retry scheduling and its associated order once while honoring explicit mobile field choices (hidden: %s)", async hidden => {
    mobileMedia(360);
    const overrides = hidden ? { order: false, attempt_count: false, next_attempt_at: false } : {};
    localStorage.setItem("perpay.table-columns.v2.notifications", JSON.stringify(overrides));
    const summary: WebhookDeliverySummary = {
      ...delivery.delivery, event: delivery.event, target: delivery.target,
      order_summary: {
        order_id: paidOrder.order_id, api_client_id: paidOrder.api_client_id, site_name: paidOrder.site_name ?? null,
        product_name: paidOrder.product_name, merchant_order_no: paidOrder.merchant_order_no,
        requested_amount_cents: paidOrder.requested_amount_cents, payable_amount_cents: paidOrder.payable_amount_cents,
        received_amount_cents: paidOrder.received_amount_cents ?? null, payment_confirmed_at: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [summary], page: { next_cursor: null } })));
    mount(<Notifications />, "/notifications");
    const row = await screen.findByRole("listitem");
    if (hidden) {
      expect(within(row).queryByText("尝试次数")).not.toBeInTheDocument();
      expect(within(row).queryByText("下次尝试")).not.toBeInTheDocument();
      expect(within(row).queryByText(paidOrder.merchant_order_no)).not.toBeInTheDocument();
      expect(within(row).queryByRole("link", { name: paidOrder.merchant_order_no })).not.toBeInTheDocument();
      expect(within(row).queryByTitle("2026/09/06 08:02（北京时间）")).not.toBeInTheDocument();
    } else {
      const attempts = within(row).getByText("尝试次数").closest(".business-summary-field")!;
      expect(attempts).toHaveTextContent("尝试次数1");
      expect(within(row).getAllByTitle("2026/09/06 08:02（北京时间）")).toHaveLength(1);
      expect(within(row).getAllByText(paidOrder.merchant_order_no)).toHaveLength(1);
      expect(within(row).getByRole("link", { name: paidOrder.merchant_order_no })).toHaveAttribute("href", "/orders/" + paidOrder.order_id);
    }
    expect(within(row).getByText("创建时间")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.notifications")!)).toEqual(overrides);
  });

  it.each([
    [1440, ""], [390, ""], [1440, "/sites/site_copy"], [390, "/sites/site_copy"],
  ] as const)("keeps notification type, merchant identity and payable amount visible at %i in %s", async (width, scope) => {
    mobileMedia(width);
    const product = "同一商品的不同收款通知";
    const merchant = "BUSINESS-ORDER-20261021-" + "0123456789".repeat(10);
    const summaries: WebhookDeliverySummary[] = ["PAYMENT_CONFIRMED", "PAYMENT_DISPUTED"].map((eventType, index) => ({
      ...delivery.delivery,
      delivery_id: index ? "99999999-9999-4999-8999-999999999999" : delivery.delivery.delivery_id,
      event: { event_type: eventType, order_id: paidOrder.order_id },
      target: { format: "NATIVE_JSON_V1", url_fingerprint: "a".repeat(64) },
      order_summary: {
        order_id: paidOrder.order_id, api_client_id: "site_copy", site_name: "业务网站名称",
        product_name: product, merchant_order_no: merchant, requested_amount_cents: 100,
        payable_amount_cents: 101, received_amount_cents: 345, payment_confirmed_at: null,
      },
    }));
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/api/admin/v1/sites/site_copy")
        return json({ data: { client_id: "site_copy", configuration: { name: "业务网站名称" } } });
      return json({ data: summaries, page: { next_cursor: null } });
    }));
    mount(<Notifications />, scope + "/notifications", true);
    expect(await screen.findByText("通知类型：收款已确认")).toBeVisible();
    expect(screen.getByText("通知类型：收款有争议")).toBeVisible();
    const rows = screen.getAllByRole(width < 640 ? "listitem" : "row")
      .filter(row => within(row).queryByRole("link", { name: product }));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).queryByText("商户订单号（业务网站）：") ??
        within(width < 640 ? row : screen.getByRole("table")).getByText("关联商户订单号（业务网站）")).toBeVisible();
      expect(within(row).getAllByText(merchant).every(value => value.textContent === merchant)).toBe(true);
      expect(within(row).getByText("应付 ¥1.01")).toBeVisible();
      expect(within(row).queryByText(/¥3\.45/)).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: product })[0]).toHaveAttribute("href", scope + "/notifications/" + delivery.delivery.delivery_id);
    if (width >= 1200) expect(screen.getByRole("columnheader", { name: "关联商户订单号（业务网站）" })).toBeVisible();
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("labels the website merchant number in an order list without substituting its internal ID", () => {
    mobileMedia(390);
    mount(<DataTable data={[paidOrder]} />);
    expect(screen.getByText("商户订单号（业务网站）：")).toBeVisible();
    expect(screen.getByText(paidOrder.merchant_order_no)).toHaveAttribute("title", paidOrder.merchant_order_no);
    expect(screen.queryByText(paidOrder.order_id)).not.toBeInTheDocument();
  });

  it.each(["default", "comfortable"] as const)("preserves complete merchant identity and copy in %s order facts", async density => {
    const merchant = "BUSINESS-" + "0123456789".repeat(12);
    mount(<OrderFacts order={{ ...paidOrder, merchant_order_no: merchant }} density={density} layout="flow" />);
    expect(screen.getByRole("link", { name: paidOrder.product_name })).toHaveAttribute("href", "/orders/" + paidOrder.order_id);
    if (density === "comfortable") {
      expect(screen.getByText("商户订单号（业务网站）", { selector: "dt" })).toBeVisible();
      await userEvent.setup().click(screen.getByRole("button", { name: "复制商户订单号" }));
      expect(await navigator.clipboard.readText()).toBe(merchant);
    } else {
      expect(screen.getByText(/商户订单号（业务网站）：/)).toHaveTextContent(merchant);
      expect(screen.getByText(/客户端 ID（PerPay）：/)).toHaveTextContent(paidOrder.api_client_id);
    }
  });

  it.each(["default", "comfortable"] as const)("keeps automatic, manual and absent bases distinct in %s summaries", density => {
    function facts(shape: "admin" | "reconciliation", basis: "INFERRED" | "MANUAL" | "NONE") {
      const value: AdminOrderDetail | ReconciliationOrder = shape === "admin"
        ? { ...paidOrder, payment: { ...paidOrder.payment, basis } }
        : { ...paymentMatch.order!, payment_basis: basis };
      return <QueryClientProvider client={queryClient}><MemoryRouter><OrderFacts order={value} density={density} /></MemoryRouter></QueryClientProvider>;
    }
    const view = render(facts("admin", "INFERRED"));
    for (const shape of ["admin", "reconciliation"] as const) {
      view.rerender(facts(shape, "INFERRED"));
      expect(screen.getByText("PerPay 按金额和付款时间推断")).toBeVisible();
      expect(screen.queryByText("管理员人工关联")).not.toBeInTheDocument();
      view.rerender(facts(shape, "MANUAL"));
      expect(screen.getByText("管理员人工关联")).toBeVisible();
      expect(screen.queryByText("PerPay 按金额和付款时间推断")).not.toBeInTheDocument();
      view.rerender(facts(shape, "NONE"));
      expect(screen.queryByText("管理员人工关联")).not.toBeInTheDocument();
      expect(screen.queryByText("PerPay 按金额和付款时间推断")).not.toBeInTheDocument();
    }
  });

  it.each([true, false])("identifies the acknowledgement time as a local notification receipt (latest=%s)", latest => {
    const acknowledged = {
      ...delivery, is_latest: latest,
      delivery: { ...delivery.delivery, status: "ACKNOWLEDGED" as const,
        acknowledged_at: "2026-10-21T10:10:00.000Z", last_error_code: null, next_attempt_at: null },
    };
    mount(<><section aria-label="订单摘要"><OrderFacts order={paidOrder} density="comfortable" /></section><DeliveryCard detail={acknowledged} density="comfortable" /></>);
    expect(within(screen.getByRole("region", { name: "订单摘要" })).getByText("收款已确认", { exact: true })).toBeVisible();
    expect(screen.getByText("通知已确认", { exact: true })).toBeVisible();
    expect(screen.getByText("通知确认时间（PerPay 记录）", { selector: "dt" }).nextElementSibling).toHaveTextContent("2026/10/21 18:10");
    expect(screen.getByText(/对方已返回有效确认回执/)).toBeVisible();
    expect(screen.queryByText("业务确认时间")).not.toBeInTheDocument();
  });

  it.each([null, "https://old-order.example/notify"])("bases the notification empty state on this order's saved URL: %s", async notifyUrl => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/api/admin/v1/sites/site_copy")
        return json({ data: { client_id: "site_copy", configuration: { name: "当前网站", notification_origin: "https://current-site.example" } } });
      return json({ data: [], page: { next_cursor: null } });
    }));
    mount(<OrderNotifications orderId={paidOrder.order_id} notifyUrl={notifyUrl} />, "/sites/site_copy/orders/" + paidOrder.order_id, true);
    expect(await screen.findByText(notifyUrl ? "此订单已设置通知地址，暂无发送记录" : "此订单未设置通知地址")).toBeVisible();
  });

  it("keeps unknown error codes in technical evidence while ordinary text remains readable", async () => {
    const code = "provider_future_attempt_42";
    const unknown = { ...delivery, delivery: { ...delivery.delivery, last_error_code: code }, attempts: [{ ...failedAttempt, error_code: code }] };
    mount(<DeliveryCard detail={unknown} density="comfortable" />);
    expect(screen.getByText(/HTTP 200 · 通知发送结果需核查/)).toBeVisible();
    expect(screen.getByText(/确认处理结果后再操作/)).toBeVisible();
    expect(screen.queryByText(new RegExp(code))).not.toBeInTheDocument();
    await userEvent.setup().click(await recordAction("技术详情", "通知记录操作"));
    const technical = await screen.findByRole("dialog", { name: "技术详情" });
    expect(within(technical).getByRole("group", { name: "技术详情" })).toHaveTextContent(code);
  });

  it("distinguishes an in-progress history read from a successful empty history", async () => {
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/attempts")) return pending;
      if (new URL(request.url).pathname.includes("/orders/")) return json({ data: paidOrder });
      return json({ data: { ...delivery, delivery: { ...delivery.delivery, attempt_count: 0 } } });
    }));
    mount(<Routes><Route path="/notifications/:deliveryId" element={<NotificationDetail />} /></Routes>, "/notifications/" + delivery.delivery.delivery_id);
    const history = await screen.findByRole("group", { name: "投递历史" });
    expect(within(history).getByText("正在读取发送记录…")).toBeVisible();
    expect(within(history).queryByText("暂无尝试明细")).not.toBeInTheDocument();
    expect(within(history).queryByText(/读取失败/)).not.toBeInTheDocument();
    await act(async () => { complete(json({ data: [] })); });
    expect(await within(history).findByRole("table", { name: "投递尝试（0）" })).toBeVisible();
    expect(within(history).getByText("暂无尝试明细")).toBeVisible();
    expect(within(history).queryByText("正在读取发送记录…")).not.toBeInTheDocument();
  });
});
