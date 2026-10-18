import { Profiler, useState } from "react";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type ListSiteOverviewResponse } from "../src/api/client";
import { SiteOverviewList } from "../src/components/site-overview-list";
import { apiError, json } from "./fixtures";

type Range = 7 | 30 | 90;
type OverviewSite = ListSiteOverviewResponse["data"][number];
type RequestHandler = (url: URL, request: Request) => Response | Promise<Response>;

function period(range: Range = 7, end = "2026-10-10"): ListSiteOverviewResponse["period"] {
  const last = Date.parse(end + "T12:00:00.000Z");
  return {
    from: new Date(last - (range - 1) * 86_400_000).toISOString().slice(0, 10),
    to: end,
  };
}

function site(clientId: string, name: string, overrides: Partial<OverviewSite> = {}): OverviewSite {
  return {
    client_id: clientId,
    name,
    accepting_orders: true,
    notifications_enabled: true,
    confirmed_count: 1,
    confirmed_amount_cents: 12901,
    pending_orders: 2,
    work_items: 3,
    ...overrides,
  };
}

function otherSite() {
  return site("site_other", "其他网站", {
    confirmed_count: 0,
    confirmed_amount_cents: 0,
    pending_orders: 0,
    work_items: 0,
  });
}

function page(
  data: OverviewSite[],
  nextCursor: string | null = null,
  { range = 7, end = "2026-10-10", maximum = Math.max(0, ...data.map((item) => item.confirmed_amount_cents)) }: {
    range?: Range;
    end?: string;
    maximum?: number;
  } = {},
) {
  const response: ListSiteOverviewResponse = {
    data,
    period: period(range, end),
    max_confirmed_amount_cents: maximum,
    page: { next_cursor: nextCursor },
  };
  return json(response);
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function cards() {
  return [...document.querySelectorAll<HTMLAnchorElement>("a.site-overview-card[data-slot=site-overview-card]")];
}

function card(clientId: string) {
  const result = cards().find((link) => new URL(link.href).pathname === "/sites/" + clientId);
  if (!result) throw new Error("找不到网站卡片：" + clientId);
  return result;
}

async function findCard(clientId: string) {
  return waitFor(() => card(clientId));
}

function amountBar(link: HTMLAnchorElement) {
  const bar = link.querySelector<SVGSVGElement>("svg.site-overview-amount-bar");
  if (!bar) throw new Error("找不到实收金额横条：" + link.getAttribute("href"));
  return bar;
}

function barWidth(link: HTMLAnchorElement) {
  const fill = amountBar(link).querySelector<SVGRectElement>(".site-overview-amount-fill");
  if (!fill) throw new Error("找不到实收金额横条填充");
  return Number(fill.getAttribute("width"));
}

function mount(handler: RequestHandler, initialRange: Range = 7, onCommit?: () => void) {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn((request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/admin/v1/sites/overview")
      throw new Error("意外的网络请求：" + url.pathname);
    requests.push(request);
    return handler(url, request);
  }));
  let updateRange!: (next: Range) => void;
  function OverviewHarness() {
    const [range, setRange] = useState(initialRange);
    updateRange = setRange;
    return (
      <Profiler id="site-overview" onRender={() => onCommit?.()}>
        <SiteOverviewList range={range} />
      </Profiler>
    );
  }
  const router = createMemoryRouter([
    { path: "/", element: <OverviewHarness /> },
    { path: "/sites/:clientId", element: <h1>网站后台</h1> },
  ], { initialEntries: ["/"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return {
    ...view,
    router,
    requests,
    changeRange(next: Range) {
      // Keep the list mounted across range changes, as Dashboard does.
      act(() => updateRange(next));
    },
  };
}

describe("website overview amount cards", () => {
  it("shows a named section and loading skeletons without clickable cards or invented zero totals", async () => {
    const pending = deferredResponse();
    const view = mount(() => pending.promise);
    const section = screen.getByRole("region", { name: "各网站概览" });
    const heading = within(section).getByRole("heading", { name: "各网站概览" });
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    expect(heading.id).not.toBe("");
    expect(within(section).getByRole("status")).toHaveAccessibleName(/读取|加载/);
    expect(section.querySelectorAll("[data-slot=skeleton]").length).toBeGreaterThan(0);
    expect(cards()).toHaveLength(0);
    expect(within(section).queryByText("¥0.00")).not.toBeInTheDocument();
    await act(async () => { pending.resolve(page([site("site_first", "第一网站"), otherSite()])); });
    await findCard("site_first");
    expect(cards()).toHaveLength(2);
    expect(view.container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("hides a complete single-site result and keeps range changes working while the section is hidden", async () => {
    const initial = deferredResponse();
    const nextRange = deferredResponse();
    const only = site("site_only", "唯一网站", { accepting_orders: false, work_items: 7 });
    const view = mount((url) => url.searchParams.get("range") === "7" ? initial.promise : nextRange.promise);
    expect(screen.getByRole("region", { name: "各网站概览" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveAccessibleName(/读取|加载/);
    await act(async () => { initial.resolve(page([only])); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument());
    expect(view.container.querySelector(".site-overview-section")).toBeNull();
    expect(cards()).toHaveLength(0);

    view.changeRange(30);
    expect(screen.getByRole("region", { name: "各网站概览" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveAccessibleName(/读取|加载/);
    await act(async () => { nextRange.resolve(page([only, otherSite()], null, { range: 30 })); });
    const link = await findCard("site_only");
    expect(cards()).toHaveLength(2);
    expect(link).toHaveAttribute("href", "/sites/site_only?range=30");
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("range"))).toEqual(["7", "30"]);
  });

  it("keeps a single loaded site visible while pagination is unfinished or failed and hides only after the successful last page", async () => {
    const next = deferredResponse();
    let appended = 0;
    const view = mount((url) => {
      if (!url.searchParams.has("cursor")) return page([site("site_one_page", "已读取网站")], "next-site");
      if (++appended === 1) return next.promise;
      return page([], null, { maximum: 12901 });
    });
    const first = await findCard("site_one_page");
    expect(screen.getByRole("region", { name: "各网站概览" })).toBeVisible();
    expect(cards()).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    expect(first).toBeVisible();
    await act(async () => { next.resolve(apiError("internal_error", "后续网站读取失败", 500)); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("后续网站读取失败");
    expect(first).toBeVisible();
    expect(cards()).toHaveLength(1);
    await user.click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument());
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "next-site", "next-site"]);
  });

  it("continues the one-minute refresh while hidden and reveals the section when a second website appears", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    let unmount: (() => void) | undefined;
    try {
      const next = deferredResponse();
      let reads = 0;
      const only = site("site_only", "原有网站");
      const view = mount(() => ++reads === 1 ? page([only]) : next.promise);
      unmount = view.unmount;
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(view.requests).toHaveLength(1);
      expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(view.requests).toHaveLength(2);
      // A background read must not briefly flash the already-known single-site result.
      expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument();
      await act(async () => {
        next.resolve(page([only, otherSite()]));
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("region", { name: "各网站概览" })).toBeVisible();
      expect(card("site_only")).toBeVisible();
      expect(card("site_other")).toBeVisible();
      expect(cards()).toHaveLength(2);
    } finally {
      unmount?.();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it("shows a failed refresh and retry even when a cached single-site result was hidden", async () => {
    let fail = false;
    const view = mount(() => fail
      ? apiError("internal_error", "网站数量刷新失败", 500)
      : page([site("site_only", "唯一网站")]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument());
    fail = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-overview", 7, 10], exact: true }); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("网站数量刷新失败");
    expect(screen.getByRole("region", { name: "各网站概览" })).toBeVisible();
    expect(card("site_only")).toBeVisible();
    fail = false;
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "各网站概览" })).not.toBeInTheDocument());
    expect(view.requests).toHaveLength(3);
  });

  it.each([7, 30, 90] as const)("requests %i days in pages of ten and shows only the amount, shared bar and nonzero work badge", async (range) => {
    const current = site("site_amount", "金额网站", {
      confirmed_count: 17,
      confirmed_amount_cents: 9876543,
      pending_orders: 23,
      work_items: 5,
    });
    const view = mount(() => page([
      current,
      site("site_other", "其他网站", { confirmed_amount_cents: 19753086, work_items: 0 }),
    ], null, { range, end: "2025-12-31", maximum: 19753086 }), range);
    const link = await findCard(current.client_id);
    expect(screen.getByText("近 " + range + " 天实收", { exact: true })).toBeVisible();
    expect(link).toHaveAttribute("href", "/sites/site_amount?range=" + range);
    expect(link).toHaveAccessibleName("金额网站，进入后台");
    expect(link).toHaveAccessibleDescription(new RegExp("近 " + range + " 天实收 ¥98,765\\.43"));
    expect(link).toHaveAccessibleDescription(/待处理 5 项/);
    expect(link.querySelector(".site-overview-card-title")).toHaveTextContent(current.name);
    expect(link.querySelector(".site-overview-card-amount")).toHaveTextContent("¥98,765.43");
    const work = within(link).getByText("待处理 5", { exact: true });
    expect(work).toBeVisible();
    expect(work.closest("[data-slot=badge]")).toHaveAttribute("data-variant", "warning");
    expect(link.querySelector("time, dl, [data-slot=card-footer], .site-overview-sparkline")).toBeNull();
    expect(link).not.toHaveTextContent(/确认笔数|当前待付款|2025-12-31|本期暂无收款/);
    const bar = amountBar(link);
    expect(bar).toHaveAttribute("viewBox", "0 0 100 4");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar).toHaveAttribute("focusable", "false");
    expect(bar).not.toHaveAttribute("tabindex", "0");
    expect(bar).not.toHaveAttribute("style");
    expect(bar.querySelector("[style], path, polyline, line")).toBeNull();
    expect(bar.querySelectorAll("rect")).toHaveLength(2);
    expect(bar.querySelector(".site-overview-amount-track")).toHaveAttribute("width", "100");
    expect(barWidth(link)).toBe(50);
    expect(link.querySelector("style, [role=application], [role=tooltip]")).toBeNull();
    expect(link.querySelector("a, button, input, select, textarea, [role=button], [tabindex='0']")).toBeNull();
    const grid = view.container.querySelector<HTMLUListElement>("ul.site-overview-grid")!;
    expect(within(grid).getAllByRole("listitem")).toHaveLength(2);
    expect(within(grid).getAllByRole("link")).toHaveLength(2);
    expect(view.requests).toHaveLength(1);
    const url = new URL(view.requests[0]!.url);
    expect(url.searchParams.get("range")).toBe(String(range));
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(view.requests[0]!.method).toBe("GET");
  });

  it("uses the backend maximum even before the largest website is loaded and applies the latest page maximum to every card", async () => {
    const first = [
      site("site_small", "小额网站", { confirmed_amount_cents: 2500 }),
      site("site_medium", "中额网站", { confirmed_amount_cents: 7500 }),
    ];
    mount((url) => url.searchParams.has("cursor")
      ? page([site("site_latest_peak", "最新最大网站", { confirmed_amount_cents: 10000 })], null, { maximum: 10000 })
      : page(first, "next-amounts", { maximum: 20000 }));
    const small = await findCard("site_small");
    const medium = card("site_medium");
    expect(barWidth(small)).toBe(12.5);
    expect(barWidth(medium)).toBe(37.5);
    await userEvent.setup().click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    const peak = await findCard("site_latest_peak");
    // The new maximum can decrease; neither the first page nor the largest historical maximum owns the scale.
    expect(barWidth(small)).toBe(25);
    expect(barWidth(medium)).toBe(75);
    expect(barWidth(peak)).toBe(100);
    expect(small.querySelector(".site-overview-card-amount")).toHaveTextContent("¥25.00");
    expect(medium.querySelector(".site-overview-card-amount")).toHaveTextContent("¥75.00");
  });

  it("renders a zero-width bar and no work badge when all websites have zero receipts", async () => {
    mount(() => page([site("site_all_zero", "零实收网站", {
      confirmed_count: 0,
      confirmed_amount_cents: 0,
      pending_orders: 0,
      work_items: 0,
    }), otherSite()], null, { maximum: 0 }));
    const link = await findCard("site_all_zero");
    expect(link.querySelector(".site-overview-card-amount")).toHaveTextContent("¥0.00");
    expect(barWidth(link)).toBe(0);
    expect(amountBar(link).outerHTML).not.toMatch(/NaN|Infinity/);
    expect(within(link).queryByText(/待处理/)).not.toBeInTheDocument();
    expect(link.querySelector("[data-slot=badge]")).toBeNull();
    expect(link).toHaveAttribute("href", "/sites/site_all_zero?range=7");
  });

  it("recovers from an initial read failure without showing empty or zero-valued cards", async () => {
    let attempt = 0;
    const view = mount(() => ++attempt === 1
      ? apiError("internal_error", "网站汇总读取失败", 500)
      : page([site("site_retry", "重试成功网站"), otherSite()]));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("网站汇总读取失败");
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("暂无网站")).not.toBeInTheDocument();
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    await userEvent.setup().click(within(error).getByRole("button", { name: "重试" }));
    expect(await findCard("site_retry")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, null]);
  });

  it("keeps ten cards and their shared scale after an append fails, then retries only that next page", async () => {
    const first = Array.from({ length: 10 }, (_, index) => site("site_page_" + (index + 1), "分页网站 " + (index + 1)));
    const pending = deferredResponse();
    let appended = 0;
    const view = mount((url) => {
      if (!url.searchParams.has("cursor")) return page(first, "second-page", { maximum: 25802 });
      if (++appended === 1) return pending.promise;
      return page([site("site_page_11", "分页网站 11"), site("site_page_12", "分页网站 12")], null, { maximum: 51604 });
    });
    const original = await findCard("site_page_1");
    expect(cards()).toHaveLength(10);
    expect(barWidth(original)).toBe(50);
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: "加载更多网站汇总" });
    await user.click(more);
    expect(more).toBeDisabled();
    expect(cards()).toHaveLength(10);
    expect(barWidth(original)).toBe(50);
    await act(async () => { pending.resolve(apiError("internal_error", "下一页暂时读取失败", 500)); });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("下一页暂时读取失败");
    expect(cards()).toHaveLength(10);
    expect(card("site_page_1")).toBe(original);
    expect(barWidth(original)).toBe(50);
    await user.click(within(error).getByRole("button", { name: "重试" }));
    await findCard("site_page_12");
    expect(cards()).toHaveLength(12);
    expect(new Set(cards().map((link) => link.href)).size).toBe(12);
    expect(cards().every((link) => barWidth(link) === 25)).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多网站汇总" })).not.toBeInTheDocument();
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "second-page", "second-page"]);
  });

  it.each([[7, 30], [30, 90], [90, 7]] as const)("does not label stale %i-day values with the new %i-day range", async (before, after) => {
    const next = deferredResponse();
    const old = site("site_old_range", "旧范围网站", { confirmed_amount_cents: 1101 });
    const fresh = site("site_new_range", "新范围网站", { confirmed_amount_cents: 2202 });
    const view = mount((url) => Number(url.searchParams.get("range")) === before
      ? page([old, otherSite()], null, { range: before }) : next.promise, before);
    await findCard(old.client_id);
    view.changeRange(after);
    await waitFor(() => expect(view.requests).toHaveLength(2));
    const retained = cards().find((link) => link.textContent?.includes(old.name));
    if (retained) expect(retained).toHaveAttribute("href", "/sites/site_old_range?range=" + before);
    expect(cards().some((link) => link.textContent?.includes(old.name) && link.getAttribute("href")?.endsWith("range=" + after))).toBe(false);
    await act(async () => { next.resolve(page([fresh, otherSite()], null, { range: after })); });
    const link = await findCard(fresh.client_id);
    expect(link).toHaveAttribute("href", "/sites/site_new_range?range=" + after);
    expect(screen.getByText("近 " + after + " 天实收", { exact: true })).toBeVisible();
    expect(link.querySelector(".site-overview-card-amount")).toHaveTextContent("¥22.02");
    expect(screen.queryByText(old.name)).not.toBeInTheDocument();
    expect(cards()).toHaveLength(2);
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, null]);
  });

  it("reads fresh totals when quickly returning to a previously visited range", async () => {
    let sevenDayReads = 0;
    const view = mount((url) => {
      const range = Number(url.searchParams.get("range")) as Range;
      if (range === 7) sevenDayReads++;
      const amount = range === 30 ? 3000 : sevenDayReads === 1 ? 1100 : 2200;
      return page([site("site_returning", "回切周期网站", { confirmed_amount_cents: amount }), otherSite()], null, { range });
    });
    await findCard("site_returning");
    expect(card("site_returning").querySelector(".site-overview-card-amount")).toHaveTextContent("¥11.00");
    view.changeRange(30);
    await waitFor(() => expect(card("site_returning").querySelector(".site-overview-card-amount")).toHaveTextContent("¥30.00"));
    view.changeRange(7);
    await waitFor(() => expect(card("site_returning").querySelector(".site-overview-card-amount")).toHaveTextContent("¥22.00"));
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("range"))).toEqual(["7", "30", "7"]);
    expect(card("site_returning")).toHaveAttribute("href", "/sites/site_returning?range=7");
  });

  it("ignores an old range's late appended page after changing range", async () => {
    const late = deferredResponse();
    const view = mount((url) => {
      if (url.searchParams.get("range") === "30")
        return page([site("site_current", "当前范围网站"), otherSite()], null, { range: 30 });
      return url.searchParams.has("cursor") ? late.promise : page([site("site_previous", "前一范围网站")], "old-cursor");
    });
    await findCard("site_previous");
    await userEvent.setup().click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    await waitFor(() => expect(view.requests).toHaveLength(2));
    view.changeRange(30);
    await findCard("site_current");
    await act(async () => { late.resolve(page([site("site_late", "过期追加网站")])); });
    expect(cards()).toHaveLength(2);
    expect(card("site_current")).toHaveAttribute("href", "/sites/site_current?range=30");
    expect(screen.queryByText("过期追加网站")).not.toBeInTheDocument();
  });

  it.each([false, true])("resets an appended page from another business date before rendering it, including an empty page: %s", async (emptyAppend) => {
    const reset = deferredResponse();
    let firstReads = 0;
    const snapshots: string[][] = [];
    const view = mount((url) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "old-day-next")
        return page(emptyAppend ? [] : [site("site_new_day_tail", "跨日追加网站")], null, { end: "2026-10-11", maximum: 44808 });
      if (cursor === "new-day-next")
        return page([site("site_fresh_tail", "新日期第二页")], null, { end: "2026-10-11", maximum: 44808 });
      if (++firstReads === 1) return page([site("site_previous_day", "前一天网站")], "old-day-next");
      return reset.promise;
    }, 7, () => {
      snapshots.push(cards().map((link) => new URL(link.href).pathname));
    });
    await findCard("site_previous_day");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    await waitFor(() => expect(firstReads).toBe(2));
    expect(cards()).toHaveLength(0);
    expect(snapshots.every((items) => !items.includes("/sites/site_new_day_tail"))).toBe(true);
    await act(async () => {
      reset.resolve(page([site("site_fresh_day", "新日期第一页", { confirmed_amount_cents: 44808 })], "new-day-next", { end: "2026-10-11", maximum: 44808 }));
    });
    const fresh = await findCard("site_fresh_day");
    expect(fresh.querySelector(".site-overview-card-amount")).toHaveTextContent("¥448.08");
    expect(cards()).toHaveLength(1);
    expect(screen.queryByText("前一天网站")).not.toBeInTheDocument();
    expect(screen.queryByText("跨日追加网站")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    await findCard("site_fresh_tail");
    expect(cards()).toHaveLength(2);
    expect(snapshots.every((items) => !(items.includes("/sites/site_previous_day") && items.some((item) => item.includes("site_fresh"))))).toBe(true);
    expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, "old-day-next", null, "new-day-next"]);
  });

  it("refreshes a continuously open overview after one minute and advances all amounts together across midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T15:59:20.000Z"));
    focusManager.setFocused(true);
    let unmount: (() => void) | undefined;
    try {
      let reads = 0;
      const snapshots: string[][] = [];
      const view = mount(() => ++reads === 1 ? page([
        site("site_staying_a", "常驻网站甲"),
        site("site_staying_b", "常驻网站乙", { confirmed_amount_cents: 20900 }),
      ]) : page([
        site("site_staying_a", "常驻网站甲", { confirmed_amount_cents: 44808, work_items: 0 }),
        site("site_staying_b", "常驻网站乙", { confirmed_amount_cents: 33009 }),
      ], null, { end: "2026-10-11" }), 7, () => {
        snapshots.push(cards().map((link) => link.querySelector(".site-overview-card-amount")?.textContent ?? ""));
      });
      unmount = view.unmount;
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(card("site_staying_a").querySelector(".site-overview-card-amount")).toHaveTextContent("¥129.01");
      expect(card("site_staying_b").querySelector(".site-overview-card-amount")).toHaveTextContent("¥209.00");
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
      expect(view.requests).toHaveLength(1);
      // No user interaction, invalidation or manual refresh is sent.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(view.requests).toHaveLength(2);
      expect(card("site_staying_a").querySelector(".site-overview-card-amount")).toHaveTextContent("¥448.08");
      expect(card("site_staying_b").querySelector(".site-overview-card-amount")).toHaveTextContent("¥330.09");
      expect(within(card("site_staying_a")).queryByText(/待处理/)).not.toBeInTheDocument();
      expect(barWidth(card("site_staying_a"))).toBe(100);
      expect(snapshots.filter((values) => values.length).every((values) =>
        JSON.stringify(values) === JSON.stringify(["¥129.01", "¥209.00"]) ||
        JSON.stringify(values) === JSON.stringify(["¥448.08", "¥330.09"]),
      )).toBe(true);
      expect(view.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([null, null]);
    } finally {
      unmount?.();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it("disambiguates equal website names across appended pages while retaining each native destination", async () => {
    mount((url) => url.searchParams.has("cursor")
      ? page([site("site_bbbbbbbb-next", "同名网站")])
      : page([site("site_aaaaaaaa-first", "同名网站")], "names-next"));
    const first = await findCard("site_aaaaaaaa-first");
    expect(first.querySelector(".site-overview-card-title")).toHaveTextContent(/^同名网站$/);
    await userEvent.setup().click(screen.getByRole("button", { name: "加载更多网站汇总" }));
    const second = await findCard("site_bbbbbbbb-next");
    expect(first.querySelector(".site-overview-card-title")).toHaveTextContent(/^同名网站$/);
    expect(second.querySelector(".site-overview-card-title")).toHaveTextContent(/^同名网站$/);
    expect(within(first).getByText("aaaaaaaa", { exact: true })).toBeVisible();
    expect(within(second).getByText("bbbbbbbb", { exact: true })).toBeVisible();
    expect(first).toHaveAccessibleName("同名网站 · aaaaaaaa，进入后台");
    expect(second).toHaveAccessibleName("同名网站 · bbbbbbbb，进入后台");
    expect(first).toHaveAttribute("href", "/sites/site_aaaaaaaa-first?range=7");
    expect(second).toHaveAttribute("href", "/sites/site_bbbbbbbb-next?range=7");
  });

  it("keeps duplicate identifiers outside the two-line name even when both names are long", async () => {
    const longName = "长名称网站与订阅账务管理".repeat(8);
    mount(() => page([
      site("site_aaaaaaaa-first", longName),
      site("site_bbbbbbbb-next", longName),
    ]));
    const first = await findCard("site_aaaaaaaa-first");
    const second = card("site_bbbbbbbb-next");
    for (const [link, suffix] of [[first, "aaaaaaaa"], [second, "bbbbbbbb"]] as const) {
      const name = link.querySelector(".site-overview-card-title");
      const identifier = within(link).getByText(suffix, { exact: true });
      expect(name).toHaveTextContent(longName);
      expect(identifier).toBeVisible();
      expect(name).not.toContainElement(identifier);
      expect(link).toHaveAccessibleName(longName + " · " + suffix + "，进入后台");
    }
  });

  it("preserves a long name and complete large amount and keeps paused zero-payment sites actionable", async () => {
    const longName = "长名称网站 · 跨时区团队服务与订阅账务管理 ".repeat(6).trim();
    const large = site("site_large", longName, {
      confirmed_amount_cents: 987654321012,
      work_items: 8,
    });
    const zero = site("site_zero", "暂停收款网站", {
      accepting_orders: false,
      confirmed_count: 0,
      confirmed_amount_cents: 0,
      pending_orders: 0,
      work_items: 0,
    });
    mount(() => page([large, zero]));
    const largeCard = await findCard(large.client_id);
    expect(largeCard.querySelector(".site-overview-card-title")).toHaveTextContent(longName);
    expect(largeCard.querySelector(".site-overview-card-title")).toHaveAttribute("title", longName);
    expect(largeCard).toHaveAccessibleName(longName + "，进入后台");
    expect(largeCard.querySelector(".site-overview-card-amount")).toHaveTextContent("¥9,876,543,210.12");
    expect(within(largeCard).getByText("待处理 8", { exact: true })).toBeVisible();
    expect(barWidth(largeCard)).toBe(100);
    const zeroCard = card(zero.client_id);
    expect(within(zeroCard).getByText("暂停接单")).toBeVisible();
    expect(zeroCard).toHaveAccessibleDescription(/暂停接单/);
    expect(zeroCard.querySelector(".site-overview-card-amount")).toHaveTextContent("¥0.00");
    expect(barWidth(zeroCard)).toBe(0);
    expect(within(zeroCard).queryByText(/待处理|本期暂无收款/)).not.toBeInTheDocument();
    expect(zeroCard).not.toHaveAttribute("aria-disabled", "true");
    expect(zeroCard).toHaveAttribute("href", "/sites/site_zero?range=7");
    expect(screen.queryByRole("button", { name: "进入后台" })).not.toBeInTheDocument();
  });

  it("shows the empty state when no website exists instead of a zero-payment card", async () => {
    mount(() => page([], null, { maximum: 0 }));
    expect(await screen.findByText("暂无网站")).toBeVisible();
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更多网站汇总" })).not.toBeInTheDocument();
  });

  it.each([
    { area: "name", selector: ".site-overview-card-title" },
    { area: "amount", selector: ".site-overview-card-amount" },
    { area: "bar", selector: "svg.site-overview-amount-bar" },
  ])("opens the real card link from its $area area with the selected range", async ({ selector }) => {
    const view = mount(() => page([site("site_click", "整卡点击网站"), otherSite()], null, { range: 30 }), 30);
    const link = await findCard("site_click");
    await userEvent.setup().click(link.querySelector(selector)!);
    expect(await screen.findByRole("heading", { name: "网站后台" })).toBeVisible();
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe("/sites/site_click?range=30");
  });

  it("has one tab stop per card and opens it with Enter", async () => {
    const view = mount(() => page([site("site_keyboard_a", "键盘网站甲"), site("site_keyboard_b", "键盘网站乙")]));
    const first = await findCard("site_keyboard_a");
    const second = card("site_keyboard_b");
    const user = userEvent.setup();
    first.focus();
    expect(first).toHaveFocus();
    await user.tab();
    expect(second).toHaveFocus();
    await user.tab({ shift: true });
    expect(first).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "网站后台" })).toBeVisible();
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe("/sites/site_keyboard_a?range=7");
  });

  it.each([
    { name: "Ctrl-click", type: "click", init: { button: 0, ctrlKey: true } },
    { name: "middle-click", type: "auxclick", init: { button: 1 } },
  ])("preserves uncancelled native $name semantics", async ({ type, init }) => {
    const view = mount(() => page([site("site_native", "原生链接网站"), otherSite()]));
    const link = await findCard("site_native");
    const observed = vi.fn();
    const native = (event: Event) => {
      observed(event.defaultPrevented, (event as MouseEvent).button, (event as MouseEvent).ctrlKey);
      // Inspect after React's delegated handler, then suppress jsdom's unsupported navigation.
      event.preventDefault();
    };
    document.addEventListener(type, native);
    try {
      fireEvent(link.querySelector(".site-overview-card-amount")!, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
      expect(observed).toHaveBeenCalledExactlyOnceWith(false, init.button, "ctrlKey" in init && init.ctrlKey);
      expect(view.router.state.location.pathname).toBe("/");
      expect(link).toHaveAttribute("href", "/sites/site_native?range=7");
    } finally {
      document.removeEventListener(type, native);
    }
  });
});
