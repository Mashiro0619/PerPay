import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { queryClient, type AdminLedgerDetail, type AdminLedgerMatch, type AdminLedgerSummary } from "../src/api/client";
import { Link } from "../src/navigation";
import Ledger from "../src/pages/Ledger";
import LedgerDetail from "../src/pages/LedgerDetail";
import { alipayAccount, json, ledger, ledgerId, orderId } from "./fixtures";
import { mobileMedia } from "./mobile-media";
import { paymentMatch } from "./detail-fixtures";
import { preciseDateTime } from "../src/lib/format";

const secondSourceId = "33333333-3333-4333-8333-333333333333";
const match: AdminLedgerMatch & { status: "SETTLED" } = { payment_match_id: "44444444-4444-4444-8444-444444444444", ledger_entry_id: secondSourceId, order_id: orderId, merchant_order_no: "real-order", product_name: "实际关联商品", api_client_id: "site-a", site_name: "网站甲", evidence_type: "MANUAL", status: "SETTLED", created_at: ledger.created_at, resolved_at: ledger.created_at };
const entry: AdminLedgerSummary = { ...ledger, environment: "PRODUCTION", states: ["ALLOCATED"], source_record_count: 2, content_consistent: true, has_conflicts: false, active_match_count: 1, reversed_match_count: 1, last_associated_at: match.created_at, last_handled_at: match.resolved_at, active_match: match, memo: "本地流水备注", other_account: "付款用户" };
const source = (id: string) => ({ ...ledger, state: "ALLOCATED" as const, ledger_entry_id: id, app_id: "app-a", environment: "PRODUCTION" as const, provider_account_key: "account-a", raw_event_id: id });
const reversedMatchId = "55555555-5555-4555-8555-555555555555";
const detail: AdminLedgerDetail = { ...entry, sources: [source(ledgerId), source(secondSourceId)], matches: [match, { ...match, payment_match_id: reversedMatchId, status: "REVERSED", resolved_at: ledger.updated_at }], conflicts: [] };
const section = (id: string) => document.querySelector<HTMLElement>('[data-detail-section="' + id + '"]');
const record = (id: string) => document.getElementById(id)!;

function detailResponse(request: Request, value: AdminLedgerDetail) {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/v1/ledger/entries/" + ledgerId) return json({ data: value });
  if (url.pathname.endsWith("/candidates")) return json({ data: [] });
  const item = value.matches.find(item => url.pathname === "/api/admin/v1/reconciliation/matches/" + item.payment_match_id);
  if (item) return json({ data: {
    ...paymentMatch, ...item, candidate: null,
    order: { ...paymentMatch.order!, order_id: item.order_id, merchant_order_no: item.merchant_order_no, product_name: item.product_name, api_client_id: item.api_client_id, site_name: item.site_name },
    ledger_entry: { ...paymentMatch.ledger_entry, ledger_entry_id: item.ledger_entry_id },
    creation_operation: { ...paymentMatch.creation_operation!, created_at: item.created_at },
    resolution_operation: item.status === "REVERSED" ? { ...paymentMatch.resolution_operation!, created_at: item.resolved_at } : null,
  } });
  throw new Error("Unexpected detail endpoint: " + url.pathname);
}

function Frame() {
  const location = useLocation();
  const [, setSearch] = useSearchParams();
  return <><button onClick={() => setSearch(current => { const next = new URLSearchParams(current); next.set("selected_site", "site-b"); return next; }, { state: location.state })}>切换网站记忆</button><output aria-label="位置">{location.pathname + location.search}</output><Outlet /></>;
}
function mount(path = "/reconciliation") {
  const router = createMemoryRouter([{ element: <Frame />, children: [{ path: "/reconciliation", element: <Ledger /> }, { path: "/reconciliation/transactions/:ledgerEntryId", element: <LedgerDetail /> }, { path: "/orders/:orderId", element: <Link to="/reconciliation">订单占位</Link> }] }], { initialEntries: [path] });
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
      return detailResponse(request, detail);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("queries global local records and retains the same row, page and draft when website selection changes", async () => {
    const router = mount("/reconciliation?direction=CREDIT&selected_site=site-a");
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

  it("keeps full identifiers and compact summaries while retaining desktop-only column preferences", async () => {
    mobileMedia(1440);
    let width = 1088;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-business-table") ? DOMRect.fromRect({ width, height: 200 }) : original.call(this);
    });
    const externalEventId = "202610222000100000123456";
    fetchMock.mockImplementation(async () => json({ data: [{ ...entry, external_event_id: externalEventId, alipay_account_id: alipayAccount.id, alipay_account_name: alipayAccount.name }], environment: "PRODUCTION", page: { next_cursor: null } }));
    mount();
    const table = await screen.findByRole("table", { name: "支付宝流水" });
    expect(table).toHaveClass("ledger-table");
    expect(within(table).getByRole("columnheader", { name: "关联状态" })).toBeVisible();
    expect(within(table).getByRole("link", { name: externalEventId })).toHaveTextContent(externalEventId);
    expect(within(table).getByText("1 条已撤销关联")).toBeVisible();
    expect(table.querySelector('thead [data-column-id="memo"]')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "列表显示" }));
    await user.click(await screen.findByRole("checkbox", { name: "备注" }));
    expect(within(table).getByRole("columnheader", { name: "备注" })).toBeVisible();
    await user.keyboard("{Escape}");
    act(() => { width = 600; window.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const summary = await screen.findByRole("listitem");
    expect(within(summary).getByRole("group", { name: "关联状态" })).toHaveTextContent("已关联");
    expect(within(summary).getByRole("link", { name: "付款用户" })).toHaveAttribute("href", "/reconciliation/transactions/" + ledgerId);
    expect(within(summary).getByText(externalEventId)).toBeVisible();
    expect(within(summary).getByText("交易时间")).toBeVisible();
    expect(within(summary).getByRole("group", { name: "收支" })).toHaveTextContent("收入");
    const relatedOrder = within(summary).getByRole("link", { name: "查看订单：real-order" });
    expect(relatedOrder).toHaveTextContent(match.product_name);
    expect(relatedOrder).toHaveAttribute("href", "/orders/" + orderId);
    expect(relatedOrder.closest(".ledger-summary-links")).not.toBeNull();
    const account = within(summary).getByRole("link", { name: alipayAccount.name });
    expect(account).toHaveAttribute("href", "/settings/accounts/" + alipayAccount.id);
    expect(account.closest(".ledger-summary-links")).not.toBeNull();
    expect(within(summary).getByRole("group", { name: "PerPay 处理状态" })).toHaveTextContent("已分配");
    expect(within(summary).queryByText("本地流水备注")).not.toBeInTheDocument();
    expect(within(summary).queryByRole("button", { name: "展开信息" })).not.toBeInTheDocument();
    expect(Array.from(summary.querySelectorAll("dt"), field => field.textContent)).toEqual([
      "订单", "账号", "交易时间", "支付宝流水号",
    ]);
    expect(JSON.parse(localStorage.getItem("perpay.table-columns.v2.administrator-ledger")!)).toEqual({ memo: true });
    expect(screen.getByLabelText("位置")).toHaveTextContent(/^\/reconciliation$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates amount precision and applies zero boundaries while clearing pagination", async () => {
    const router = mount("/reconciliation?cursor=page-two&page=2");
    await screen.findByRole("link", { name: entry.external_event_id });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "高级筛选" }));
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
    mount("/reconciliation?min_amount_cents=1.01");
    expect(await screen.findByText("金额筛选无效，请重新设置金额范围。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清除搜索和筛选" }));
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
    mount("/reconciliation?direction=CREDIT");
    const user = userEvent.setup();
    const link = await screen.findByRole("link", { name: entry.external_event_id });
    vi.stubGlobal("scrollY", 725);
    await user.click(link);
    await screen.findByRole("heading", { name: "支付宝收款 · 付款用户" });
    refreshFails = true;
    vi.stubGlobal("scrollY", 0);
    await user.click(screen.getByRole("link", { name: "对账" }));
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ["administrator-ledger"] })[0]?.state.status).toBe("error"));
    expect(screen.getByRole("link", { name: entry.external_event_id })).toBeVisible();
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ top: 725, left: 0, behavior: "instant" }));
  });

  it("displays every detail section together and reads each source and match only once", async () => {
    const router = mount("/reconciliation/transactions/" + ledgerId);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "支付宝收款 · 付款用户", level: 1 });
    const summary = screen.getByRole("group", { name: "流水概况" });
    expect(summary).toHaveTextContent("+¥1.01");
    expect(within(summary).getByText("已关联", { exact: true })).toBeVisible();
    expect(summary).not.toHaveTextContent("real-order");
    expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["交易信息", "对应订单，共 1 项", "采集记录，共 2 项"]);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    for (const id of [ledgerId, secondSourceId]) expect(record("source-" + id)).toBeVisible();
    expect(screen.queryByRole("button", { name: /人工关联收款|确认收款/ })).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const settled = record("match-" + match.payment_match_id);
    const reversed = record("match-" + reversedMatchId);
    expect(section("payments")).toContainElement(settled);
    expect(within(settled).queryByText("撤销时间")).not.toBeInTheDocument();
    // What was reversed is history: read with the rest, shown on request.
    expect(reversed).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: /^已撤销的关联，共 ?1 ?项$/ }));
    await waitFor(() => expect(reversed).toBeVisible());
    expect(within(reversed).getByText("已撤销", { exact: true })).toBeVisible();
    expect(within(reversed).getByText("撤销时间").nextElementSibling).toHaveTextContent(preciseDateTime(ledger.updated_at));
    for (const card of [settled, reversed]) {
      expect(within(card).getByRole("heading", { name: "实际关联商品", level: 3 })).toBeVisible();
      expect(within(card).getByRole("link", { name: "查看订单" })).toHaveAttribute("href", "/orders/" + orderId);
      expect(within(card).getByText("real-order", { exact: true })).toBeVisible();
      expect(within(card).getByRole("link", { name: "采集记录 2" }).getAttribute("href")).toMatch(new RegExp("#source-" + secondSourceId + "$"));
    }
    const reads = fetchMock.mock.calls.map(([request]) => new URL(request.url).pathname);
    expect(reads).toHaveLength(5);
    expect(new Set(reads).size).toBe(reads.length);
    await user.click(screen.getByRole("button", { name: "切换网站记忆" }));
    expect(router.state.location.search).toContain("selected_site=site-b");
    expect(record("match-" + match.payment_match_id)).toBe(settled);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("locates a linked association ahead of a requested section and follows its link to the source it uses", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const anchor = "match-" + match.payment_match_id;
    const router = mount("/reconciliation/transactions/" + ledgerId + "?section=sources#" + anchor);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "支付宝收款 · 付款用户" });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const associated = record(anchor);
    await waitFor(() => expect(associated).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([associated]);
    expect(router.state.location.hash).toBe("#" + anchor);
    const link = within(associated).getByRole("link", { name: "采集记录 2" });
    await user.click(link);
    await waitFor(() => expect(router.state.location.hash).toBe("#source-" + secondSourceId));
    const used = record("source-" + secondSourceId);
    await waitFor(() => expect(used).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([associated, used]);
    // The address no longer changes on a second use, yet the link still brings the source back.
    await user.click(link);
    await waitFor(() => expect(used).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([associated, used, used]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("locates an association once its own read ends and leaves focus alone when later evidence arrives", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const originalFetch = fetchMock.getMockImplementation()!;
    const anchor = "match-" + match.payment_match_id;
    const targetSuffix = "/matches/" + match.payment_match_id;
    const lateSuffix = "/ledger-entries/" + secondSourceId + "/candidates";
    let finishTarget!: (response: Response) => void;
    let finishLate!: (response: Response) => void;
    const targetResponse = new Promise<Response>(resolve => { finishTarget = resolve; });
    const lateResponse = new Promise<Response>(resolve => { finishLate = resolve; });
    fetchMock.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(targetSuffix)) return targetResponse;
      if (path.endsWith(lateSuffix)) return lateResponse;
      return originalFetch(request);
    });
    mount("/reconciliation/transactions/" + ledgerId + "#" + anchor);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    // The association is named by the entry itself, so it stands before its own read ends.
    const target = record(anchor);
    expect(within(target).getByText("real-order", { exact: true })).toBeVisible();
    expect(target).not.toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls.find(([request]) => new URL(request.url).pathname.endsWith(targetSuffix))![0];
    await act(async () => { finishTarget(await originalFetch(request)); });
    await waitFor(() => expect(target).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([target]);
    expect(queryClient.isFetching()).toBe(1);

    const readingElsewhere = screen.getByRole("button", { name: "切换网站记忆" });
    readingElsewhere.focus();
    await act(async () => { finishLate(json({ data: [] })); });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(readingElsewhere).toHaveFocus();
    expect(scroll.mock.contexts).toEqual([target]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("locates a source only after the orders above it have been read", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const originalFetch = fetchMock.getMockImplementation()!;
    const anchor = "source-" + ledgerId;
    const pending = [ledgerId, secondSourceId].map(id => {
      let finish!: () => void;
      const response = new Promise<Response>(resolve => { finish = () => resolve(json({ data: [] })); });
      return { suffix: "/ledger-entries/" + id + "/candidates", response, finish };
    });
    fetchMock.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      return pending.find(item => path.endsWith(item.suffix))?.response ?? originalFetch(request);
    });
    mount("/reconciliation/transactions/" + ledgerId + "#" + anchor);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(queryClient.isFetching()).toBe(2));
    const target = record(anchor);
    await act(async () => { pending[0]!.finish(); });
    await waitFor(() => expect(queryClient.isFetching()).toBe(1));
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    // What is still being read above the source could move it once it arrives.
    expect(target).not.toHaveFocus();
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => { pending[1]!.finish(); });
    await waitFor(() => expect(target).toHaveFocus());
    expect(scroll.mock.contexts).toEqual([target]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("renders disputed facts without inventing zero or selecting a settled match", async () => {
    const secondMatch: AdminLedgerMatch & { status: "SETTLED" } = { ...match, payment_match_id: "44444444-4444-4444-8444-444444444445", order_id: "11111111-1111-4111-8111-111111111112", merchant_order_no: "another-real-order" };
    const variant: AdminLedgerDetail = { ...detail, amount_cents: null, direction: null, occurred_at: null, content_consistent: false, has_conflicts: true, active_match_count: 2, active_match: null, matches: [...detail.matches, secondMatch], conflicts: [{ conflict_id: "66666666-6666-4666-8666-666666666666", conflict_type: "DUPLICATE_EXTERNAL_ID", status: "OPEN", existing_ledger_entry_id: secondSourceId, created_at: ledger.created_at, resolved_at: null }] };
    fetchMock.mockImplementation(async request => detailResponse(request, variant));
    mount("/reconciliation/transactions/" + ledgerId);
    expect(await screen.findByText("同一笔流水关联了多个订单")).toBeVisible();
    // Neither a receipt nor an expense while the versions disagree on the direction.
    expect(screen.getByRole("heading", { name: "支付宝交易 · 付款用户", level: 1 })).toBeVisible();
    const summary = screen.getByRole("group", { name: "流水概况" });
    for (const text of ["金额有争议", "收支方向有争议", "交易时间有争议", "多笔关联", "需要核查"]) expect(summary).toHaveTextContent(text);
    expect(screen.getByText("有 2 条有效关联，无法确定唯一订单。")).toBeVisible();
    expect(await screen.findAllByText("存在多条关联", { exact: true })).toHaveLength(2);
    expect(within(record("match-" + reversedMatchId)).queryByText("存在多条关联")).not.toBeInTheDocument();
    // Each source states for itself what the transaction as a whole cannot.
    for (const id of [ledgerId, secondSourceId]) {
      expect(within(record("source-" + id)).getAllByRole("term").map(term => term.textContent)).toEqual(["交易金额", "收支方向", "交易时间", "内部流水编号（PerPay）", "保存时间"]);
    }
    const conflict = record("conflict-66666666-6666-4666-8666-666666666666");
    expect(within(conflict).getByRole("heading", { name: "支付宝流水号重复", level: 3 })).toBeVisible();
    expect(within(conflict).getByText("待处理", { exact: true })).toBeVisible();
    expect(within(conflict).getByRole("link", { name: "采集记录 2" })).toBeVisible();
    expect(within(conflict).getByRole("link", { name: "查看冲突记录" })).toHaveAttribute("href", "/reconciliation/conflicts/66666666-6666-4666-8666-666666666666");
    expect(document.body).not.toHaveTextContent("¥0.00");
  });

  it("keeps absent nullable text neutral when only the amount differs between sources", async () => {
    const bare = (id: string, amount: number) => ({ ...source(id), amount_cents: amount, provider_order_no: null, semantic_fingerprint: String(amount % 10).repeat(64) });
    const variant: AdminLedgerDetail = { ...detail, amount_cents: null, other_account: null, memo: null, provider_order_no: null, merchant_order_no: null, content_consistent: false, has_conflicts: true, sources: [bare(ledgerId, 101), bare(secondSourceId, 102)] };
    fetchMock.mockImplementation(async request => detailResponse(request, variant));
    mount("/reconciliation/transactions/" + ledgerId);
    await screen.findByRole("heading", { name: "支付宝收款", level: 1 });
    const facts = section("transaction")!;
    // No source states them, and a version that is not listed here still may: neither "disputed" nor "not provided".
    expect(within(facts).getAllByRole("term").map(term => term.textContent)).toEqual(["对方", "支付宝流水号", "支付宝订单号"]);
    for (const title of ["对方", "支付宝订单号"]) expect(within(facts).getByText(title).nextElementSibling).toHaveTextContent(/^—$/);
    expect(facts).not.toHaveTextContent(/有争议|未提供/);
    expect(screen.getByRole("group", { name: "流水概况" })).toHaveTextContent("金额有争议");
    expect(screen.getByText("账单信息存在不同版本", { exact: true })).toBeVisible();
    expect(screen.getByText("各份采集记录存在差异，请逐份核对。")).toBeVisible();
    for (const [id, amount] of [[ledgerId, "¥1.01"], [secondSourceId, "¥1.02"]] as const) {
      expect(within(record("source-" + id)).getByText("交易金额").nextElementSibling).toHaveTextContent(amount);
    }
    expect(section("sources")!.querySelectorAll("[data-sub-record]")).toHaveLength(2);
    expect(section("conflicts")).toBeNull();
    expect(screen.queryByRole("link", { name: "查看冲突记录" })).not.toBeInTheDocument();
    expect(screen.queryByText(/账本冲突待处理/)).not.toBeInTheDocument();
  });
});
