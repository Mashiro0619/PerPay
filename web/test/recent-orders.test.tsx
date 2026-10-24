import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { queryClient, type AdminOrderSummary } from "../src/api/client";
import { RecentOrders } from "../src/components/recent-orders";
import { WorkspaceProvider } from "../src/workspace";
import { order, json } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const recent: AdminOrderSummary = {
  ...order,
  api_client_id: "site_a",
  site_name: "订阅网站",
  product_name: "专业版订阅",
  merchant_order_no: "SUB-20261011-001",
  payable_amount_cents: 19901,
  received_amount_cents: 19901,
  payment: { ...order.payment, status: "CONFIRMED" },
  created_at: "2026-10-11T02:30:00.000Z",
  payment_confirmed_at: "2026-10-11T02:32:00.000Z",
  notification_summary: { status: "RETRY_WAIT", total_events: 3, acknowledged_events: 1 },
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}</output>;
}

function mount(orders: readonly AdminOrderSummary[] = [recent], path = "/", scoped = false) {
  const content = <><RecentOrders orders={orders} /><LocationProbe /></>;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {scoped ? <WorkspaceProvider>{content}</WorkspaceProvider> : content}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mobileMedia(1280);
});
afterEach(() => vi.restoreAllMocks());

describe("overview order progress", () => {
  it("shows order identity, one matching amount, payment and independent notification status without reading details", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount();
    const table = screen.getByRole("table", { name: "最近订单" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "订单 / 商品", "金额", "收款状态", "通知状态", "时间",
    ]);
    for (const [columnId, alignment] of [
      ["identity", "left"],
      ["amounts", "right"],
      ["payment", "center"],
      ["notification", "center"],
      ["created_at", "left"],
    ] as const) {
      expect(table.querySelector(`thead [data-column-id="${columnId}"]`)).toHaveAttribute("data-column-align", alignment);
      expect(table.querySelector(`tbody [data-column-id="${columnId}"]`)).toHaveAttribute("data-column-align", alignment);
    }
    expect(screen.getByRole("link", { name: "专业版订阅" })).toHaveAttribute("href", "/orders/" + order.order_id);
    expect(screen.getByText(recent.merchant_order_no)).toHaveAttribute("title", recent.merchant_order_no);
    expect(screen.getByLabelText("应付金额 ¥199.01")).toBeVisible();
    expect(screen.getAllByLabelText(/^(应付|实收)金额 /)).toHaveLength(1);
    expect(screen.getByText("应付", { exact: true })).toBeVisible();
    expect(screen.queryByText("实收", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("网站订单号")).toBeVisible();
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(screen.getByText("等待重试")).toHaveAttribute("data-variant", "warning");
    expect(screen.queryByText(/^已确认 \d+\/\d+ 项$/)).not.toBeInTheDocument();
    expect(screen.getByTitle("2026/10/11 10:30（北京时间）")).toBeVisible();
    expect(screen.getByTitle("2026/10/11 10:32（北京时间）")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses its own columns even when full and former overview tables hid fields", () => {
    localStorage.setItem("perpay.table-columns.v2.orders", JSON.stringify({ status: false, created_at: false }));
    localStorage.setItem("perpay.table-columns.v2.recent-orders", JSON.stringify({ status: false, created_at: false }));
    mount();
    expect(screen.getByRole("table").closest("[data-business-table]")).toHaveAttribute("data-business-table", "overview-recent-orders");
    expect(screen.getByRole("columnheader", { name: "时间" })).toBeVisible();
    expect(screen.getByText("收款已确认")).toBeVisible();
  });

  it("honors its own explicit hidden time field on mobile while retaining payment and notification progress", () => {
    mobileMedia(360);
    localStorage.setItem("perpay.table-columns.v2.overview-recent-orders", JSON.stringify({ created_at: false }));
    const view = mount();
    expect(view.container.querySelector("time")).toBeNull();
    expect(screen.getByRole("group", { name: "收款状态" })).toHaveTextContent("收款已确认");
    expect(screen.getByRole("group", { name: "通知状态" })).toHaveTextContent("等待重试");
    expect(screen.getByRole("link", { name: recent.product_name })).toBeVisible();
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.overview-recent-orders")!)).toEqual({ created_at: false });
  });

  it("groups statuses below 64rem, moves times below 48rem and retains the complete summary below 40rem", () => {
    let width = 767;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("overview-orders") || this.getAttribute("data-business-table") === "overview-recent-orders"
        ? DOMRect.fromRect({ width, height: 300 })
        : original.call(this);
    });
    const view = mount();
    const resize = (next: number) => {
      width = next;
      act(() => window.dispatchEvent(new Event("resize")));
    };
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "收款 / 通知" })).toBeVisible();
    expect(screen.getByRole("group", { name: "收款状态" })).toHaveTextContent("收款已确认");
    expect(screen.getByRole("group", { name: "通知状态" })).toHaveTextContent("等待重试");
    expect(screen.getByRole("table").querySelector('tbody [data-column-id="identity"]')).toContainElement(screen.getByText("创建"));
    expect(view.container.querySelectorAll("time")).toHaveLength(2);

    resize(768);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(screen.getByRole("table").querySelector('tbody [data-column-id="created_at"]')).toContainElement(screen.getByText("PerPay 确认"));
    expect(view.container.querySelectorAll("time")).toHaveLength(2);

    resize(1024);
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("columnheader", { name: "收款状态" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "通知状态" })).toBeVisible();
    resize(1023);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    resize(640);
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    resize(639);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "最近订单" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: recent.product_name })).toHaveLength(1);
    expect(screen.getByLabelText("应付金额 ¥199.01")).toBeVisible();
    expect(screen.getByRole("group", { name: "收款状态" })).toHaveTextContent("收款已确认");
    expect(screen.getByRole("group", { name: "通知状态" })).toHaveTextContent("等待重试");
    expect(screen.queryByText("收款状态", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("通知状态", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("时间", { exact: true })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/^(应付|实收)金额 /)).toHaveLength(1);
    expect(screen.getByText("应付", { exact: true })).toBeVisible();
    expect(screen.queryByText("实收", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(screen.getByText("等待重试")).toBeVisible();
    expect(view.container.querySelectorAll("time")).toHaveLength(2);
  });

  it.each([
    ["NOT_CONFIGURED", "此订单未设置通知地址", 0, 0, "secondary"],
    ["NO_EVENT", "暂无通知事件", 0, 0, "secondary"],
    ["UNMATERIALIZED", "等待生成投递", 1, 0, "warning"],
    ["PENDING", "等待投递", 1, 0, "secondary"],
    ["LEASED", "投递中", 1, 0, "warning"],
    ["RETRY_WAIT", "等待重试", 2, 1, "warning"],
    ["DEAD_LETTER", "已停止重试", 2, 1, "destructive"],
    ["ACKNOWLEDGED", "通知已确认", 2, 2, "success"],
  ] as const)("renders %s without confusing delivery with payment", (status, text, total, acknowledged, variant) => {
    mount([{ ...recent, notification_summary: { status, total_events: total, acknowledged_events: acknowledged } }]);
    expect(screen.getByText(text)).toHaveAttribute("data-variant", variant);
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(screen.queryByText(/^已确认 \d+\/\d+ 项$/)).not.toBeInTheDocument();
  });

  it.each([[3, 1], [0, 0]])("does not call an incomplete acknowledged aggregate successful (%i/%i)", (total, acknowledged) => {
    mount([{ ...recent, notification_summary: { status: "ACKNOWLEDGED", total_events: total, acknowledged_events: acknowledged } }]);
    expect(screen.queryByText("通知已确认")).not.toBeInTheDocument();
    expect(screen.getByText("尚未全部送达")).toHaveAttribute("data-variant", "warning");
    expect(screen.queryByText(/^已确认 \d+\/\d+ 项$/)).not.toBeInTheDocument();
  });

  it("keeps a later unmaterialized event pending despite earlier acknowledgements", () => {
    mount([{ ...recent, notification_summary: { status: "UNMATERIALIZED", total_events: 2, acknowledged_events: 1 } }]);
    expect(screen.getByText("等待生成投递")).toHaveAttribute("data-variant", "warning");
    expect(screen.queryByText(/^已确认 \d+\/\d+ 项$/)).not.toBeInTheDocument();
    expect(screen.queryByText("尚无投递记录")).not.toBeInTheDocument();
    expect(screen.queryByText("通知已确认")).not.toBeInTheDocument();
  });

  it.each([
    [1280, "null"],
    [390, "omitted"],
  ] as const)("keeps absent delivery data unknown and omits a missing receipt at %i px (%s)", (width, receipt) => {
    mobileMedia(width);
    const withoutReceipt: AdminOrderSummary = { ...order, checkout: { ...order.checkout, status: "EXPIRED" } };
    if (receipt === "omitted") Reflect.deleteProperty(withoutReceipt, "received_amount_cents");
    mount([withoutReceipt]);
    expect(screen.getByText("通知状态未知")).toBeVisible();
    expect(screen.getByText("待付款")).toBeVisible();
    expect(screen.queryByText(/收银台/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("应付金额 ¥1.01")).toBeVisible();
    expect(screen.getAllByLabelText(/^(应付|实收)金额 /)).toHaveLength(1);
    expect(screen.queryByLabelText(/^实收金额 /)).not.toBeInTheDocument();
    expect(screen.getByText("应付", { exact: true })).toBeVisible();
    expect(screen.queryByText("实收", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  it.each([
    [0, "¥0.00"],
    [19900, "¥199.00"],
  ] as const)("shows a real differing receipt of %i cents alongside the payable amount", (received, formatted) => {
    mount([{ ...recent, received_amount_cents: received }]);
    expect(screen.getByText("应付")).toBeVisible();
    expect(screen.getByText("实收")).toBeVisible();
    expect(screen.getByLabelText("应付金额 ¥199.01")).toBeVisible();
    expect(screen.getByLabelText("实收金额 " + formatted)).toBeVisible();
    expect(screen.getAllByLabelText(/^(应付|实收)金额 /)).toHaveLength(2);
    expect(screen.queryByLabelText("实收金额 —")).not.toBeInTheDocument();
    expect(screen.getByText("收款已确认")).toBeVisible();
    expect(screen.getByTitle("2026/10/11 10:32（北京时间）")).toBeVisible();
  });

  it("keeps refund declarations and a disputed order's historical confirmation separate from payment state", () => {
    mount([{
      ...recent,
      payment: { ...recent.payment, status: "DISPUTED" },
      refund_mark: { ...recent.refund_mark, marked: true },
    }]);
    expect(screen.getByText("收款有争议")).toBeVisible();
    expect(screen.getByText("已标记退款")).toBeVisible();
    expect(screen.getByTitle("2026/10/11 10:32（北京时间）")).toBeVisible();
  });

  it.each([false, true])("shows the website only in global views and keeps scoped order links (scoped: %s)", async (scoped) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { client_id: "site_a", configuration: { name: "订阅网站" } } })));
    mount([recent], scoped ? "/sites/site_a" : "/", true);
    if (scoped) {
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(screen.queryByRole("link", { name: "订阅网站 · site_a" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: "订阅网站 · site_a" })).toBeVisible();
    }
    expect(screen.getByRole("link", { name: recent.product_name })).toHaveAttribute("href", (scoped ? "/sites/site_a" : "") + "/orders/" + recent.order_id);
  });

  it("preserves long identity and both complete amounts for a mismatch in the summary", () => {
    mobileMedia(320);
    const product = "长名称商品与订阅服务".repeat(12);
    const reference = "MERCHANT-".repeat(20);
    mount([{ ...recent, product_name: product, merchant_order_no: reference, payable_amount_cents: 987654321012 }]);
    expect(screen.getByRole("link", { name: product })).toHaveAttribute("title", product);
    expect(screen.getByText(reference)).toHaveAttribute("title", reference);
    expect(screen.getByText("应付")).toBeVisible();
    expect(screen.getByText("实收")).toBeVisible();
    expect(screen.getByLabelText("应付金额 ¥9,876,543,210.12")).toHaveAttribute("data-wide", "true");
    expect(screen.getByLabelText("实收金额 ¥199.01")).toBeVisible();
    expect(screen.getAllByLabelText(/^(应付|实收)金额 /)).toHaveLength(2);
  });

  it("keeps the merchant number explicitly labelled even when it equals the product name", () => {
    mount([{ ...recent, product_name: "same", merchant_order_no: "same" }]);
    expect(screen.getByRole("link", { name: "same" })).toBeVisible();
    expect(screen.getByText("same", { selector: ".list-code" })).toHaveAttribute("title", "same");
    expect(screen.getByText("网站订单号")).toBeVisible();
  });

  it("keeps the primary row and website link independent and preserves keyboard access", async () => {
    mobileMedia(390);
    mount();
    const user = userEvent.setup();
    const primary = screen.getByRole("link", { name: recent.product_name });
    primary.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders/" + recent.order_id);
    await user.click(screen.getByRole("link", { name: "订阅网站 · site_a" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/sites/site_a");
  });

  it("keeps selection available instead of navigating when copying order metadata", () => {
    mobileMedia(390);
    mount();
    const reference = screen.getByText(recent.merchant_order_no);
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(reference);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      fireEvent.click(reference);
      expect(selection.toString()).toBe(recent.merchant_order_no);
      expect(screen.getByLabelText("当前地址")).toHaveTextContent(/^\/$/);
    } finally {
      selection.removeAllRanges();
    }
  });

  it("renders an honest empty state", () => {
    mount([]);
    expect(screen.getByText("暂无订单")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });
});
