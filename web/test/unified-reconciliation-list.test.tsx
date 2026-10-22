import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { Toaster } from "../src/components/ui/toast";
import Reconciliation from "../src/pages/Reconciliation";
import { groupedLedger } from "./ledger-fixtures";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";

function Frame() {
  const location = useLocation();
  const [, setSearch] = useSearchParams();
  return <><button onClick={() => setSearch(current => { const next = new URLSearchParams(current); next.set("selected_site", "remembered-b"); return next; }, { state: location.state })}>切换网站记忆</button><output aria-label="查询地址">{location.pathname + location.search}</output><Outlet /></>;
}

function mount(path = "/reconciliation") {
  const router = createMemoryRouter([{ element: <Frame />, children: [
    { path: "/reconciliation", element: <Reconciliation /> },
    { path: "/reconciliation/transactions/:ledgerEntryId", element: <h1>流水与对账详情</h1> },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><Toaster><RouterProvider router={router} /></Toaster></QueryClientProvider>);
  return router;
}

describe("unified transaction reconciliation list", () => {
  beforeEach(() => { localStorage.clear(); mobileMedia(1440); });

  it("opens one transaction list with current order and reversal history together", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      return json({ data: [{ ...groupedLedger, reversed_match_count: 2 }], environment: "PRODUCTION", page: { next_cursor: null } });
    }));
    mount();
    const table = await screen.findByRole("table", { name: "支付宝流水" });
    expect(screen.getByRole("tab", { name: "支付宝流水" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "收款关联" })).not.toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("已关联", { exact: true })).toBeVisible();
    expect(within(table).getByText("2 条已撤销关联")).toBeVisible();
    expect(within(table).getByRole("link", { name: "查看订单：" + groupedLedger.active_match!.merchant_order_no })).toBeVisible();
    const product = within(table).getByText(groupedLedger.active_match!.product_name);
    expect(product).toBeVisible();
    expect(product).toHaveClass("ledger-order-line");
    expect(product).toHaveAttribute("title", groupedLedger.active_match!.product_name);
    expect(within(table).getByRole("link", { name: "查看订单：" + groupedLedger.active_match!.merchant_order_no })).toHaveClass("ledger-order-line");
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/api/admin/v1/ledger/entries"]);
    expect(new URL(requests[0]!.url).searchParams.has("association_status")).toBe(false);
    expect(requests.every(request => request.method === "GET")).toBe(true);
    await userEvent.click(within(table).getByRole("link", { name: groupedLedger.external_event_id }));
    expect(await screen.findByRole("heading", { name: "流水与对账详情" })).toBeVisible();
  });

  it("keeps current association and reversal-history filters independent and resets pagination", async () => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(new URL(request.url));
      return json({ data: [groupedLedger], environment: "PRODUCTION", page: { next_cursor: null } });
    }));
    const router = mount("/reconciliation?cursor=old&page=3&occurred_from=2026-10-01&occurred_to=2026-10-02&associated_from=2026-10-03&associated_to=2026-10-04");
    await screen.findByRole("table");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "关联状态筛选" }));
    await user.click(await screen.findByRole("option", { name: "已关联" }));
    await waitFor(() => expect(requests.at(-1)!.searchParams.get("association_status")).toBe("MATCHED"));
    await user.click(screen.getByRole("combobox", { name: "撤销记录筛选" }));
    await user.click(await screen.findByRole("option", { name: "有撤销记录" }));
    await waitFor(() => expect(requests.at(-1)!.searchParams.get("has_reversals")).toBe("true"));
    const query = requests.at(-1)!.searchParams;
    expect(query.get("association_status")).toBe("MATCHED");
    expect(query.get("occurred_from")).toBe("2026-10-01");
    expect(query.get("associated_from")).toBe("2026-10-03");
    expect(query.has("cursor") || query.has("page")).toBe(false);
    expect(router.state.location.search).not.toContain("cursor=");
    expect(screen.getByRole("group", { name: "交易日期筛选" })).toHaveTextContent("2026-10-01 至 2026-10-02");
    expect(screen.getByRole("group", { name: "关联日期筛选" })).toHaveTextContent("2026-10-03 至 2026-10-04");
  });

  it.each(["SETTLED", "REVERSED"])("migrates the old %s match query before fetching any rows", async status => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(new URL(request.url)); return json({ data: [], environment: "PRODUCTION", page: { next_cursor: null } }); }));
    const router = mount("/reconciliation?tab=matches&status=" + status + "&sort_by=created_at&sort_order=asc&created_from=2026-10-01&created_to=2026-10-02&cursor=old&page=4&selected_site=remembered");
    await screen.findByRole("heading", { name: "暂无符合条件的流水" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/api/admin/v1/ledger/entries");
    expect(requests[0]!.searchParams.get("sort_by")).toBe("associated_at");
    expect(requests[0]!.searchParams.get("associated_from")).toBe("2026-10-01");
    expect(requests[0]!.searchParams.get(status === "SETTLED" ? "association_status" : "has_reversals")).toBe(status === "SETTLED" ? "MATCHED" : "true");
    expect(requests[0]!.searchParams.has("cursor")).toBe(false);
    expect(router.state.location.search).toContain("selected_site=remembered");
  });

  it.each([
    "sort_by=created_at",
    "created_from=2026-10-01&created_to=2026-10-02",
    "sort_by=created_at&created_from=2026-10-01&created_to=2026-10-02",
  ])("migrates an old default match bookmark without a tab before fetching: %s", async oldFilters => {
    const requests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(new URL(request.url)); return json({ data: [], environment: "PRODUCTION", page: { next_cursor: null } }); }));
    const router = mount("/reconciliation?" + oldFilters + "&q=商品%26订单&sort_order=asc&cursor=old&page=2&selected_site=remembered");
    await screen.findByRole("heading", { name: "暂无符合条件的流水" });
    expect(requests).toHaveLength(1);
    const query = requests[0]!.searchParams;
    expect(query.get("association_status")).toBe("MATCHED");
    expect(query.get("sort_by")).toBe("associated_at");
    expect(query.get("sort_order")).toBe("asc");
    expect(query.get("q")).toBe("商品&订单");
    expect(query.get("associated_from")).toBe(oldFilters.includes("created_from") ? "2026-10-01" : null);
    expect(query.get("associated_to")).toBe(oldFilters.includes("created_to") ? "2026-10-02" : null);
    expect(query.has("cursor") || query.has("page")).toBe(false);
    expect(router.state.location.search).toContain("selected_site=remembered");
    expect(new URLSearchParams(router.state.location.search).has("page")).toBe(false);
  });

  it("retains the transaction row and search draft when the remembered website changes", async () => {
    const fetchMock = vi.fn(async () => json({ data: [groupedLedger], environment: "PRODUCTION", page: { next_cursor: null } }));
    vi.stubGlobal("fetch", fetchMock);
    mount("/reconciliation?selected_site=remembered-a");
    const row = await screen.findByRole("link", { name: groupedLedger.external_event_id });
    fireEvent.change(screen.getByRole("searchbox", { name: "支付宝流水关键词搜索" }), { target: { value: "未提交搜索" } });
    fireEvent.click(screen.getByRole("button", { name: "切换网站记忆" }));
    await waitFor(() => expect(screen.getByLabelText("查询地址")).toHaveTextContent("selected_site=remembered-b"));
    expect(screen.getByRole("link", { name: groupedLedger.external_event_id })).toBe(row);
    expect(screen.getByRole("searchbox", { name: "支付宝流水关键词搜索" })).toHaveValue("未提交搜索");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([1440, 390])("preserves manual association and focus recovery at %i pixels", async width => {
    mobileMedia(width);
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [], environment: "PRODUCTION", page: { next_cursor: null } })));
    mount();
    await screen.findByRole("heading", { name: "暂无支付宝流水" });
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: width < 1024 ? "更多对账操作" : "人工关联收款" });
    await user.click(trigger);
    if (width < 1024) await user.click(await screen.findByRole("menuitem", { name: "人工关联收款" }));
    const dialog = await screen.findByRole("dialog", { name: "人工关联收款" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "人工关联收款" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not retain old transaction data across a changed association filter", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn((request: Request) => new URL(request.url).searchParams.has("association_status") ? pending : Promise.resolve(json({ data: [groupedLedger], page: { next_cursor: null } }))));
    mount();
    const old = await screen.findByRole("link", { name: groupedLedger.external_event_id });
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("combobox", { name: "关联状态筛选" }));
      await user.click(await screen.findByRole("option", { name: "未关联" }));
      await waitFor(() => expect(old).not.toBeInTheDocument());
      await act(async () => { finish(json({ data: [], page: { next_cursor: null } })); });
      expect(await screen.findByRole("heading", { name: "暂无符合条件的流水" })).toBeVisible();
    } finally { finish(json({ data: [], page: { next_cursor: null } })); }
  });
});
