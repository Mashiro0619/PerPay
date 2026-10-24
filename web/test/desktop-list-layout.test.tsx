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
import { DataTable } from "../src/components/data-table";
import Orders from "../src/pages/Orders";
import WorkItems from "../src/pages/WorkItems";
import Reconciliation from "../src/pages/Reconciliation";
import Notifications from "../src/pages/Notifications";
import { json, order, orderId, ledgerId } from "./fixtures";
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
    hiddenColumn: "PerPay 确认时间",
    centeredColumns: ["payable_amount_cents", "received_amount_cents", "status", "created_at", "payment_confirmed_at"],
  },
  {
    path: "/work-items",
    element: <WorkItems />,
    data: [reminder],
    hiddenColumn: "创建时间",
    centeredColumns: ["actionable_at", "created_at", "actions"],
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    data: [groupedLedger],
    hiddenColumn: "最近关联时间",
    centeredColumns: ["association", "direction", "amount_cents", "occurred_at", "state"],
    optionalCenteredColumns: ["associated_at", "handled_at"],
  },
  {
    path: "/notifications",
    element: <Notifications />,
    data: [notification],
    hiddenColumn: "关联商户订单号（业务网站）",
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

function expectColumnAlignment(table: HTMLElement, centeredColumns: readonly string[], optionalCenteredColumns: readonly string[] = []) {
  const headers = within(table).getAllByRole("columnheader");
  expect(headers.map((header) => header.getAttribute("data-column-id"))).toEqual(
    expect.arrayContaining(["identity", ...centeredColumns]),
  );
  for (const header of headers) {
    const columnId = header.getAttribute("data-column-id")!;
    const alignment = [...centeredColumns, ...optionalCenteredColumns].includes(columnId) ? "center" : "left";
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
    "keeps search, filters and the unique column menu grouped without duplicate desktop sorting on $path",
    async ({ path, element, data, centeredColumns, optionalCenteredColumns }) => {
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
      if (path === "/orders") {
        expect(actions).toBeNull();
        expect(screen.queryByRole("button", { name: "测试收款" })).not.toBeInTheDocument();
      } else {
        expect(actions).not.toBeNull();
        expect(actions!.parentElement).toBe(row);
        expect(
          filters.compareDocumentPosition(actions!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
      expect(within(table).getAllByRole("button").length).toBeGreaterThan(0);
      const columnMenu = screen.getByRole("button", { name: "显示列" });
      expect(columnMenu.closest("th")).toBeNull();
      expect(columnMenu.closest("[data-list-query-toolbar]")).toBe(
        view.container.querySelector("[data-list-query-toolbar]"),
      );
      expect(columnMenu.closest("[data-list-columns-slot]")).not.toBeNull();
      expect(screen.getAllByRole("button", { name: "显示列" })).toHaveLength(1);
      expect(view.container.querySelector("[data-business-list]")).toHaveClass("w-full", "min-w-0");
      expect(view.container.querySelector("[data-business-list]")).not.toHaveClass("max-w-[1600px]", "mx-auto");
      expect(table.querySelector("tbody td")).toHaveAttribute("data-column-layout", "identity");
      expectColumnAlignment(table, centeredColumns, optionalCenteredColumns);
      expect(table).toHaveAttribute("data-density", "compact");
      expect(table).toHaveClass("table-fixed");
      expect(table.querySelector("tbody td")).not.toHaveClass("py-2");
      expect(table.querySelector("tbody td")).not.toHaveClass("w-full");
    },
  );

  it.each(lists)(
    "uses the measured container and honors explicitly shown columns on $path",
    async ({ path, element, data, hiddenColumn, centeredColumns, optionalCenteredColumns }) => {
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
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(
        within(summary).queryByText(hiddenColumn, { selector: "dt" }),
      ).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^筛选与排序/ }));
      const sheet = await screen.findByRole("dialog", { name: "筛选与排序" });
      expect(within(sheet).getByRole("combobox", { name: "排序字段" })).toBeVisible();
      await user.click(within(sheet).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "筛选与排序" })).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: /^更多.*操作$/ }));
      await user.click(await screen.findByRole("menuitem", { name: "列表显示" }));
      const display = await screen.findByRole("dialog", { name: "列表显示" });
      await user.click(within(display).getByRole("checkbox", { name: hiddenColumn }));
      await user.click(within(display).getByRole("button", { name: "完成" }));
      const expand = within(summary).queryByRole("button", { name: "展开信息" });
      if (expand) await user.click(expand);
      expect(
        within(summary).getByText(hiddenColumn, { selector: "dt" }),
      ).toBeVisible();
      width = 1300;
      act(() => window.dispatchEvent(new Event("resize")));
      const table = screen.getByRole("table");
      expect(table).toBeVisible();
      expect(screen.queryByRole("button", { name: /^筛选与排序/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox", { name: "排序字段" })).not.toBeInTheDocument();
      expectColumnAlignment(table, centeredColumns, optionalCenteredColumns);
      expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: hiddenColumn })).toBeVisible();
      width = 400;
      act(() => window.dispatchEvent(new Event("resize")));
      const expandAgain = within(screen.getByRole("listitem")).queryByRole("button", { name: "展开信息" });
      if (expandAgain) await user.click(expandAgain);
      expect(
        within(screen.getByRole("listitem")).getByText(hiddenColumn, { selector: "dt" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: /^筛选与排序/ })).toBeVisible();
      expect(document.querySelectorAll("[data-business-row]")).toHaveLength(1);
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
      const related = screen.getByRole("link", { name: relatedName });
      expect(related).toHaveAttribute("href", "/orders/" + orderId);
      expect(screen.getByRole("columnheader", { name: path === "/reconciliation" ? "当前关联订单" : "关联商户订单号（业务网站）" })).toBeVisible();
      expect(related).not.toHaveTextContent("…");
      if (path === "/reconciliation") {
        expect(related).toHaveTextContent(order.merchant_order_no);
        expect(screen.getAllByText(order.merchant_order_no, { exact: true })).toHaveLength(1);
        expect(related.closest('[data-column-id="order"]')).not.toBeNull();
      }
    },
  );

  it("keeps the selected order number and navigation in the mobile summary", async () => {
      mobileMedia(390);
      pageResponse([groupedLedger]);
      mount("/reconciliation", <Reconciliation />);
      const related = await screen.findByRole("link", { name: "查看订单：" + order.merchant_order_no });
      expect(related.closest('.business-summary-field')).toHaveTextContent("当前关联订单");
      expect(screen.queryByRole("columnheader", { name: "当前关联订单" })).not.toBeInTheDocument();
      expect(screen.getAllByText(order.merchant_order_no, { exact: true })).toHaveLength(1);
      await userEvent.click(related);
      expect(await screen.findByRole("heading", { name: "订单详情" })).toBeVisible();
      expect(screen.getByLabelText("当前地址")).toHaveTextContent("/orders/" + orderId);
  });

  it.each([1600, 390])("honors an explicit hidden associated-order field at %i pixels without reintroducing it in metadata", async width => {
    mobileMedia(width);
    localStorage.setItem("perpay.table-columns.v2.administrator-ledger", JSON.stringify({ order: false }));
    pageResponse([groupedLedger]);
    mount("/reconciliation", <Reconciliation />);
    await screen.findByRole("link", { name: groupedLedger.external_event_id });
    expect(screen.queryByRole("link", { name: "查看订单：" + order.merchant_order_no })).not.toBeInTheDocument();
    expect(screen.queryByText(order.merchant_order_no, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "当前关联订单" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.administrator-ledger")!)).toEqual({ order: false });
  });

  it("retains complete merchant numbers in metadata and uses compact embedded overview rows", async () => {
    pageResponse([longOrder]);
    const view = mount("/orders", <Orders />);
    const number = await screen.findByText(longOrder.merchant_order_no, {
      exact: true,
    });
    expect(number).toHaveClass("list-code");
    expect(number).toHaveAttribute("title", longOrder.merchant_order_no);
    expect(screen.getByRole("table")).toHaveAttribute("data-density", "compact");
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
