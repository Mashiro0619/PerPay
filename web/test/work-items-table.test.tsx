import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "../src/api/client";
import { WorkItemsTable } from "../src/components/work-items-table";
import type { ListQueryControl } from "../src/lib/list-query";
import { WorkspaceProvider } from "../src/workspace";
import { json, orderId, ledgerId } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const related: NonNullable<AdminWorkItem["order_summary"]> = {
  order_id: orderId,
  api_client_id: "site_a",
  site_name: "订阅网站",
  product_name: "专业版订阅",
  merchant_order_no: "2026103010300010000001",
  requested_amount_cents: 19900,
  payable_amount_cents: 19901,
  received_amount_cents: 19901,
  payment_confirmed_at: "2026-10-30T02:32:00.000Z",
};
const exception: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  resource_id: "00000000-0000-4000-8000-000000000001",
  provider_account_key: "synthetic-account",
  order_id: orderId,
  order_summary: related,
  ledger_entry_id: ledgerId,
  created_at: "2026-10-30T02:30:00.000Z",
  actionable_at: "2026-10-30T03:00:00.000Z",
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "unused",
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
    next_attempt_at: "2026-10-30T04:00:00.000Z",
    last_error_code: "TIMEOUT",
    dead_lettered_at: null,
    updated_at: "2026-10-30T03:00:00.000Z",
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
const control: ListQueryControl = {
  query: { q: "", sortBy: "actionable_at", sortOrder: "desc" },
  setSort: vi.fn(),
  setKeyword: vi.fn(),
  clear: vi.fn(),
  update: vi.fn(),
};

function LocationProbe() {
  return <output aria-label="当前地址">{useLocation().pathname}</output>;
}
function mount(items: AdminWorkItem[], path = "/work-items", scoped = false) {
  const content = <><WorkItemsTable items={items} control={control} /><LocationProbe /></>;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {scoped ? <WorkspaceProvider>{content}</WorkspaceProvider> : content}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function rows() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-business-row]"));
}

beforeEach(() => {
  localStorage.clear();
  mobileMedia(1440);
});

describe("work item business context", () => {
  it.each([1440, 390, 320])("distinguishes matching reminder states by their visible order, site and amount at %spx", (width) => {
    mobileMedia(width);
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
          merchant_order_no: "2026103010350010000002",
          payable_amount_cents: 59901,
        },
      }),
    ]);
    expect(rows()).toHaveLength(2);
    for (const [index, product, merchantNumber, amount] of [
      [0, "专业版订阅", related.merchant_order_no, "¥199.01"],
      [1, "团队版订阅", "2026103010350010000002", "¥599.01"],
    ] as const) {
      const row = within(rows()[index]!);
      expect(row.getByRole("link", { name: "通知正在等待重试" })).toBeVisible();
      const productLink = row.getByRole("link", { name: "查看订单：" + product });
      expect(productLink).toBeVisible();
      expect(productLink.closest('[aria-hidden="true"]')).toBeNull();
      expect(row.getByText(merchantNumber)).toBeVisible();
      expect(row.getByRole("link", { name: "订阅网站 · site_a" })).toBeVisible();
      expect(row.getByRole("group", { name: "应付金额 " + amount })).toBeVisible();
      expect(row.getByText("请求超时")).toBeVisible();
    }
    if (width >= 640) {
      expect(screen.getByRole("columnheader", { name: "关联记录" })).toBeVisible();
      expect(screen.getByRole("columnheader", { name: "应付金额" })).toBeVisible();
    } else {
      expect(screen.getByRole("list", { name: "待处理提醒列表" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["null", "omitted"] as const)("keeps a labeled order link and unknown amount when the summary is %s", (summary) => {
    const item = notification({ order_summary: null });
    if (summary === "omitted") delete item.order_summary;
    mount([item]);
    expect(screen.getByText("订单摘要暂不可用")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看订单，内部订单编号（PerPay）：" + orderId }))
      .toHaveAttribute("href", "/orders/" + orderId);
    expect(screen.getByRole("group", { name: "应付金额 —" })).toBeVisible();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("订阅网站")).not.toBeInTheDocument();
  });

  it.each([
    { item: conflict, label: "支付宝流水号", reference: conflict.external_event_id!, title: "支付宝流水号重复", path: "/reconciliation/conflicts/" },
    { item: { ...exception, order_id: null, order_summary: null }, label: "内部流水编号（PerPay）", reference: ledgerId, title: "实收金额不符", path: "/reconciliation/exceptions/" },
    { item: { ...exception, order_id: null, order_summary: null, ledger_entry_id: null }, label: "提醒编号", reference: exception.resource_id, title: "实收金额不符", path: "/reconciliation/exceptions/" },
  ])("identifies an unassociated reminder by $label without inventing order data", ({ item, label, reference, title, path }) => {
    mobileMedia(320);
    mount([item]);
    expect(screen.getByText("未关联订单")).toBeVisible();
    const identity = screen.getByTitle(reference);
    expect(identity).toBeVisible();
    expect(identity.parentElement).toHaveTextContent(label + " " + reference);
    expect(screen.getByRole("link", { name: title })).toHaveAttribute("href", path + item.resource_id);
    expect(screen.queryByRole("link", { name: /^查看订单/ })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "应付金额 —" })).toBeVisible();
    expect(screen.queryByText("订阅网站")).not.toBeInTheDocument();
    if (item.type === "LEDGER_CONFLICT") expect(screen.queryByTitle(ledgerId)).not.toBeInTheDocument();
  });

  it.each([1440, 320])("preserves reminder row navigation and separate order and site links at %spx", async (width) => {
    mobileMedia(width);
    const item = notification();
    mount([item]);
    const row = rows()[0]!;
    const primary = within(row).getByRole("link", { name: "通知正在等待重试" });
    expect(primary).toHaveAttribute("data-row-link");
    expect(primary).toHaveAttribute("data-reminder-id", item.type + ":" + item.resource_id);
    expect(row).not.toHaveAttribute("tabindex");
    const user = userEvent.setup();
    await user.click(row);
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/notifications/" + item.resource_id);
    await user.click(within(row).getByRole("link", { name: "查看订单：专业版订阅" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders/" + orderId);
    await user.click(within(row).getByRole("link", { name: "订阅网站 · site_a" }));
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("/sites/site_a");
  });

  it.each([false, true])("shows the site globally and keeps scoped order and reminder destinations (scoped: %s)", async (scoped) => {
    const fetch = vi.fn(async () => json({ data: { client_id: "site_a", configuration: { name: "订阅网站" } } }));
    vi.stubGlobal("fetch", fetch);
    const prefix = scoped ? "/sites/site_a" : "";
    mount([notification()], prefix + "/work-items", true);
    expect(screen.getByRole("link", { name: "查看订单：专业版订阅" })).toHaveAttribute("href", prefix + "/orders/" + orderId);
    expect(screen.getByRole("link", { name: "通知正在等待重试" })).toHaveAttribute("href", prefix + "/notifications/00000000-0000-4000-8000-000000000002");
    if (scoped) {
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      expect(screen.queryByRole("link", { name: "订阅网站 · site_a" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole("link", { name: "订阅网站 · site_a" })).toHaveAttribute("href", "/sites/site_a");
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["PENDING", "通知等待投递", "计划投递"],
    ["LEASED", "通知正在投递", null],
    ["RETRY_WAIT", "通知正在等待重试", "下次重试"],
    ["ACKNOWLEDGED", "通知已确认", null],
    ["DEAD_LETTER", "通知已停止重试", null],
  ] as const)("shows the actual %s state and only its applicable schedule and error", (status, title, schedule) => {
    mount([notification({ status, ended: status === "ACKNOWLEDGED" })]);
    expect(screen.getByRole("link", { name: title })).toBeVisible();
    expect(screen.getByText("已尝试 3 次")).toBeVisible();
    expect(screen.getByText("通知事件：收款已确认")).toBeVisible();
    const nextAttempt = screen.queryByTitle("2026/10/30 12:00（北京时间）");
    if (schedule) {
      expect(nextAttempt).toBeVisible();
      expect(nextAttempt!.parentElement).toHaveTextContent(schedule);
    } else expect(nextAttempt).not.toBeInTheDocument();
    if (status === "ACKNOWLEDGED") expect(screen.queryByText("请求超时")).not.toBeInTheDocument();
    else expect(screen.getByText("请求超时")).toBeVisible();
  });

  it("retains context for an ended ignored reminder without presenting a stale retry schedule", () => {
    mobileMedia(320);
    mount([notification({ ended: true, ignored_at: "2026-10-30T05:00:00.000Z", ignored_by: "审核员" })]);
    expect(screen.getByRole("link", { name: "查看订单：专业版订阅" })).toBeVisible();
    expect(screen.getByText("审核员已忽略", { exact: false })).toBeVisible();
    expect(screen.getByText("已结束")).toBeVisible();
    expect(screen.queryByTitle("2026/10/30 12:00（北京时间）")).not.toBeInTheDocument();
  });
});
