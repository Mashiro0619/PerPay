import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { queryClient, type OrderWebhookDeliveryDetail, type WebhookDeliverySummary } from "../src/api/client";
import Notifications from "../src/pages/Notifications";
import NotificationDetail from "../src/pages/NotificationDetail";
import { DataTable } from "../src/components/data-table";
import { OrderNotificationsSection, useOrderNotifications } from "../src/components/detail/OrderNotificationRecords";
import { WorkspaceProvider } from "../src/workspace";
import { delivery, deliveryId, failedAttempt, paidOrder } from "./detail-fixtures";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";
import { recordAction } from "./menu-helper";

function OrderNotifications({ orderId, notifyUrl }: { orderId: string; notifyUrl: string | null }) {
  return <OrderNotificationsSection notifications={useOrderNotifications(orderId)} notifyUrl={notifyUrl} />;
}

function mount(children: ReactNode, path = "/", scoped = false) {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}>
    {scoped ? <WorkspaceProvider>{children}</WorkspaceProvider> : children}
  </MemoryRouter></QueryClientProvider>);
}

/** Opens the notification detail of one delivery, served together with its attempts and its order. */
function mountDetail(detail: OrderWebhookDeliveryDetail) {
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/attempts")) return json({ data: detail.attempts });
    if (path.includes("/orders/")) return json({ data: paidOrder });
    return json({ data: detail });
  }));
  return mount(<Routes><Route path="/notifications/:deliveryId" element={<NotificationDetail />} /></Routes>, "/notifications/" + deliveryId);
}

describe("order and notification copy follows its actual source", () => {
  beforeEach(() => localStorage.clear());

  it.each([false, true])("keeps mobile order identity and retry scheduling independent of desktop hidden columns (hidden: %s)", async hidden => {
    mobileMedia(360);
    const overrides = hidden ? { order: false, attempt_count: false, next_attempt_at: false } : {};
    localStorage.setItem("perpay.table-columns.v2.notifications", JSON.stringify(overrides));
    const summary: WebhookDeliverySummary = {
      ...delivery.delivery, is_latest: true, event: delivery.event, target: delivery.target,
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
    const attempts = within(row).getByText("尝试次数").closest(".business-summary-field")!;
    expect(attempts).toHaveTextContent("尝试次数1");
    expect(within(row).getByText("等待重试")).toBeVisible();
    expect(within(row).getAllByTitle("2026/09/06 08:02（北京时间）")).toHaveLength(1);
    expect(within(row).getByText(paidOrder.merchant_order_no)).toBeVisible();
    expect(within(row).getByText("创建时间")).toBeVisible();
    expect(within(row).getByText("应付金额")).toBeVisible();
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.notifications")!)).toEqual(overrides);
  });

  it.each([
    [1440, ""], [390, ""], [1440, "/sites/site_copy"], [390, "/sites/site_copy"],
  ] as const)("keeps notification type, merchant identity and payable amount visible at %i in %s", async (width, scope) => {
    mobileMedia(width);
    localStorage.setItem("perpay.table-columns.v2.notifications", JSON.stringify({ order: true, event_type: true, payable_amount_cents: true }));
    const product = "同一商品的不同收款通知";
    const merchant = "BUSINESS-ORDER-20261021-" + "0123456789".repeat(10);
    const summaries: WebhookDeliverySummary[] = ["PAYMENT_CONFIRMED", "PAYMENT_DISPUTED"].map((eventType, index) => ({
      ...delivery.delivery,
      is_latest: true,
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
    await screen.findAllByRole("link", { name: product });
    if (width >= 640) {
      expect(screen.getByText("收款已确认")).toBeVisible();
      expect(screen.getByText("收款有争议")).toBeVisible();
    }
    const rows = screen.getAllByRole(width < 640 ? "listitem" : "row")
      .filter(row => within(row).queryByRole("link", { name: product }));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      if (width >= 640) {
        expect(within(row).getByText(merchant)).toBeVisible();
        expect(within(row).getByText("¥1.01")).toBeVisible();
      } else {
        expect(within(row).getByText(merchant)).toBeVisible();
        expect(within(row).getByText("¥1.01")).toBeVisible();
        expect(within(row).getByText("等待重试")).toBeVisible();
      }
      expect(within(row).queryByText(/¥3\.45/)).not.toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: product })[0]).toHaveAttribute("href", scope + "/notifications/" + delivery.delivery.delivery_id);
    if (width >= 1200) expect(screen.getByRole("columnheader", { name: "商户订单号" })).toBeVisible();
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("labels the website merchant number in an order list without substituting its internal ID", () => {
    mobileMedia(390);
    mount(<DataTable data={[paidOrder]} />);
    expect(screen.getByText(/^商户订单号(?:（业务网站）)?[：:]?$/)).toBeInTheDocument();
    expect(screen.getByText(paidOrder.merchant_order_no)).toBeVisible();
    expect(screen.getByRole("link", { name: paidOrder.product_name })).toHaveAttribute("href", "/orders/" + paidOrder.order_id);
    expect(screen.queryByText(paidOrder.order_id)).not.toBeInTheDocument();
  });

  it.each([true, false])("identifies the acknowledgement time as a local notification receipt (latest=%s)", async latest => {
    mountDetail({
      ...delivery, is_latest: latest,
      delivery: { ...delivery.delivery, status: "ACKNOWLEDGED" as const,
        acknowledged_at: "2026-10-21T10:10:00.000Z", last_error_code: null, next_attempt_at: null },
    });
    // The order's payment status and the notification's own status are told apart by where they stand.
    expect(await within(await screen.findByRole("region", { name: "关联订单" })).findByText("收款已确认", { exact: true })).toBeVisible();
    const summary = screen.getByRole("group", { name: "通知状态" });
    expect(within(summary).getByText("通知已确认", { exact: true })).toBeVisible();
    expect(within(summary).getByText(latest ? "对方已返回有效确认回执" : "历史发送 · 对方已返回确认回执")).toBeVisible();
    // The label stays short; whose clock the time comes from is said under the value.
    const acknowledged = screen.getByText("通知确认时间", { selector: "dt" }).nextElementSibling!;
    expect(acknowledged).toHaveTextContent("2026/10/21 18:10:00");
    expect(within(acknowledged as HTMLElement).getByText("PerPay 收到成功回执的时间")).toBeVisible();
    expect(screen.queryByText("业务确认时间")).not.toBeInTheDocument();
  });

  it.each([null, "https://old-order.example/notify"])("bases the notification empty state on this order's saved URL: %s", async notifyUrl => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/api/admin/v1/sites/site_copy")
        return json({ data: { client_id: "site_copy", configuration: { name: "当前网站", notification_origin: "https://current-site.example" } } });
      return json({ data: [], page: { next_cursor: null } });
    }));
    mount(<OrderNotifications orderId={paidOrder.order_id} notifyUrl={notifyUrl} />, "/sites/site_copy/orders/" + paidOrder.order_id, true);
    expect(await screen.findByText(notifyUrl ? "此订单已设置通知地址，暂无通知记录" : "此订单未设置通知地址")).toBeVisible();
    // An order without deliveries keeps the section to its title and this one line.
    expect(screen.getByRole("region", { name: "通知" })).toHaveAttribute("data-section-empty", "true");
  });

  it.each([["PENDING", "计划发送", "下次重试"], ["RETRY_WAIT", "下次重试", "计划发送"]] as const)("names the next attempt of a %s delivery %s", async (status, name, other) => {
    const attempted = status === "RETRY_WAIT";
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ ...delivery, attempts: attempted ? delivery.attempts : [],
      delivery: { ...delivery.delivery, status, attempt_count: attempted ? 1 : 0, last_error_code: attempted ? delivery.delivery.last_error_code : null } }], page: { next_cursor: null } })));
    mount(<OrderNotifications orderId={paidOrder.order_id} notifyUrl="https://business.example.invalid/notify" />, "/orders/" + paidOrder.order_id);
    // A delivery that was never attempted has nothing to retry yet.
    expect((await screen.findByText(name, { selector: "dt" })).nextElementSibling).toHaveTextContent("2026/09/06 08:02:00");
    expect(screen.queryByText(other, { selector: "dt" })).not.toBeInTheDocument();
  });

  it("explains a delivery ended by a revoked payment confirmation instead of offering a resend the server would refuse", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ ...delivery, redelivery_blocked_reason: "payment_confirmation_revoked",
      delivery: { ...delivery.delivery, status: "DEAD_LETTER", next_attempt_at: null } }], page: { next_cursor: null } })));
    mount(<OrderNotifications orderId={paidOrder.order_id} notifyUrl="https://business.example.invalid/notify" />, "/orders/" + paidOrder.order_id);
    expect(await screen.findByText("已终止", { exact: true })).toBeVisible();
    expect(screen.getByText("原付款确认已撤销，已停止发送")).toBeVisible();
    expect(screen.getByText(/重新确认收款后，系统会为新的确认事件生成通知/)).toBeVisible();
    expect(screen.getByRole("link", { name: "查看详情" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "重新发送" })).not.toBeInTheDocument();
  });

  it("keeps unknown error codes in technical evidence while ordinary text remains readable", async () => {
    const code = "provider_future_attempt_42";
    mountDetail({ ...delivery, delivery: { ...delivery.delivery, last_error_code: code }, attempts: [{ ...failedAttempt, error_code: code }] });
    expect(await screen.findByText(/HTTP 200 · 通知发送结果需核查/)).toBeVisible();
    expect(screen.getByText(/确认处理结果后再操作/)).toBeVisible();
    expect(screen.queryByText(new RegExp(code))).not.toBeInTheDocument();
    await userEvent.setup().click(await recordAction("通知技术信息", "通知记录操作"));
    const technical = await screen.findByRole("dialog", { name: "通知技术信息" });
    expect(within(technical).getByRole("region", { name: "通知技术信息" })).toHaveTextContent(code);
  });

  it("distinguishes an in-progress attempts read from a delivery without attempts", async () => {
    let complete!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/attempts")) return pending;
      if (new URL(request.url).pathname.includes("/orders/")) return json({ data: paidOrder });
      return json({ data: { ...delivery, delivery: { ...delivery.delivery, attempt_count: 0 } } });
    }));
    mount(<Routes><Route path="/notifications/:deliveryId" element={<NotificationDetail />} /></Routes>, "/notifications/" + delivery.delivery.delivery_id);
    const attempts = await screen.findByRole("region", { name: "发送记录" });
    expect(attempts.querySelector('[aria-busy="true"]')).toHaveTextContent("正在读取发送记录…");
    expect(within(attempts).queryByText("尚未开始发送")).not.toBeInTheDocument();
    expect(within(attempts).queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { complete(json({ data: [] })); });
    expect(await within(attempts).findByText("尚未开始发送")).toBeVisible();
    expect(attempts.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
