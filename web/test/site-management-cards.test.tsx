import { Profiler } from "react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type ListSiteOverviewResponse } from "../src/api/client";
import Sites from "../src/pages/Sites";
import { apiError, json } from "./fixtures";

type Range = 7 | 30 | 90;
type OverviewSite = ListSiteOverviewResponse["data"][number];
type RequestHandler = (url: URL, request: Request) => Response | Promise<Response>;

function site(clientId: string, name: string, overrides: Partial<OverviewSite> = {}): OverviewSite {
  return {
    client_id: clientId,
    name,
    accepting_orders: true,
    notifications_enabled: true,
    confirmed_count: 17,
    confirmed_amount_cents: 12901,
    pending_orders: 23,
    work_items: 5,
    ...overrides,
  };
}

function page(
  data: OverviewSite[],
  nextCursor: string | null = null,
  { range = 30, end = "2026-10-10", maximum = Math.max(0, ...data.map(item => item.confirmed_amount_cents)) }: {
    range?: Range;
    end?: string;
    maximum?: number;
  } = {},
) {
  const last = Date.parse(end + "T12:00:00.000Z");
  return json({
    period: { from: new Date(last - (range - 1) * 86_400_000).toISOString().slice(0, 10), to: end },
    max_confirmed_amount_cents: maximum,
    data,
    page: { next_cursor: nextCursor },
  } satisfies ListSiteOverviewResponse);
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

function cards() {
  const region = screen.queryByRole("region", { name: "网站经营概况" });
  return region ? within(region).queryAllByRole("article") : [];
}

function card(clientId: string) {
  const destination = "/sites/" + encodeURIComponent(clientId);
  const result = cards().find(item => [...item.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .some(link => new URL(link.href).pathname === destination));
  if (!result) throw new Error("找不到业务网站卡片：" + clientId);
  return result;
}

function findCard(clientId: string) {
  return waitFor(() => card(clientId));
}

function amount(item: HTMLElement) {
  return within(item).getByText(/^¥[\d,]+\.\d{2}$/);
}

function metric(item: HTMLElement, name: string) {
  const term = within(item).getByText(name, { selector: "dt", exact: true });
  const value = term.nextElementSibling;
  expect(value?.tagName).toBe("DD");
  return value as HTMLElement;
}

function barWidth(item: HTMLElement) {
  const fill = item.querySelector<SVGRectElement>(".site-overview-amount-fill");
  if (!fill) throw new Error("找不到管理卡片实收横条");
  return Number(fill.getAttribute("width"));
}

function rangeButton(range: Range) {
  return screen.getByRole("button", { name: new RegExp("^(?:近\\s*)?" + range + "\\s*天$") });
}

function mount(handler: RequestHandler, path = "/sites", onCommit?: () => void) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn((request: Request) => {
    const url = new URL(request.url);
    requests.push(request);
    if (request.method !== "GET" || url.pathname !== "/api/admin/v1/sites/overview")
      throw new Error("管理卡片只允许批量读取网站概览：" + request.method + " " + url.pathname);
    return handler(url, request);
  }));
  const router = createMemoryRouter([
    { path: "/sites", element: <Profiler id="site-management" onRender={() => onCommit?.()}><Sites /></Profiler> },
    { path: "/sites/new", element: <h1>创建业务网站页面</h1> },
    { path: "/sites/defaults", element: <h1>默认模板页面</h1> },
    { path: "/sites/:clientId", element: <h1>网站后台页面</h1> },
    { path: "/sites/:clientId/settings/basic", element: <h1>网站设置页面</h1> },
  ], { initialEntries: [path] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, router, requests };
}

describe("website management operating cards", () => {
  it("keeps creation and template entries while loading without inventing receipts or a clickable website", async () => {
    const pending = deferredResponse();
    mount(() => pending.promise);
    expect(screen.getByRole("link", { name: "创建业务网站" })).toHaveAttribute("href", "/sites/new");
    expect(screen.getByRole("link", { name: "默认模板" })).toHaveAttribute("href", "/sites/defaults");
    expect(screen.getByRole("status")).toHaveAccessibleName(/读取|加载/);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("¥0.00", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入后台" })).not.toBeInTheDocument();
    await act(async () => { pending.resolve(page([site("site_single", "唯一网站")])); });
    await findCard("site_single");
    expect(cards()).toHaveLength(1);
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it.each([7, 30, 90] as const)("keeps a single website's operating metrics and requests %i days in one batch of thirty", async range => {
    const view = mount(() => page([site("site_single", "单个经营网站")], null, { range, maximum: 25802 }), "/sites?range=" + range);
    const item = await findCard("site_single");
    expect(cards()).toHaveLength(1);
    expect(item.closest(".site-management-grid")).not.toBeNull();
    expect(amount(item)).toHaveTextContent("¥129.01");
    expect(metric(item, "确认笔数")).toHaveTextContent(/^17$/);
    expect(metric(item, "当前待付款")).toHaveTextContent(/^23$/);
    expect(metric(item, "待处理")).toHaveTextContent(/^5$/);
    expect(metric(item, "待处理").querySelector("[data-slot=badge]")).toHaveAttribute("data-variant", "warning");
    expect(within(item).getByText("接单中", { exact: true })).toBeVisible();
    expect(within(item).getByText("通知开启", { exact: true })).toBeVisible();
    expect(barWidth(item)).toBe(50);
    const bar = item.querySelector("svg.site-overview-amount-bar")!;
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).toHaveAttribute("focusable", "false");
    expect(bar.querySelector("path, polyline, [style]")).toBeNull();
    expect(bar).not.toHaveAttribute("style");
    expect(within(item).getByRole("link", { name: "单个经营网站" })).toHaveAttribute("href", "/sites/site_single?range=" + range);
    expect(within(item).getByRole("link", { name: "进入后台" })).toHaveAttribute("href", "/sites/site_single?range=" + range);
    expect(within(item).getByRole("link", { name: "网站设置" })).toHaveAttribute("href", "/sites/site_single/settings/basic");
    expect(item.querySelector("[data-slot=card-footer]")).not.toBeNull();
    expect(item.querySelector("a a, a button")).toBeNull();
    expect(rangeButton(range)).toHaveAttribute("aria-pressed", "true");
    expect(view.requests).toHaveLength(1);
    const request = new URL(view.requests[0]!.url);
    expect(request.pathname).toBe("/api/admin/v1/sites/overview");
    expect(Object.fromEntries(request.searchParams)).toEqual({ range: String(range), limit: "30" });
  });

  it("defaults to thirty days and keeps each website's status and current workload separate", async () => {
    const view = mount(() => page([
      site("site_active", "正常经营网站", { notifications_enabled: false, pending_orders: 4, work_items: 6 }),
      site("site_paused", "暂停经营网站", { accepting_orders: false, confirmed_count: 9, confirmed_amount_cents: 700, pending_orders: 2, work_items: 1 }),
    ]));
    const active = await findCard("site_active");
    const paused = card("site_paused");
    expect(cards()).toHaveLength(2);
    expect(within(active).getByText("接单中", { exact: true })).toBeVisible();
    expect(within(active).getByText("通知关闭", { exact: true })).toBeVisible();
    expect(metric(active, "当前待付款")).toHaveTextContent(/^4$/);
    expect(metric(active, "待处理")).toHaveTextContent(/^6$/);
    expect(within(paused).getByText("暂停接单", { exact: true })).toBeVisible();
    expect(within(paused).getByText("通知开启", { exact: true })).toBeVisible();
    expect(amount(paused)).toHaveTextContent("¥7.00");
    expect(metric(paused, "确认笔数")).toHaveTextContent(/^9$/);
    expect(metric(paused, "当前待付款")).toHaveTextContent(/^2$/);
    expect(metric(paused, "待处理")).toHaveTextContent(/^1$/);
    expect(within(paused).getByRole("link", { name: "进入后台" })).not.toHaveAttribute("aria-disabled", "true");
    expect(new URL(view.requests[0]!.url).searchParams.get("range")).toBe("30");
    expect(rangeButton(30)).toHaveAttribute("aria-pressed", "true");
  });

  it("shows zero values for all three operating metrics and an empty amount bar", async () => {
    mount(() => page([site("site_zero", "尚未收款网站", {
      accepting_orders: false,
      notifications_enabled: false,
      confirmed_count: 0,
      confirmed_amount_cents: 0,
      pending_orders: 0,
      work_items: 0,
    })], null, { maximum: 0 }));
    const item = await findCard("site_zero");
    expect(amount(item)).toHaveTextContent("¥0.00");
    for (const label of ["确认笔数", "当前待付款", "待处理"])
      expect(metric(item, label)).toHaveTextContent(/^0$/);
    expect(metric(item, "待处理").querySelector("[data-slot=badge]")).toBeNull();
    expect(barWidth(item)).toBe(0);
    expect(item.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(within(item).getByText("暂停接单", { exact: true })).toBeVisible();
    expect(within(item).getByText("通知关闭", { exact: true })).toBeVisible();
    expect(within(item).getByRole("link", { name: "网站设置" })).toBeVisible();
  });

  it("preserves long duplicate names, independent identifiers and complete large amounts across pages", async () => {
    const name = "长名称网站与订阅账务管理".repeat(8);
    mount(url => url.searchParams.has("cursor")
      ? page([site("site_bbbbbbbb-next", name)])
      : page([site("site_aaaaaaaa-first", name, { confirmed_amount_cents: 987654321012 })], "same-name-next"));
    const first = await findCard("site_aaaaaaaa-first");
    expect(amount(first)).toHaveTextContent("¥9,876,543,210.12");
    await userEvent.setup().click(screen.getByRole("button", { name: /加载更多/ }));
    const second = await findCard("site_bbbbbbbb-next");
    for (const [item, suffix, clientId] of [[first, "aaaaaaaa", "site_aaaaaaaa-first"], [second, "bbbbbbbb", "site_bbbbbbbb-next"]] as const) {
      const visibleName = within(item).getByText(name, { exact: true });
      const identifier = within(item).getByText(suffix, { exact: true });
      expect(visibleName).toBeVisible();
      expect(identifier).toBeVisible();
      expect(visibleName).not.toContainElement(identifier);
      expect(within(item).getByRole("link", { name: "进入后台" })).toHaveAttribute("href", "/sites/" + clientId + "?range=30");
      expect(within(item).getByRole("link", { name: "网站设置" })).toHaveAttribute("href", "/sites/" + clientId + "/settings/basic");
    }
  });

  it("uses the global maximum before its website is loaded and applies the latest page's scale to all thirty cards", async () => {
    const first = Array.from({ length: 30 }, (_, index) => site("site_page_" + index, "分页网站 " + index, { confirmed_amount_cents: 2500 }));
    const view = mount(url => url.searchParams.has("cursor")
      ? page([site("site_peak", "最大收款网站", { accepting_orders: false, confirmed_amount_cents: 10000 })], null, { maximum: 10000 })
      : page(first, "next-thirty", { maximum: 20000 }));
    const original = await findCard("site_page_0");
    expect(cards()).toHaveLength(30);
    expect(barWidth(original)).toBe(12.5);
    await userEvent.setup().click(screen.getByRole("button", { name: /加载更多/ }));
    const peak = await findCard("site_peak");
    expect(cards()).toHaveLength(31);
    expect(card("site_page_0")).toBe(original);
    expect(first.every(item => barWidth(card(item.client_id)) === 25)).toBe(true);
    expect(barWidth(peak)).toBe(100);
    expect(screen.queryByRole("button", { name: /加载更多/ })).not.toBeInTheDocument();
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "next-thirty"]);
    expect(view.requests.every(request => new URL(request.url).searchParams.get("limit") === "30")).toBe(true);
  });

  it("retries an initial failure without replacing it with an empty or zero-receipt state", async () => {
    let reads = 0;
    const view = mount(() => ++reads === 1 ? apiError("internal_error", "经营信息读取失败", 500) : page([site("site_retry", "恢复经营网站")]));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("经营信息读取失败");
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("暂无网站", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("¥0.00", { exact: true })).not.toBeInTheDocument();
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    expect(await findCard("site_retry")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, null]);
  });

  it("retains existing cards after an append fails and retries only the failed next page", async () => {
    const first = Array.from({ length: 30 }, (_, index) => site("site_retained_" + index, "已有经营网站 " + index));
    const pending = deferredResponse();
    let appended = 0;
    const view = mount(url => {
      if (!url.searchParams.has("cursor")) return page(first, "retry-next", { maximum: 25802 });
      return ++appended === 1 ? pending.promise : page([site("site_recovered_tail", "恢复的后续网站")], null, { maximum: 51604 });
    });
    const original = await findCard("site_retained_0");
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: /加载更多/ });
    await user.click(more);
    expect(more).toBeDisabled();
    expect(cards()).toHaveLength(30);
    await act(async () => { pending.resolve(apiError("internal_error", "后续网站读取失败", 500)); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("后续网站读取失败");
    expect(cards()).toHaveLength(30);
    expect(card("site_retained_0")).toBe(original);
    expect(barWidth(original)).toBe(50);
    await user.click(within(error).getByRole("button", { name: "重试" }));
    await findCard("site_recovered_tail");
    expect(cards()).toHaveLength(31);
    expect(cards().every(item => barWidth(item) === 25)).toBe(true);
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "retry-next", "retry-next"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("writes a new range to the URL without losing the selected site or labeling old amounts as the new range", async () => {
    const next = deferredResponse();
    const view = mount(url => url.searchParams.get("range") === "30"
      ? page([site("site_old_range", "旧周期网站", { confirmed_amount_cents: 1100 })], "old-cursor") : next.promise,
    "/sites?selected_site=site_remembered");
    await findCard("site_old_range");
    await userEvent.setup().click(rangeButton(7));
    await waitFor(() => expect(view.requests).toHaveLength(2));
    const search = new URLSearchParams(view.router.state.location.search);
    expect(search.get("range")).toBe("7");
    expect(search.get("selected_site")).toBe("site_remembered");
    expect(cards().some(item => item.textContent?.includes("旧周期网站") && item.querySelector('a[href$="range=7"]'))).toBe(false);
    await act(async () => { next.resolve(page([site("site_new_range", "新周期网站", { confirmed_amount_cents: 7700 })], null, { range: 7 })); });
    const current = await findCard("site_new_range");
    expect(cards()).toHaveLength(1);
    expect(amount(current)).toHaveTextContent("¥77.00");
    expect(within(current).getByRole("link", { name: "进入后台" })).toHaveAttribute("href", "/sites/site_new_range?range=7");
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, null]);
  });

  it("requests fresh data when quickly returning to a visited range", async () => {
    let thirtyDayReads = 0;
    const view = mount(url => {
      const range = Number(url.searchParams.get("range")) as Range;
      if (range === 30) thirtyDayReads++;
      return page([site("site_returning", "切回周期网站", { confirmed_amount_cents: range === 7 ? 700 : thirtyDayReads === 1 ? 1100 : 2200 })], null, { range });
    }, "/sites?selected_site=site_remembered");
    await findCard("site_returning");
    expect(amount(card("site_returning"))).toHaveTextContent("¥11.00");
    const user = userEvent.setup();
    await user.click(rangeButton(7));
    await waitFor(() => expect(amount(card("site_returning"))).toHaveTextContent("¥7.00"));
    await user.click(rangeButton(30));
    await waitFor(() => expect(amount(card("site_returning"))).toHaveTextContent("¥22.00"));
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("site_remembered");
    expect(view.requests.map(request => new URL(request.url).searchParams.get("range"))).toEqual(["30", "7", "30"]);
  });

  it("ignores a late next page from the old range after the user changes range", async () => {
    const late = deferredResponse();
    const view = mount(url => {
      if (url.searchParams.get("range") === "90") return page([site("site_current", "当前周期经营网站")], null, { range: 90 });
      return url.searchParams.has("cursor") ? late.promise : page([site("site_old", "旧周期经营网站")], "late-next");
    });
    await findCard("site_old");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /加载更多/ }));
    await waitFor(() => expect(view.requests).toHaveLength(2));
    await user.click(rangeButton(90));
    await findCard("site_current");
    await act(async () => { late.resolve(page([site("site_late", "不应追加的经营网站")])); });
    expect(cards()).toHaveLength(1);
    expect(screen.queryByText("不应追加的经营网站", { exact: true })).not.toBeInTheDocument();
    expect(within(card("site_current")).getByRole("link", { name: "进入后台" })).toHaveAttribute("href", "/sites/site_current?range=90");
  });

  it.each([false, true])("hides a different-date next page and restarts from the first page, even for an empty append: %s", async emptyAppend => {
    const reset = deferredResponse();
    let firstReads = 0;
    const snapshots: string[][] = [];
    const view = mount(url => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "old-day-next") return page(emptyAppend ? [] : [site("site_mixed_tail", "跨日追加网站")], null, { end: "2026-10-11" });
      if (cursor === "new-day-next") return page([site("site_fresh_tail", "当天第二页")], null, { end: "2026-10-11" });
      return ++firstReads === 1 ? page([site("site_yesterday", "前一天经营网站")], "old-day-next") : reset.promise;
    }, "/sites", () => { snapshots.push(cards().map(item => item.textContent ?? "")); });
    await findCard("site_yesterday");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /加载更多/ }));
    await waitFor(() => expect(firstReads).toBe(2));
    expect(cards()).toHaveLength(0);
    expect(snapshots.every(items => items.every(text => !text.includes("跨日追加网站")))).toBe(true);
    await act(async () => { reset.resolve(page([site("site_fresh", "当天第一页")], "new-day-next", { end: "2026-10-11" })); });
    await findCard("site_fresh");
    expect(cards()).toHaveLength(1);
    expect(screen.queryByText("前一天经营网站", { exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /加载更多/ }));
    await findCard("site_fresh_tail");
    expect(cards()).toHaveLength(2);
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "old-day-next", null, "new-day-next"]);
  });

  it("refreshes every loaded page after one minute and advances the entire set across Shanghai midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T15:59:20.000Z"));
    focusManager.setFocused(true);
    let unmount: (() => void) | undefined;
    try {
      const snapshots: string[][] = [];
      const view = mount(url => {
        const fresh = Date.now() >= Date.parse("2026-10-10T16:00:00.000Z");
        const tail = url.searchParams.has("cursor");
        return page([site(tail ? "site_second" : "site_first", tail ? "第二页经营网站" : "第一页经营网站", {
          confirmed_amount_cents: fresh ? tail ? 4000 : 3000 : tail ? 2000 : 1000,
        })], tail ? null : fresh ? "new-next" : "old-next", { end: fresh ? "2026-10-11" : "2026-10-10", maximum: fresh ? 8000 : 2000 });
      }, "/sites", () => { snapshots.push(cards().map(item => amount(item).textContent ?? "")); });
      unmount = view.unmount;
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(amount(card("site_first"))).toHaveTextContent("¥10.00");
      fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(cards()).toHaveLength(2);
      expect(amount(card("site_second"))).toHaveTextContent("¥20.00");
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(view.requests).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(view.requests).toHaveLength(4);
      expect(amount(card("site_first"))).toHaveTextContent("¥30.00");
      expect(amount(card("site_second"))).toHaveTextContent("¥40.00");
      expect(barWidth(card("site_first"))).toBe(37.5);
      expect(barWidth(card("site_second"))).toBe(50);
      expect(snapshots.filter(values => values.length === 2).every(values =>
        JSON.stringify(values) === JSON.stringify(["¥10.00", "¥20.00"]) || JSON.stringify(values) === JSON.stringify(["¥30.00", "¥40.00"]),
      )).toBe(true);
      expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "old-next", null, "new-next"]);
    } finally {
      unmount?.();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it("retains one complete old page set when a later refresh page fails, then retries the entire current period", async () => {
    let stage: "old" | "failed" | "fresh" = "old";
    const snapshots: string[][] = [];
    const view = mount(url => {
      const tail = url.searchParams.has("cursor");
      if (stage === "failed" && tail) return apiError("internal_error", "后页刷新失败", 500);
      const fresh = stage !== "old";
      return page([site(tail ? "site_second" : "site_first", tail ? "刷新第二页" : "刷新第一页", {
        confirmed_amount_cents: fresh ? tail ? 4000 : 3000 : tail ? 2000 : 1000,
      })], tail ? null : fresh ? "new-next" : "old-next", { end: fresh ? "2026-10-11" : "2026-10-10", maximum: fresh ? 8000 : 2000 });
    }, "/sites", () => { snapshots.push(cards().map(item => amount(item).textContent ?? "")); });
    await findCard("site_first");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /加载更多/ }));
    await findCard("site_second");
    stage = "failed";
    await act(async () => { await queryClient.refetchQueries({ type: "active" }); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("后页刷新失败");
    expect(cards()).toHaveLength(2);
    expect(amount(card("site_first"))).toHaveTextContent("¥10.00");
    expect(amount(card("site_second"))).toHaveTextContent("¥20.00");
    expect(barWidth(card("site_first"))).toBe(50);
    expect(barWidth(card("site_second"))).toBe(100);
    stage = "fresh";
    await user.click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(amount(card("site_second"))).toHaveTextContent("¥40.00"));
    expect(amount(card("site_first"))).toHaveTextContent("¥30.00");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(snapshots.filter(values => values.length === 2).every(values =>
      JSON.stringify(values) === JSON.stringify(["¥10.00", "¥20.00"]) || JSON.stringify(values) === JSON.stringify(["¥30.00", "¥40.00"]),
    )).toBe(true);
    expect(view.requests.map(request => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "old-next", null, "new-next", null, "new-next"]);
  });

  it("renders the empty state while preserving creation and template entries", async () => {
    mount(() => page([]));
    expect(await screen.findByText("暂无网站", { exact: true })).toBeVisible();
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("¥0.00", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "创建业务网站" })).toBeVisible();
    expect(screen.getByRole("link", { name: "默认模板" })).toBeVisible();
  });

  it.each([
    { name: "导航网站", destination: "/sites/site_navigation?range=90", heading: "网站后台页面" },
    { name: "进入后台", destination: "/sites/site_navigation?range=90", heading: "网站后台页面" },
    { name: "网站设置", destination: "/sites/site_navigation/settings/basic", heading: "网站设置页面" },
  ])("opens the separate $name link without nesting other controls", async ({ name, destination, heading }) => {
    const view = mount(() => page([site("site_navigation", "导航网站")], null, { range: 90 }), "/sites?range=90");
    const item = await findCard("site_navigation");
    const link = within(item).getByRole("link", { name });
    expect(link).toHaveAttribute("href", destination);
    expect(link.querySelector("a, button, input, select, textarea")).toBeNull();
    await userEvent.setup().click(link);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(destination);
  });
});
