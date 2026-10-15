import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "../src/api/client";
import { OverviewWorkItems } from "../src/components/overview-work-items";
import { WorkspaceProvider } from "../src/workspace";
import { json, order } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const related: NonNullable<AdminWorkItem["order_summary"]> = {
  order_id: order.order_id,
  api_client_id: "site_a",
  site_name: "订阅网站",
  product_name: "专业版订阅",
  merchant_order_no: "2026101110300010000001",
  requested_amount_cents: 19900,
  payable_amount_cents: 19901,
  received_amount_cents: 19901,
  payment_confirmed_at: "2026-10-11T02:32:00.000Z",
};
const exception: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "synthetic-account",
  order_id: order.order_id,
  order_summary: related,
  ledger_entry_id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-10-11T02:30:00.000Z",
  actionable_at: "2026-10-11T03:00:00.000Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
  status: "OPEN",
  exception_type: "AMOUNT_MISMATCH",
  candidate_id: null,
};
type NotificationWorkItem = Extract<AdminWorkItem, { type: "NOTIFICATION_FAILURE" }>;
function notification(overrides: Partial<NotificationWorkItem> = {}): NotificationWorkItem {
  return {
    ...exception,
    type: "NOTIFICATION_FAILURE",
    resource_id: "00000000-0000-4000-8000-000000000002",
    status: "RETRY_WAIT",
    event_type: "PAYMENT_CONFIRMED",
    attempt_count: 3,
    next_attempt_at: "2026-10-11T04:00:00.000Z",
    last_error_code: "TIMEOUT",
    dead_lettered_at: null,
    updated_at: "2026-10-11T03:00:00.000Z",
    ...overrides,
  };
}
const conflict: AdminWorkItem = {
  ...exception,
  type: "LEDGER_CONFLICT",
  resource_id: "00000000-0000-4000-8000-000000000003",
  status: "OPEN",
  conflict_type: "DUPLICATE_EXTERNAL_ID",
  external_event_id: "ALI-SHARED-CONFLICT-001",
  order_id: null,
  order_summary: null,
};

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前地址">{location.pathname}</output>;
}

function mount(items: readonly AdminWorkItem[] = [notification()], path = "/", scoped = false) {
  const content = <><OverviewWorkItems items={items} /><LocationProbe /></>;
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

describe("overview work item context", () => {
  it("distinguishes reminders with labeled merchant numbers and linked products without redundant actions", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    mount([
      notification(),
      notification({
        resource_id: "00000000-0000-4000-8000-000000000004",
        order_id: "00000000-0000-4000-8000-000000000005",
        order_summary: {
          ...related,
          order_id: "00000000-0000-4000-8000-000000000005",
          product_name: "团队版订阅",
          merchant_order_no: "2026101110350010000002",
          payable_amount_cents: 59901,
        },
      }),
    ]);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByRole("link", { name: "查看订单：专业版订阅" })).toBeVisible();
    expect(within(rows[0]!).getByText("2026101110300010000001")).toBeVisible();
    expect(within(rows[0]!).getByLabelText("应付金额 ¥199.01")).toBeVisible();
    expect(within(rows[1]!).getByRole("link", { name: "查看订单：团队版订阅" })).toBeVisible();
    expect(within(rows[1]!).getByText("2026101110350010000002")).toBeVisible();
    expect(within(rows[1]!).getByLabelText("应付金额 ¥599.01")).toBeVisible();
    for (const row of rows) {
      expect(within(row).getByText("商户订单号")).toBeVisible();
      expect(within(row).getByText("请求超时")).toBeVisible();
      expect(within(row).getByTitle("2026/10/11 12:00（北京时间）")).toBeVisible();
      expect(within(row).getByTitle("2026/10/11 11:00（北京时间）")).toBeVisible();
      expect(within(row).getByTitle("2026/10/11 12:00（北京时间）").parentElement).toHaveTextContent("下次重试");
    }
    expect(screen.queryByText("业务通知")).not.toBeInTheDocument();
    expect(screen.queryByText(/已尝试/)).not.toBeInTheDocument();
    expect(screen.queryByText("查看订单")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["PENDING", "等待投递", "secondary", true],
    ["LEASED", "投递中", "warning", false],
    ["RETRY_WAIT", "等待重试", "warning", true],
    ["DEAD_LETTER", "投递失败", "destructive", false],
  ] as const)("shows actual %s progress and only meaningful retry times", (status, text, tone, scheduled) => {
    mount([notification({ status })]);
    expect(screen.getByText(text)).toHaveAttribute("data-variant", tone);
    expect(screen.getByText("请求超时")).toBeVisible();
    expect(Boolean(screen.queryByTitle("2026/10/11 12:00（北京时间）"))).toBe(scheduled);
    if (scheduled) {
      expect(screen.getByTitle("2026/10/11 12:00（北京时间）").parentElement).toHaveTextContent(status === "RETRY_WAIT" ? "下次重试" : "计划投递");
    }
    expect(screen.queryByText("需人工关注")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^查看通知/ })).toHaveAttribute("href", "/notifications/00000000-0000-4000-8000-000000000002");
  });

  it("keeps exception, conflict and terminal notification destinations distinct and preserves server priority order", () => {
    const items = [conflict, exception, notification({ status: "DEAD_LETTER" })];
    mount(items);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-business-row"))).toEqual(items.map((item) => item.type + ":" + item.resource_id));
    expect(screen.queryByText("需人工关注")).not.toBeInTheDocument();
    expect(screen.getByText("投递失败")).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByText("实收金额不符")).toBeVisible();
    expect(screen.getByText("外部流水号重复")).toBeVisible();
    expect(screen.queryByText("账务异常")).not.toBeInTheDocument();
    expect(screen.queryByText("账本冲突")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^核对异常/ })).toHaveAttribute("href", "/reconciliation/exceptions/" + exception.resource_id);
    expect(screen.getByRole("link", { name: /^核对冲突/ })).toHaveAttribute("href", "/reconciliation/conflicts/" + conflict.resource_id);
    expect(screen.queryByText("开放中")).not.toBeInTheDocument();
  });

  it.each([
    { ...exception, order_id: null, order_summary: null },
    { ...conflict, external_event_id: null },
  ])("retains ledger identity when a $type reminder has no related order", (item) => {
    mount([item]);
    expect(screen.getByText("未关联订单")).toBeVisible();
    expect(screen.getByText("流水 " + item.ledger_entry_id)).toHaveAttribute("title", item.ledger_entry_id);
    expect(screen.queryByRole("link", { name: /^查看订单/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });

  it("prefers the external ledger reference for shared conflicts", () => {
    mount([conflict]);
    expect(screen.getByText("流水 ALI-SHARED-CONFLICT-001")).toBeVisible();
    expect(screen.queryByText("流水 " + conflict.ledger_entry_id)).not.toBeInTheDocument();
  });

  it("labels the order identifier link when its readable summary is unavailable", () => {
    mount([notification({ order_summary: null })]);
    expect(screen.getByText("订单摘要暂不可用")).toBeVisible();
    expect(screen.getByTitle(order.order_id)).toBeVisible();
    const orderLink = screen.getByRole("link", { name: /^查看订单/ });
    expect(orderLink).toHaveTextContent("订单号");
    expect(orderLink).toHaveTextContent(order.order_id);
    expect(orderLink).toHaveAttribute("href", "/orders/" + order.order_id);
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  it.each([false, true])("shows the website only globally and retains every scoped destination (scoped: %s)", async (scoped) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { client_id: "site_a", configuration: { name: "订阅网站" } } })));
    mount([notification()], scoped ? "/sites/site_a" : "/", true);
    if (scoped) {
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(screen.queryByRole("link", { name: "订阅网站 · site_a" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: "订阅网站 · site_a" })).toBeVisible();
    }
    const prefix = scoped ? "/sites/site_a" : "";
    expect(screen.getByRole("link", { name: /^查看通知/ })).toHaveAttribute("href", prefix + "/notifications/00000000-0000-4000-8000-000000000002");
    expect(screen.getByRole("link", { name: "查看订单：专业版订阅" })).toHaveAttribute("href", prefix + "/orders/" + order.order_id);
  });

  it("opens the primary detail from row whitespace and keeps the separate order link independent", async () => {
    mount();
    const user = userEvent.setup();
    const row = screen.getByRole("listitem");
    expect(row).not.toHaveAttribute("tabindex");
    await user.click(row);
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/notifications/00000000-0000-4000-8000-000000000002");
    await user.click(screen.getByRole("link", { name: "查看订单：专业版订阅" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders/" + order.order_id);
  });

  it("supports keyboard and modified clicks without adding a duplicate row tab stop", async () => {
    mount();
    const primary = screen.getByRole("link", { name: /^查看通知/ });
    const forwarded = vi.fn((event: Event) => event.preventDefault());
    primary.addEventListener("auxclick", forwarded);
    fireEvent(screen.getByRole("listitem"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, ctrlKey: true }));
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded.mock.calls[0]![0]).toMatchObject({ button: 1, ctrlKey: true });
    primary.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/notifications/00000000-0000-4000-8000-000000000002");
  });

  it("preserves the full long product name in its order link and a large amount", () => {
    mobileMedia(320);
    const name = "同名商品及商户订单标识".repeat(16);
    mount([notification({ order_summary: { ...related, product_name: name, merchant_order_no: name, payable_amount_cents: 987654321012 } })]);
    expect(screen.getAllByText(name)).toHaveLength(1);
    expect(screen.getByText(name)).toHaveAttribute("title", name);
    expect(screen.getByLabelText("应付金额 ¥9,876,543,210.12")).toHaveAttribute("data-wide", "true");
    expect(screen.getByRole("link", { name: "查看订单：" + name })).toHaveAttribute("href", "/orders/" + order.order_id);
  });

  it("uses the empty state without implying a successful payment or notification", () => {
    mount([]);
    expect(screen.getByText("暂无待办")).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/收款已确认|全部已确认|¥/)).not.toBeInTheDocument();
  });
});
