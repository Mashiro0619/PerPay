import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryClient,
  type AdminWorkItem,
  type WebhookDeliverySummary,
} from "../src/api/client";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { ListDensityProvider } from "../src/components/list-density";
import { DataTable } from "../src/components/data-table";
import Orders from "../src/pages/Orders";
import WorkItems from "../src/pages/WorkItems";
import Reconciliation from "../src/pages/Reconciliation";
import Notifications from "../src/pages/Notifications";
import { alipayAccount, json, order, orderId, ledgerId } from "./fixtures";
import { delivery, deliveryId } from "./detail-fixtures";
import { groupedLedger } from "./ledger-fixtures";
import { mobileMedia } from "./mobile-media";

const longOrder = {
  ...order,
  merchant_order_no: "merchant-" + "1234567890".repeat(12),
};
const notification: WebhookDeliverySummary = {
  ...delivery.delivery,
  event: delivery.event,
  target: delivery.target,
};
const reminder: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION",
  status: "OPEN",
  exception_type: "UNMATCHED_CREDIT",
  candidate_id: null,
  resource_id: ledgerId,
  provider_account_key: "primary",
  order_id: null,
  ledger_entry_id: null,
  created_at: order.created_at,
  actionable_at: order.created_at,
  ignored_at: null,
  ignored_by: null,
  ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/" + ledgerId,
};
const lists = [
  {
    path: "/orders",
    element: <Orders />,
    data: [longOrder],
    hiddenColumn: "确认时间",
    summaryFields: [],
    summaryStatuses: ["待付款"],
    centeredColumns: ["payable_amount_cents", "received_amount_cents", "status", "created_at", "payment_confirmed_at"],
  },
  {
    path: "/work-items",
    element: <WorkItems />,
    data: [reminder],
    hiddenColumn: "创建时间",
    summaryFields: ["关联记录"],
    summaryStatuses: [],
    centeredColumns: ["actionable_at", "created_at", "actions"],
    rightAlignedColumns: ["payable_amount_cents"],
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    data: [groupedLedger],
    hiddenColumn: "最近关联时间",
    summaryFields: [],
    summaryStatuses: ["已关联", "已分配"],
    centeredColumns: ["association", "direction", "amount_cents", "occurred_at", "state"],
    optionalCenteredColumns: ["associated_at", "handled_at"],
  },
  {
    path: "/notifications",
    element: <Notifications />,
    data: [notification],
    hiddenColumn: "商户订单号",
    summaryFields: ["商户订单号", "尝试次数", "创建时间", "下次尝试", "应付金额"],
    summaryStatuses: ["等待重试"],
    centeredColumns: ["status", "attempt_count", "created_at", "next_attempt_at"],
  },
];
function Location() {
  const location = useLocation();
  return (
    <output aria-label="当前地址">{location.pathname + location.search}</output>
  );
}
function mount(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ListDensityProvider>
      <MemoryRouter initialEntries={[path]}>
        <TestPaymentProvider>
          <Routes>
            <Route path={path.split("?")[0]} element={element} />
            <Route path="/orders/:id" element={<h1>订单详情</h1>} />
            <Route
              path="/reconciliation/transactions/:id"
              element={<h1>流水详情</h1>}
            />
          </Routes>
          <Location />
        </TestPaymentProvider>
      </MemoryRouter>
      </ListDensityProvider>
    </QueryClientProvider>,
  );
}
function pageResponse(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ data, page: { next_cursor: null } })),
  );
}
async function chooseMode(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: /^查询方式：/ }));
  await user.click(await screen.findByRole("menuitemradio", { name }));
}

function expectColumnAlignment(table: HTMLElement, centeredColumns: readonly string[], optionalCenteredColumns: readonly string[] = [], rightAlignedColumns: readonly string[] = []) {
  const headers = within(table).getAllByRole("columnheader");
  expect(headers.map((header) => header.getAttribute("data-column-id"))).toEqual(
    expect.arrayContaining(["identity", ...centeredColumns, ...rightAlignedColumns]),
  );
  for (const header of headers) {
    const columnId = header.getAttribute("data-column-id")!;
    const alignment = [...centeredColumns, ...optionalCenteredColumns].includes(columnId) ? "center" : rightAlignedColumns.includes(columnId) ? "right" : "left";
    expect(header).toHaveAttribute("data-column-align", alignment);
    expect(table.querySelector(`tbody [data-column-id="${columnId}"]`)).toHaveAttribute("data-column-align", alignment);
  }
}

describe("desktop business list composition", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia(1600);
  });

  it("keeps the desktop filter mounted and focused when the first work-item results arrive", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => response));
    mount("/work-items", <WorkItems />);
    const filter = screen.getByRole("button", { name: "待处理" });
    act(() => filter.focus());
    expect(filter).toHaveFocus();

    await act(async () => resolveResponse(json({ data: [reminder], page: { next_cursor: null } })));
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "待处理" })).toBe(filter);
    expect(filter).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
  });

  it("keeps the narrow-container toolbar focused when results disappear and return", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-business-table")
        ? DOMRect.fromRect({ width: 400, height: 200 })
        : original.call(this);
    });
    pageResponse([reminder]);
    const view = mount("/work-items", <WorkItems />);
    const filter = await screen.findByRole("button", { name: /^筛选与排序/ });
    act(() => filter.focus());
    expect(filter).toHaveFocus();

    act(() => queryClient.setQueriesData({ queryKey: ["work-items"] }, { data: [], page: { next_cursor: null } }));
    await waitFor(() => expect(view.container.querySelector("[data-business-table]")).toBeNull());
    expect(filter).toHaveFocus();
    act(() => queryClient.setQueriesData({ queryKey: ["work-items"] }, { data: [reminder], page: { next_cursor: null } }));
    await screen.findByRole("listitem");
    expect(screen.getByRole("button", { name: /^筛选与排序/ })).toBe(filter);
    expect(filter).toHaveFocus();
  });

  it.each(lists)(
    "keeps search, common filters and one display menu grouped without duplicate desktop sorting on $path",
    async ({ path, element, data, centeredColumns, optionalCenteredColumns, rightAlignedColumns }) => {
      pageResponse(data);
      const view = mount(path, element);
      const table = await screen.findByRole("table");
      expect(screen.getAllByRole("search")).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "筛选与排序" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "排序字段" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /当前.*序，切换/ })).not.toBeInTheDocument();
      const row = view.container.querySelector("[data-list-toolbar-row]")!;
      expect(row.querySelector("form")).toBe(screen.getByRole("search"));
      const filters = row.querySelector("[data-list-desktop-filters]")!;
      expect(row.querySelector("[data-list-desktop-sort]")).toBeNull();
      const actions = row.querySelector("[data-list-desktop-actions]");
      expect(filters.parentElement).toBe(row);
      expect(within(filters as HTMLElement).queryAllByRole("combobox").length).toBeLessThanOrEqual(2);
      expect(actions).not.toBeNull();
      expect(actions!.parentElement).toBe(row);
      expect(
        filters.compareDocumentPosition(actions!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      if (path === "/orders") {
        expect(screen.queryByRole("button", { name: "测试收款" })).not.toBeInTheDocument();
      }
      expect(within(table).getAllByRole("button").length).toBeGreaterThan(0);
      const displayMenu = screen.getByRole("button", { name: "列表显示" });
      expect(displayMenu.closest("th")).toBeNull();
      expect(displayMenu.closest("[data-list-query-toolbar]")).toBe(
        view.container.querySelector("[data-list-query-toolbar]"),
      );
      expect(screen.getAllByRole("button", { name: "列表显示" })).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "显示列" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "列表密度" })).not.toBeInTheDocument();
      expect(view.container.querySelector("[data-business-list]")).toHaveClass("w-full", "min-w-0");
      expect(view.container.querySelector("[data-business-list]")).not.toHaveClass("max-w-[1600px]", "mx-auto");
      expect(table.querySelector("tbody td")).toHaveAttribute("data-column-layout", "identity");
      expectColumnAlignment(table, centeredColumns, optionalCenteredColumns, rightAlignedColumns);
      expect(table).toHaveAttribute("data-density", "compact");
      expect(table).toHaveClass("table-fixed");
      expect(table.querySelector("tbody td")).not.toHaveClass("py-2");
      expect(table.querySelector("tbody td")).not.toHaveClass("w-full");
    },
  );

  it.each(lists)(
    "uses the measured container and keeps desktop column preferences separate from mobile summaries on $path",
    async ({ path, element, data, hiddenColumn, summaryFields, summaryStatuses, centeredColumns, optionalCenteredColumns, rightAlignedColumns }) => {
      if (path === "/notifications") {
        localStorage.setItem("perpay.table-columns.v2.notifications", JSON.stringify({ order: false }));
      }
      let width = 400;
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-business-table")
          ? DOMRect.fromRect({ width, height: 200 })
          : original.call(this);
      });
      pageResponse(data);
      mount(path, element);
      const summary = await screen.findByRole("listitem");
      const mobileContent = summary.textContent;
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(within(summary).queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
      expect(Array.from(summary.querySelectorAll(".business-summary-field > dt"), field => field.textContent)).toEqual(summaryFields);
      if (path === "/orders") {
        const metadata = summary.querySelector<HTMLElement>(".order-summary-metadata")!;
        expect(within(metadata).getByText("网站", { selector: "dt" })).toBeInTheDocument();
        expect(within(metadata).getByText("创建时间", { selector: "dt" })).toBeInTheDocument();
        expect(within(metadata).getByRole("link")).toHaveAttribute("href", "/sites/default/summary");
        expect(metadata.querySelector("time[datetime]")).toBeVisible();
        expect(within(summary).getByRole("group", { name: "应付金额 ¥1.01" })).toBeVisible();
        expect(within(summary).queryByRole("group", { name: /^实收金额/ })).not.toBeInTheDocument();
      }
      for (const status of summaryStatuses) {
        const value = within(summary.querySelector<HTMLElement>("[data-summary-status]")!).getByText(status, { exact: true });
        expect(value).toBeVisible();
        expect(value.closest("[data-summary-status]")).not.toBeNull();
      }
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^筛选与排序/ }));
      const sheet = await screen.findByRole("dialog", { name: "筛选与排序" });
      expect(within(sheet).getByRole("combobox", { name: "排序字段" })).toBeVisible();
      await user.click(within(sheet).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "筛选与排序" })).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: /^更多.*操作$/ }));
      await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
      const display = await screen.findByRole("dialog", { name: "列表显示" });
      expect(within(display).queryByRole("checkbox")).not.toBeInTheDocument();
      expect(within(display).getByText("手机列表展示关键摘要，完整信息可打开详情查看。")).toBeVisible();
      expect(within(display).getByText("紧凑")).toBeVisible();
      await user.click(within(display).getByRole("button", { name: "完成" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "列表显示" })).not.toBeInTheDocument());
      width = 1300;
      act(() => window.dispatchEvent(new Event("resize")));
      const table = screen.getByRole("table");
      expect(table).toBeVisible();
      expect(screen.queryByRole("button", { name: /^筛选与排序/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "排序字段" })).not.toBeInTheDocument();
      expectColumnAlignment(table, centeredColumns, optionalCenteredColumns, rightAlignedColumns);
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "列表显示" }));
      const desktopDisplay = await screen.findByRole("dialog", { name: "列表显示" });
      const column = within(desktopDisplay).getByRole("checkbox", { name: hiddenColumn });
      if (within(table).queryByRole("columnheader", { name: hiddenColumn })) await user.click(column);
      await user.click(column);
      expect(column).toBeChecked();
      await user.keyboard("{Escape}");
      expect(screen.getByRole("columnheader", { name: hiddenColumn })).toBeVisible();
      width = 400;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getByRole("listitem").textContent).toBe(mobileContent);
      expect(within(screen.getByRole("listitem")).queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^筛选与排序/ })).toBeVisible();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
      width = 1300;
      act(() => window.dispatchEvent(new Event("resize")));
      expect(screen.getByRole("columnheader", { name: hiddenColumn })).toBeVisible();
    },
  );

  it("keeps the narrow-container sort sheet through a pending search and an empty result on desktop", async () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-business-table")
        ? DOMRect.fromRect({ width: 400, height: 200 })
        : original.call(this);
    });
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((request: Request) => {
      const url = new URL(request.url);
      requests.push(url);
      return url.searchParams.has("q")
        ? pending
        : Promise.resolve(json({ data: [order], page: { next_cursor: null } }));
    }));
    const view = mount("/orders", <Orders />);
    const summary = await screen.findByRole("listitem");
    const trigger = await screen.findByRole("button", { name: "筛选与排序" });
    const expectSheetEntry = () => {
      expect(screen.getByRole("button", { name: "筛选与排序" })).toBe(trigger);
      expect(trigger).toBeVisible();
      expect(screen.queryByRole("combobox", { name: "排序字段" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /当前.*序，切换/ })).not.toBeInTheDocument();
      expect(view.container.querySelector("[data-list-desktop-sort]")).toBeNull();
    };
    const user = userEvent.setup();
    try {
      expect(summary).toBeVisible();
      expectSheetEntry();
      await user.type(screen.getByRole("searchbox", { name: "订单关键词搜索" }), "无匹配订单{Enter}");
      await waitFor(() => expect(requests.some((url) => url.searchParams.get("q") === "无匹配订单")).toBe(true));
      expect(summary).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "没有符合条件的订单" })).not.toBeInTheDocument();
      expectSheetEntry();

      await act(async () => { finish(json({ data: [], page: { next_cursor: null } })); });
      expect(await screen.findByRole("heading", { name: "没有符合条件的订单" })).toBeVisible();
      expectSheetEntry();
      await user.click(trigger);
      const sheet = await screen.findByRole("dialog", { name: "筛选与排序" });
      await user.click(within(sheet).getByRole("combobox", { name: "排序字段" }));
      await user.click(await screen.findByRole("option", { name: "应付金额" }));
      expect(within(sheet).getByRole("combobox", { name: "排序字段" })).toHaveTextContent("应付金额");
      await user.click(within(sheet).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "筛选与排序" })).not.toBeInTheDocument());
      expectSheetEntry();
    } finally { finish(json({ data: [], page: { next_cursor: null } })); }
  });

  it.each([
    {
      path: "/reconciliation",
      element: <Reconciliation />,
      data: [groupedLedger],
      id: ledgerId,
      relatedName: "查看订单：" + order.merchant_order_no,
    },
    {
      path: "/notifications",
      element: <Notifications />,
      data: [notification],
      id: deliveryId,
      relatedName: "查看订单",
    },
  ])(
    "keeps technical identifiers out of primary content and retains related order navigation on $path",
    async ({ path, element, data, id, relatedName }) => {
      pageResponse(data);
      mount(path, element);
      await screen.findByRole("table");
      expect(screen.queryByText(id, { exact: true })).not.toBeInTheDocument();
      if (path === "/notifications") {
        expect(screen.queryByRole("link", { name: relatedName })).not.toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "列表显示" }));
        await user.click(await screen.findByRole("checkbox", { name: "商户订单号" }));
        await user.keyboard("{Escape}");
      }
      const related = screen.getByRole("link", { name: relatedName });
      expect(related).toHaveAttribute("href", "/orders/" + orderId);
      expect(screen.getByRole("columnheader", { name: path === "/reconciliation" ? "当前关联订单" : "商户订单号" })).toBeVisible();
      expect(related).not.toHaveTextContent("…");
      if (path === "/reconciliation") {
        expect(related).toHaveTextContent(order.product_name);
        expect(related).toHaveAttribute("title", order.product_name);
        expect(screen.queryByText(order.merchant_order_no, { exact: true })).not.toBeInTheDocument();
        expect(related.closest('[data-column-id="order"]')).not.toBeNull();
        expect(screen.queryByRole("columnheader", { name: "商户订单号" })).not.toBeInTheDocument();
        expect(screen.queryByRole("columnheader", { name: "关联网站" })).not.toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "列表显示" }));
        await user.click(await screen.findByRole("checkbox", { name: "商户订单号" }));
        await user.click(screen.getByRole("checkbox", { name: "关联网站" }));
        await user.keyboard("{Escape}");
        const table = screen.getByRole("table");
        const reference = table.querySelector('tbody [data-column-id="order_reference"] a');
        expect(reference).toHaveTextContent(order.merchant_order_no);
        expect(reference).toHaveAttribute("href", "/orders/" + orderId);
        expect(table.querySelector('tbody [data-column-id="site"] a')).toHaveAttribute("href", "/sites/" + order.api_client_id + "/summary");
        expect(table.querySelector('tbody [data-column-id="order"]')).toHaveTextContent(order.product_name);
        expect(table.querySelector('tbody [data-column-id="order"]')).not.toHaveTextContent(order.merchant_order_no);
      }
    },
  );

  it("keeps mobile transaction and account identities readable and opens the complete record through its primary link", async () => {
      mobileMedia(390);
      pageResponse([{ ...groupedLedger, alipay_account_id: alipayAccount.id, alipay_account_name: alipayAccount.name }]);
      mount("/reconciliation", <Reconciliation />);
      const primary = await screen.findByRole("link", { name: "支付宝流水" });
      const summary = screen.getByRole("listitem");
      expect(within(summary).getByText("交易时间")).toBeVisible();
      expect(within(summary).getByRole("group", { name: "收支" })).toHaveTextContent("收入");
      expect(within(summary).getByRole("group", { name: "关联状态" })).toHaveTextContent("已关联");
      expect(within(summary).queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
      expect(screen.queryByRole("columnheader", { name: "当前关联订单" })).not.toBeInTheDocument();
      const relatedOrder = within(summary).getByRole("link", { name: "查看订单：" + order.merchant_order_no });
      expect(relatedOrder).toHaveTextContent(order.product_name);
      expect(relatedOrder).toHaveAttribute("href", "/orders/" + orderId);
      expect(relatedOrder.closest("dd")?.previousElementSibling).toHaveTextContent("订单");
      const account = within(summary).getByRole("link", { name: alipayAccount.name });
      expect(account).toHaveAttribute("href", "/settings/accounts/" + alipayAccount.id);
      expect(account.closest("dd")?.previousElementSibling).toHaveTextContent("账号");
      expect(within(summary).getByRole("group", { name: "PerPay 处理状态" })).toHaveTextContent("已分配");
      await userEvent.click(primary);
      expect(await screen.findByRole("heading", { name: "流水详情" })).toBeVisible();
      expect(screen.getByLabelText("当前地址")).toHaveTextContent("/reconciliation/transactions/" + groupedLedger.ledger_entry_id);
  });

  it.each([1600, 390])("applies desktop order-column preferences without hiding required mobile identity at %i pixels", async width => {
    mobileMedia(width);
    localStorage.setItem("perpay.table-columns.v2.administrator-ledger", JSON.stringify({ order: false }));
    pageResponse([groupedLedger]);
    mount("/reconciliation", <Reconciliation />);
    await screen.findByRole("link", { name: width === 1600 ? groupedLedger.external_event_id : "支付宝流水" });
    const relatedOrder = screen.queryByRole("link", { name: "查看订单：" + order.merchant_order_no });
    if (width === 1600) expect(relatedOrder).not.toBeInTheDocument();
    else {
      expect(relatedOrder).toBeVisible();
      expect(relatedOrder).toHaveTextContent(order.product_name);
      expect(relatedOrder?.closest("dd")?.previousElementSibling).toHaveTextContent("订单");
    }
    expect(screen.queryByText(order.merchant_order_no, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "当前关联订单" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.administrator-ledger")!)).toEqual({ order: false });
  });

  it("keeps main identities compact while retaining full merchant numbers in embedded overview rows", async () => {
    pageResponse([longOrder]);
    const view = mount("/orders", <Orders />);
    const table = await screen.findByRole("table");
    expect(table.querySelector('tbody [data-column-id="identity"]')).not.toHaveTextContent(longOrder.merchant_order_no);
    expect(table).toHaveAttribute("data-density", "compact");
    view.unmount();
    render(
      <MemoryRouter>
        <DataTable data={[longOrder]} />
      </MemoryRouter>,
    );
    expect(screen.getByText(longOrder.merchant_order_no)).toHaveAttribute("title", longOrder.merchant_order_no);
    expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
    expect(screen.getByRole("table").closest("[data-business-table]")).toHaveAttribute("data-embedded", "true");
    expect(
      screen.queryByRole("button", { name: "显示列" }),
    ).not.toBeInTheDocument();
  });

  it("keeps keyword and exact drafts, mode and URL filters when crossing breakpoints", async () => {
    const media = mobileMedia(1440);
    pageResponse([order]);
    mount(
      "/orders?q=applied&payment=UNPAID&source=overview&cursor=next&page=3",
      <Orders />,
    );
    const user = userEvent.setup();
    const keyword = screen.getByRole("searchbox");
    await user.clear(keyword);
    await user.type(keyword, "尚未提交的关键词");
    await chooseMode(user, "内部订单编号（PerPay）");
    await user.type(screen.getByRole("searchbox", { name: "订单号" }), orderId);
    expect(
      screen.getByRole("button", { name: "查询方式：内部订单编号（PerPay）" }),
    ).toHaveTextContent("内部订单编号（PerPay）");
    media.resize(390);
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(
      orderId,
    );
    await user.click(screen.getByRole("button", { name: /^筛选与排序/ }));
    media.resize(1440);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getByRole("searchbox", { name: "订单号" })).toHaveValue(
      orderId,
    );
    await chooseMode(user, "关键词");
    expect(screen.getByRole("searchbox")).toHaveValue("尚未提交的关键词");
    expect(screen.getByLabelText("当前地址")).toHaveTextContent(
      "/orders?q=applied&payment=UNPAID&source=overview&cursor=next&page=3",
    );
  });

  it.each([
    {
      mode: "商户订单号（业务网站）",
      value: order.merchant_order_no,
      path: "/orders",
      element: <Orders />,
      data: [order],
      title: "订单详情",
    },
    {
      mode: "内部订单编号（PerPay）",
      value: orderId,
      path: "/orders",
      element: <Orders />,
      data: [order],
      title: "订单详情",
    },
    {
      mode: "内部流水编号（PerPay）",
      value: ledgerId,
      path: "/reconciliation",
      element: <Reconciliation />,
      data: [groupedLedger],
      title: "流水详情",
    },
  ])(
    "preserves exact lookup semantics for $mode on desktop",
    async ({ mode, value, path, element, data, title }) => {
      const requests: Request[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (request: Request) => {
          requests.push(request);
          return /\/(?:orders|entries)$/.test(new URL(request.url).pathname)
            ? json({ data, page: { next_cursor: null } })
            : json({ data: order });
        }),
      );
      mount(path, element);
      const user = userEvent.setup();
      await chooseMode(user, mode);
      await user.type(screen.getByRole("searchbox"), value);
      await user.click(screen.getByRole("button", { name: "查找" }));
      expect(await screen.findByRole("heading", { name: title })).toBeVisible();
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("keeps the desktop bulk-ignore scope on applied filters rather than the search draft", async () => {
    pageResponse([reminder]);
    mount("/work-items?type=FINANCIAL_EXCEPTION&q=applied", <WorkItems />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const search = screen.getByRole("searchbox");
    await user.clear(search);
    await user.type(search, "not-submitted");
    const trigger = screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" });
    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("applied");
    expect(dialog).not.toHaveTextContent("not-submitted");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
