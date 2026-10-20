import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSummary } from "../src/api/client";
import { Link } from "../src/navigation";
import Ledger from "../src/pages/Ledger";
import LedgerDetail from "../src/pages/LedgerDetail";
import { json, ledger, ledgerId, orderId } from "./fixtures";
import { mobileMedia } from "./mobile-media";

const secondSourceId = "33333333-3333-4333-8333-333333333333";
const match: AdminLedgerMatch & { status: "SETTLED" } = { payment_match_id: "44444444-4444-4444-8444-444444444444", ledger_entry_id: secondSourceId, order_id: orderId, merchant_order_no: "real-order", product_name: "实际关联商品", api_client_id: "site-a", site_name: "网站甲", evidence_type: "MANUAL", status: "SETTLED", created_at: ledger.created_at, resolved_at: ledger.created_at };
const entry: AdminLedgerSummary = { ...ledger, environment: "PRODUCTION", states: ["ALLOCATED"], source_record_count: 2, content_consistent: true, has_conflicts: false, active_match_count: 1, active_match: match, memo: "本地流水备注", other_account: "付款用户" };
const source = (id: string) => ({ ...ledger, ledger_entry_id: id, app_id: "app-a", environment: "PRODUCTION" as const, provider_account_key: "account-a", raw_event_id: id });
const detail: AdminLedgerDetail = { ...entry, sources: [source(ledgerId), source(secondSourceId)], matches: [match, { ...match, payment_match_id: "55555555-5555-4555-8555-555555555555", status: "REVERSED", resolved_at: ledger.updated_at }], conflicts: [] };

function Frame() {
  const location = useLocation();
  const [, setSearch] = useSearchParams();
  return <><button onClick={() => setSearch(current => { const next = new URLSearchParams(current); next.set("selected_site", "site-b"); return next; }, { state: location.state })}>切换网站记忆</button><output aria-label="位置">{location.pathname + location.search}</output><Outlet /></>;
}
function mount(path = "/ledger") {
  const router = createMemoryRouter([{ element: <Frame />, children: [{ path: "/ledger", element: <Ledger /> }, { path: "/ledger/:ledgerEntryId", element: <LedgerDetail /> }, { path: "/orders/:orderId", element: <Link to="/ledger">订单占位</Link> }] }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("administrator ledger pages", () => {
  let fetchMock: Mock<(request: Request) => Promise<Response>>;
  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/admin/v1/ledger/entries") return json({ data: [entry], environment: "PRODUCTION", page: { next_cursor: url.searchParams.has("cursor") ? null : "page-two" } });
      if (url.pathname === "/api/admin/v1/ledger/entries/" + ledgerId) return json({ data: detail });
      throw new Error("Unexpected endpoint: " + url.pathname);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("queries global local records and retains the same row, page and draft when website selection changes", async () => {
    const router = mount("/ledger?direction=CREDIT&selected_site=site-a");
    await screen.findByRole("link", { name: entry.external_event_id });
    expect(screen.getByRole("link", { name: "查看订单：real-order" })).toHaveAttribute("href", "/orders/" + orderId);
    expect(screen.getByRole("combobox", { name: "交易日期范围" })).toHaveTextContent("全部");
    const first = new URL(fetchMock.mock.calls[0]![0].url);
    expect(first.searchParams.get("limit")).toBe("20");
    expect(first.searchParams.get("sort_order")).toBe("desc");
    expect(first.searchParams.has("selected_site")).toBe(false);
    expect(first.searchParams.has("occurred_from")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getByRole("navigation", { name: "列表分页" })).toHaveTextContent("第 2 页"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const retainedRow = screen.getByRole("link", { name: entry.external_event_id });
    fireEvent.change(screen.getByRole("searchbox", { name: "支付宝流水关键词搜索" }), { target: { value: "未提交的关键词" } });
    fireEvent.click(screen.getByRole("button", { name: "切换网站记忆" }));
    await waitFor(() => expect(router.state.location.search).toContain("selected_site=site-b"));
    expect(screen.getByRole("link", { name: entry.external_event_id })).toBe(retainedRow);
    expect(screen.getByRole("searchbox", { name: "支付宝流水关键词搜索" })).toHaveValue("未提交的关键词");
    expect(router.state.location.search).toContain("cursor=page-two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps full identifiers and order navigation available when changing from the desktop table to narrow summaries", async () => {
    mobileMedia(1440);
    let width = 1088;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-business-table") ? DOMRect.fromRect({ width, height: 200 }) : original.call(this);
    });
    const externalEventId = "202610222000100000123456";
    fetchMock.mockImplementation(async () => json({ data: [{ ...entry, external_event_id: externalEventId }], environment: "PRODUCTION", page: { next_cursor: null } }));
    mount();
    const table = await screen.findByRole("table", { name: "支付宝流水" });
    expect(table).toHaveClass("ledger-table");
    expect(within(table).getByRole("link", { name: externalEventId })).toHaveTextContent(externalEventId);
    expect(screen.getByRole("link", { name: "账本冲突" })).toHaveAttribute("href", "/reconciliation?tab=conflicts");
    expect(table.querySelector('thead [data-column-id="memo"]')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "显示列" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "备注" }));
    expect(within(table).getByRole("columnheader", { name: "备注" })).toBeVisible();
    await user.keyboard("{Escape}");
    act(() => { width = 600; window.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const summary = await screen.findByRole("listitem");
    expect(within(summary).getByRole("link", { name: externalEventId })).toHaveTextContent(externalEventId);
    expect(within(summary).getByRole("link", { name: "查看订单：real-order" })).toHaveAttribute("href", "/orders/" + orderId);
    expect(within(summary).getByText("本地流水备注")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates amount precision and applies zero boundaries while clearing pagination", async () => {
    const router = mount("/ledger?cursor=page-two&page=2");
    await screen.findByRole("link", { name: entry.external_event_id });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "金额范围" }));
    const dialog = await screen.findByRole("dialog", { name: "金额范围" });
    await user.type(within(dialog).getByLabelText("最低金额（元）"), "0.001");
    await user.click(within(dialog).getByRole("button", { name: "应用金额" }));
    expect(within(dialog).getByText(/最多保留两位小数/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.clear(within(dialog).getByLabelText("最低金额（元）"));
    await user.type(within(dialog).getByLabelText("最低金额（元）"), "0");
    await user.type(within(dialog).getByLabelText("最高金额（元）"), "0");
    await user.click(within(dialog).getByRole("button", { name: "应用金额" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const url = new URL(fetchMock.mock.calls[1]![0].url);
    expect(url.searchParams.get("min_amount_cents")).toBe("0");
    expect(url.searchParams.get("max_amount_cents")).toBe("0");
    expect(router.state.location.search).not.toMatch(/cursor=|page=/);
  });

  it("blocks invalid URL filters before making requests and allows clearing them", async () => {
    mount("/ledger?min_amount_cents=1.01");
    expect(await screen.findByText("金额筛选参数须为非负整数分。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await screen.findByRole("link", { name: entry.external_event_id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores the cached list position when its background refresh fails", async () => {
    queryClient.setQueryDefaults(["administrator-ledger"], { staleTime: 0, retry: false });
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const originalFetch = fetchMock.getMockImplementation()!;
    let refreshFails = false;
    fetchMock.mockImplementation(async (request: Request) => {
      if (refreshFails && new URL(request.url).pathname === "/api/admin/v1/ledger/entries") return json({ error: { code: "temporarily_unavailable", message: "暂不可用" } }, 503);
      return originalFetch(request);
    });
    mount("/ledger?direction=CREDIT");
    const user = userEvent.setup();
    const link = await screen.findByRole("link", { name: entry.external_event_id });
    vi.stubGlobal("scrollY", 725);
    await user.click(link);
    await screen.findByRole("heading", { name: "采集来源（2）" });
    refreshFails = true;
    vi.stubGlobal("scrollY", 0);
    await user.click(screen.getByRole("link", { name: /^(?:返回)?支付宝流水$/ }));
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ["administrator-ledger"] })[0]?.state.status).toBe("error"));
    expect(screen.getByRole("link", { name: entry.external_event_id })).toBeVisible();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 725, left: 0, behavior: "instant" }));
  });

  it("displays every source and reversed match with links to real evidence IDs", async () => {
    mount("/ledger/" + ledgerId);
    expect(await screen.findByRole("heading", { name: "采集来源（2）" })).toBeVisible();
    const sourceLinks = screen.getAllByRole("link", { name: "查看原始凭据与处理" });
    expect(sourceLinks.map(link => link.getAttribute("href"))).toEqual(["/reconciliation/ledger/" + ledgerId, "/reconciliation/ledger/" + secondSourceId]);
    expect(screen.getByText("已撤销")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "查看关联凭据" }).every(link => link.getAttribute("href") === "/reconciliation/ledger/" + secondSourceId)).toBe(true);
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    expect(screen.getByText("当前实际关联")).toBeVisible();
    const settledCard = screen.getByText("当前实际关联").closest<HTMLElement>('[data-slot="card"]')!;
    const reversalField = within(settledCard).getByText("撤销时间").parentElement!;
    expect(within(reversalField).getByText("—")).toBeVisible();
    expect(reversalField.querySelector("time")).toBeNull();
  });

  it("renders disputed facts without inventing zero or selecting a settled match", async () => {
    const variant: AdminLedgerDetail = { ...detail, amount_cents: null, direction: null, occurred_at: null, content_consistent: false, has_conflicts: true, active_match_count: 2, active_match: null, conflicts: [{ conflict_id: "66666666-6666-4666-8666-666666666666", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "OPEN", existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: null }] };
    fetchMock.mockImplementation(async () => json({ data: variant }));
    mount("/ledger/" + ledgerId);
    expect(await screen.findByText("流水需要核查")).toBeVisible();
    expect(screen.getAllByText("有争议").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("多条生效关联 · 请核查")).toBeVisible();
    expect(screen.queryByText("当前实际关联")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看冲突记录" })).toHaveAttribute("href", "/reconciliation/conflicts/66666666-6666-4666-8666-666666666666");
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
  });

  it("keeps absent nullable text neutral when only the amount differs between sources", async () => {
    const variant: AdminLedgerDetail = { ...detail, amount_cents: null, other_account: null, memo: null, provider_order_no: null, merchant_order_no: null, content_consistent: false, has_conflicts: true, sources: [{ ...source(ledgerId), amount_cents: 101 }, { ...source(secondSourceId), amount_cents: 102 }] };
    fetchMock.mockImplementation(async () => json({ data: variant }));
    mount("/ledger/" + ledgerId);
    const card = (await screen.findByRole("heading", { name: entry.external_event_id })).closest<HTMLElement>('[data-slot="card"]')!;
    for (const title of ["对方", "备注", "支付宝订单号", "流水商户订单号"]) {
      expect(within(within(card).getByText(title).parentElement!).getByText("—")).toBeVisible();
    }
    expect(within(card).getAllByText("有争议")).toHaveLength(1);
    expect(screen.queryByText("这笔流水存在账本冲突，请从冲突记录查看处理情况。")).not.toBeInTheDocument();
  });
});
