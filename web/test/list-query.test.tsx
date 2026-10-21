import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem, type LedgerConflict } from "../src/api/client";
import { Link, useDetailBack } from "../src/navigation";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { BusinessTable } from "../src/components/business-table";
import Orders from "../src/pages/Orders";
import Notifications from "../src/pages/Notifications";
import Reconciliation from "../src/pages/Reconciliation";
import WorkItems from "../src/pages/WorkItems";
import { delivery, financialException } from "./detail-fixtures";
import { groupedLedger } from "./ledger-fixtures";
import { json, ledgerId, order } from "./fixtures";
import { mobileMedia } from "./mobile-media";
function Location() {
  const l = useLocation();
  return <output aria-label="查询地址">{l.pathname + l.search}</output>;
}
function Back() {
  const back = useDetailBack("/orders", "订单");
  return (
    <Link to={back.to} state={back.state}>
      返回列表
    </Link>
  );
}
function mount(path: string, element: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <TestPaymentProvider>
          <Routes>
            <Route path={path.split("?")[0]} element={element} />
            <Route path="/orders/:orderId" element={<Back />} />
          </Routes>
          <Location />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const conflict: LedgerConflict = {
  reminder_ignored: false,
  conflict_id: ledgerId,
  provider_account_key: "primary",
  conflict_type: "DUPLICATE_EXTERNAL_ID",
  raw_page_id: null,
  raw_event_id: null,
  existing_ledger_entry_id: ledgerId,
  external_event_id: "ledger-sort-example",
  existing_semantic_fingerprint: "a".repeat(64),
  incoming_semantic_fingerprint: "b".repeat(64),
  details: {},
  status: "OPEN",
  resolution: null,
  resolution_action: null,
  resolution_operation_id: null,
  resolution_fingerprint: null,
  conflict_fingerprint: "c".repeat(64),
  created_at: order.created_at,
  resolved_at: null,
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
const cases = [
  {
    path: "/orders",
    element: <Orders />,
    label: "订单关键词搜索",
    endpoint: "/orders",
    sort: "应付金额",
    field: "payable_amount_cents",
    data: [order],
  },
  {
    path: "/notifications",
    element: <Notifications />,
    label: "通知关键词搜索",
    endpoint: "/webhooks/deliveries",
    sort: "尝试次数",
    field: "attempt_count",
    data: [{ ...delivery.delivery, event: delivery.event, target: delivery.target }],
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    label: "支付宝流水关键词搜索",
    endpoint: "/ledger/entries",
    sort: "交易金额",
    field: "amount_cents",
    data: [groupedLedger],
  },
  {
    path: "/reconciliation",
    element: <Reconciliation />,
    label: "支付宝流水关键词搜索",
    endpoint: "/ledger/entries",
    sort: "交易时间",
    field: "occurred_at",
    data: [groupedLedger],
  },
  {
    path: "/reconciliation?tab=conflicts",
    element: <Reconciliation />,
    label: "对账关键词搜索",
    endpoint: "/ledger/conflicts",
    sort: "支付宝流水号",
    field: "external_event_id",
    data: [conflict],
  },
  {
    path: "/reconciliation?tab=exceptions",
    element: <Reconciliation />,
    label: "对账关键词搜索",
    endpoint: "/reconciliation/exceptions",
    sort: "发现时间",
    field: "created_at",
    data: [financialException],
  },
  {
    path: "/work-items",
    element: <WorkItems />,
    label: "提醒关键词搜索",
    endpoint: "/work-items",
    sort: "创建时间",
    field: "created_at",
    data: [reminder],
  },
];
describe("server-driven business queries", () => {
  beforeEach(() => {
    localStorage.clear();
    mobileMedia(1600);
  });

  it.each([1600, 390])("keeps stopped-notification filters and queries aligned at %i pixels", async (width) => {
    mobileMedia(width);
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      const stopped = new URL(request.url).searchParams.get("status") === "DEAD_LETTER";
      return json({ data: [{
        ...delivery.delivery,
        status: stopped ? "DEAD_LETTER" : "RETRY_WAIT",
        next_attempt_at: stopped ? null : delivery.delivery.next_attempt_at,
        dead_lettered_at: stopped ? delivery.delivery.updated_at : null,
        event: delivery.event,
        target: delivery.target,
      }], page: { next_cursor: null } });
    }));
    mount("/notifications?status=RETRY_WAIT&cursor=old-page&page=3&source=overview", <Notifications />);
    const user = userEvent.setup();
    await screen.findByRole("searchbox", { name: "通知关键词搜索" });
    if (width < 1024) {
      await user.click(screen.getByRole("button", { name: /^筛选与排序/ }));
      const sheet = await screen.findByRole("dialog", { name: "筛选与排序" });
      await user.click(within(sheet).getByRole("combobox", { name: "通知状态" }));
      await user.click(await screen.findByRole("option", { name: "已停止重试" }));
      expect(within(sheet).getByRole("combobox", { name: "通知状态" })).toHaveTextContent("已停止重试");
      await user.click(within(sheet).getByRole("button", { name: "应用" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "筛选与排序" })).not.toBeInTheDocument());
    } else {
      await user.click(screen.getByRole("combobox", { name: "通知状态筛选" }));
      await user.click(await screen.findByRole("option", { name: "已停止重试" }));
      expect(screen.getByRole("combobox", { name: "通知状态筛选" })).toHaveTextContent("已停止重试");
    }
    await waitFor(() => {
      const query = new URL(requests.at(-1)!.url).searchParams;
      expect(query.get("status")).toBe("DEAD_LETTER");
      expect(query.has("cursor")).toBe(false);
    });
    expect(screen.getByRole("button", { name: "已停止重试" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("查询地址")).toHaveTextContent("source=overview");
    expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("page=");
    if (width < 1024) {
      expect(screen.getByLabelText("当前查询条件")).toHaveTextContent("通知状态：已停止重试");
    }
    await user.click(screen.getByRole("button", { name: "等待重试" }));
    await waitFor(() => expect(new URL(requests.at(-1)!.url).searchParams.get("status")).toBe("RETRY_WAIT"));
    expect(screen.getByRole("button", { name: "已停止重试" })).toHaveAttribute("aria-pressed", "false");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each(cases)(
    "submits $endpoint keywords only on Enter and resets cursors from the $sort header",
    async ({ path, element, label, endpoint, sort, field, data }) => {
      const fetch = vi.fn(async () =>
        json({ data, page: { next_cursor: "next-page" } }),
      );
      vi.stubGlobal("fetch", fetch);
      mount(
        path +
          (path.includes("?") ? "&" : "?") +
          "cursor=old-page&page=3&source=overview",
        element,
      );
      const user = userEvent.setup();
      const input = await screen.findByRole("searchbox", { name: label });
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      const before = fetch.mock.calls.length;
      await user.type(input, "  中文%_  ");
      expect(fetch.mock.calls.length).toBe(before);
      await user.keyboard("{Enter}");
      await waitFor(() => {
        const request = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
        const url = new URL(request.url);
        expect(url.pathname).toBe("/api/admin/v1" + endpoint);
        expect(url.searchParams.get("q")).toBe("中文%_");
        expect(url.searchParams.has("cursor")).toBe(false);
      });
      expect(screen.getByLabelText("查询地址")).toHaveTextContent(
        "source=overview",
      );
      // Search already cleared the original cursor. Visit another page so the
      // following header click must independently reset pagination.
      await user.click(await screen.findByRole("button", { name: "下一页" }));
      await waitFor(() => {
        const request = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
        expect(new URL(request.url).searchParams.get("cursor")).toBe("next-page");
      });
      expect(screen.getByLabelText("查询地址")).toHaveTextContent("page=2");
      const table = await screen.findByRole("table");
      const header = within(table).getByRole("button", { name: sort });
      await user.click(header);
      await waitFor(() => {
        const request = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
        const query = new URL(request.url).searchParams;
        expect(query.get("sort_by")).toBe(field);
        expect(query.get("q")).toBe("中文%_");
        expect(query.has("cursor")).toBe(false);
      });
      expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("cursor");
      expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("page=");
      const firstRequest = (fetch.mock.calls.at(-1) as unknown as [Request])[0];
      const firstDirection = new URL(firstRequest.url).searchParams.get("sort_order");
      expect(["asc", "desc"]).toContain(firstDirection);
      expect(header.closest("th")).toHaveAttribute("aria-sort", firstDirection === "asc" ? "ascending" : "descending");
      await user.click(header);
      await waitFor(() => {
        const query = new URLSearchParams(screen.getByLabelText("查询地址").textContent!.split("?")[1]);
        expect(query.get("sort_order")).toBe(firstDirection === "asc" ? "desc" : "asc");
      });
      expect(header.closest("th")).toHaveAttribute("aria-sort", firstDirection === "asc" ? "descending" : "ascending");
      expect(screen.getByLabelText("查询地址")).toHaveTextContent("source=overview");
      await user.click(screen.getByRole("button", { name: "清除搜索" }));
      await waitFor(() => expect(screen.getByRole("searchbox", { name: label })).toHaveValue(""));
      const cleared = new URLSearchParams(screen.getByLabelText("查询地址").textContent!.split("?")[1]);
      expect(cleared.has("q")).toBe(false);
      expect(cleared.get("sort_by")).toBe(field);
      expect(cleared.get("source")).toBe("overview");
    },
  );
  it("does not apply TanStack client sorting or hide the required identifier", async () => {
    const setSort = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <BusinessTable
          id="unit-manual-sort"
          items={[
            { id: "b", amount: 30 },
            { id: "a", amount: 10 },
          ]}
          rowId={(r) => r.id}
          control={{
            query: { q: "", sortBy: "amount", sortOrder: "asc" },
            setSort,
            setKeyword: vi.fn(),
            update: vi.fn(),
            clear: vi.fn(),
          }}
          columns={[
            { id: "id", label: "编号", hideable: false, cell: (r) => r.id },
            {
              id: "amount",
              sortBy: "amount",
              label: "金额",
              cell: (r) => r.amount,
            },
          ]}
        />
      </MemoryRouter>,
    );
    const values = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]!.textContent);
    expect(values()).toEqual(["b", "a"]);
    await user.click(screen.getByRole("button", { name: "金额" }));
    expect(setSort).toHaveBeenCalledWith("amount", "desc");
    expect(values()).toEqual(["b", "a"]);
    await user.click(screen.getByRole("button", { name: "显示列" }));
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "编号" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "金额" }),
    );
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("columnheader", { name: "金额" }),
    ).not.toBeInTheDocument();
    expect(values()).toEqual(["b", "a"]);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
  it("returns from a detail to the exact searched and sorted page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        json({
          data: [
            {
              ...order,
              product_name: new URL(request.url).searchParams.has("cursor")
                ? "第二页结果"
                : "第一页结果",
            },
          ],
          page: { next_cursor: "next-page" },
        }),
      ),
    );
    const user = userEvent.setup();
    mount(
      "/orders?q=结果&sort_by=payable_amount_cents&sort_order=desc",
      <Orders />,
    );
    await user.click(await screen.findByRole("button", { name: "下一页" }));
    await user.click(await screen.findByRole("link", { name: "第二页结果" }));
    await user.click(screen.getByRole("link", { name: "返回列表" }));
    expect(
      await screen.findByRole("link", { name: "第二页结果" }),
    ).toBeVisible();
    expect(screen.getByLabelText("查询地址")).toHaveTextContent(
      "cursor=next-page",
    );
    expect(screen.getByLabelText("查询地址")).toHaveTextContent(
      "sort_by=payable_amount_cents",
    );
    expect(
      screen.getByRole("searchbox", { name: "订单关键词搜索" }),
    ).toHaveValue("结果");
  });
  it("keeps the latest keyword result when asynchronous responses finish out of order", async () => {
    const finishes = new Map<string, (value: Response) => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn((request: Request) => {
        const q = new URL(request.url).searchParams.get("q");
        return q
          ? new Promise<Response>((resolve) => finishes.set(q, resolve))
          : Promise.resolve(
              json({ data: [order], page: { next_cursor: null } }),
            );
      }),
    );
    const user = userEvent.setup();
    mount("/orders", <Orders />);
    await screen.findByRole("link", { name: order.product_name });
    const input = screen.getByRole("searchbox", { name: "订单关键词搜索" });
    await user.type(input, "旧{Enter}");
    await user.clear(input);
    await user.type(input, "新{Enter}");
    await waitFor(() => expect(finishes.has("新")).toBe(true));
    await act(async () => {
      finishes.get("新")!(
        json({
          data: [{ ...order, product_name: "新结果" }],
          page: { next_cursor: null },
        }),
      );
    });
    expect(await screen.findByRole("link", { name: "新结果" })).toBeVisible();
    await act(async () => {
      finishes.get("旧")!(
        json({
          data: [{ ...order, product_name: "旧结果" }],
          page: { next_cursor: null },
        }),
      );
    });
    expect(
      screen.queryByRole("link", { name: "旧结果" }),
    ).not.toBeInTheDocument();
  });
  it("validates the 100 Unicode character limit without submitting the draft", async () => {
    const fetch = vi.fn(async () =>
      json({ data: [], page: { next_cursor: null } }),
    );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount("/orders", <Orders />);
    const input = screen.getByRole("searchbox", { name: "订单关键词搜索" });
    await user.click(input);
    await user.paste("😀".repeat(101));
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("关键词最多 100 个字符。"),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("q=");
  });
});


describe("creation date filters", () => {
  it.each([{path:"/orders",element:<Orders/>},{path:"/notifications",element:<Notifications/>}])("submits paired dates and clears stale cursors at $path", async ({path,element})=>{
    const fetch=vi.fn(async ()=>json({data:[],page:{next_cursor:null}}));vi.stubGlobal("fetch",fetch);
    mount(path+"?cursor=old&page=3&q=商品",element);
    const user=userEvent.setup();
    await user.click(screen.getByRole("combobox",{name:"创建日期范围"}));
    await user.click(await screen.findByRole("option",{name:"自定义日期"}));
    const dialog=await screen.findByRole("dialog",{name:"自定义创建日期"});
    fireEvent.change(within(dialog).getByLabelText("开始日期"),{target:{value:"2026-09-30"}});
    fireEvent.change(within(dialog).getByLabelText("结束日期"),{target:{value:"2026-10-01"}});
    await user.click(within(dialog).getByRole("button",{name:"应用日期"}));
    await waitFor(()=>expect(screen.getByLabelText("查询地址")).toHaveTextContent("created_to=2026-10-01"));
    expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("cursor=");
    const requests=fetch.mock.calls.map(args=>new Request(...args as unknown as [RequestInfo,RequestInit]));
    expect(requests.some(r=>r.url.includes("created_from=2026-09-30")&&r.url.includes("created_to=2026-10-01"))).toBe(true);
    if(path==="/notifications") expect(screen.queryByRole("button",{name:"导出 CSV"})).not.toBeInTheDocument();
  });
});


describe("custom date defaults", () => {
  it.each([{ path: "/orders", element: <Orders /> }, { path: "/notifications", element: <Notifications /> }])(
    "defaults to today's Beijing date on opening without applying filters at $path",
    async ({ path, element }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-31T16:05:00Z"));
      try {
        vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], page: { next_cursor: null } })));
        mount(path + "?cursor=old&page=3", element);
        const user = userEvent.setup();
        async function open() {
          await user.click(screen.getByRole("combobox", { name: "创建日期范围" }));
          await user.click(await screen.findByRole("option", { name: "自定义日期" }));
          return screen.findByRole("dialog", { name: "自定义创建日期" });
        }
        let dialog = await open();
        expect(within(dialog).getByLabelText("开始日期")).toHaveValue("2027-01-01");
        expect(within(dialog).getByLabelText("结束日期")).toHaveValue("2027-01-01");
        expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("created_from=");
        await user.click(within(dialog).getByRole("button", { name: "取消" }));
        expect(screen.getByLabelText("查询地址")).toHaveTextContent("cursor=old");
        clock.mockReturnValue(Date.parse("2027-01-01T16:05:00Z"));
        dialog = await open();
        expect(within(dialog).getByLabelText("开始日期")).toHaveValue("2027-01-02");
        await user.click(within(dialog).getByRole("button", { name: "应用日期" }));
        expect(screen.getByLabelText("查询地址")).toHaveTextContent("created_from=2027-01-02");
        expect(screen.getByLabelText("查询地址")).not.toHaveTextContent("cursor=");
      } finally { clock.mockRestore(); }
    },
  );
  it("preserves an existing range from a previous year", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], page: { next_cursor: null } })));
    mount("/orders?created_from=2024-12-15&created_to=2025-01-03", <Orders />);
    await userEvent.click(screen.getByRole("button", { name: "修改日期" }));
    const dialog = await screen.findByRole("dialog", { name: "自定义创建日期" });
    expect(within(dialog).getByLabelText("开始日期")).toHaveValue("2024-12-15");
    expect(within(dialog).getByLabelText("结束日期")).toHaveValue("2025-01-03");
  });
});
