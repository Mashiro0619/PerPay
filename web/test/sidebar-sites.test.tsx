import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type ListSiteOverviewResponse, type Site } from "../src/api/client";
import { json, ledger, ledgerId, order, orderId } from "./fixtures";
import { groupedLedger } from "./ledger-fixtures";
import { matchId, paymentMatch } from "./detail-fixtures";
import { recordAction } from "./menu-helper";
import { mountOnboarding } from "./onboarding-fixture";

function site(clientId: string, name: string): Site {
  return {
    client_id: clientId,
    revision: 0,
    configuration: {
      name,
      accepting_orders: true,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
      policy: {
        orders: {
          order_ttl_seconds: 300,
          amount_offset_maximum_cents: 99,
          amount_reuse_cooldown_seconds: 600,
          pending_order_limit: null,
        },
        display: {
          checkout_name: "网站收银台",
          checkout_help_url: null,
          checkout_show_product_name: true,
        },
        notification_delivery: {
          timeout_milliseconds: 5000,
          maximum_attempts: 12,
          retry_base_seconds: 5,
          retry_maximum_seconds: 3600,
        },
      },
    },
    created_at: "2026-10-06T00:00:00Z",
    updated_at: "2026-10-06T00:00:00Z",
    deleted_at: null,
  };
}

const siteA = site("a", "网站 A");
const siteB = site("b", "网站 B");

function mountSidebar({
  path = "/orders",
  sites = [siteA, siteB],
  list,
  mobile = false,
  handle,
}: {
  path?: string;
  sites?: Site[];
  list?: (url: URL) => Response | Promise<Response>;
  mobile?: boolean;
  handle?: (request: Request) => Response | Promise<Response> | undefined;
} = {}) {
  vi.stubGlobal("innerWidth", mobile ? 390 : 1440);
  const listReads: URL[] = [];
  const view = mountOnboarding({
    stage: 4,
    path,
    viewportWidth: mobile ? 390 : 1440,
    handle(request) {
      const override = handle?.(request);
      if (override !== undefined) return override;
      const url = new URL(request.url);
      if (url.pathname === "/api/admin/v1/sites") {
        listReads.push(url);
        return list?.(url) ?? json({ data: sites, page: { next_cursor: null } });
      }
      if (url.pathname === "/api/admin/v1/sites/overview") {
        const days = Number(url.searchParams.get("range") ?? 30);
        const last = Date.parse("2026-10-10T12:00:00.000Z");
        return json({
          period: { from: new Date(last - (days - 1) * 86_400_000).toISOString().slice(0, 10), to: "2026-10-10" },
          max_confirmed_amount_cents: 0,
          data: sites.map(site => ({
            client_id: site.client_id,
            name: site.configuration.name,
            accepting_orders: site.configuration.accepting_orders,
            notifications_enabled: site.configuration.notifications_enabled,
            confirmed_count: 0,
            confirmed_amount_cents: 0,
            pending_orders: 0,
            work_items: 0,
          })),
          page: { next_cursor: null },
        } satisfies ListSiteOverviewResponse);
      }
      const metadata = /^\/api\/admin\/v1\/sites\/([^/]+)$/.exec(url.pathname);
      if (metadata) {
        const value = sites.find((item) => item.client_id === decodeURIComponent(metadata[1]!));
        return value
          ? json({ data: value })
          : json({ error: { code: "site_not_found", message: "该网站不存在" } }, 404);
      }
      if (url.pathname.endsWith("/work-items/summary"))
        return json({ data: { total: 0 } });
      if (url.pathname.endsWith("/notifications"))
        return json({ data: [], page: { next_cursor: null } });
      if (url.pathname.endsWith("/orders/" + orderId))
        return json({ data: { ...order, api_client_id: /\/sites\/([^/]+)/.exec(url.pathname)?.[1] ?? "a" } });
      if (url.pathname === "/api/admin/v1/ledger/entries")
        return json({ data: [groupedLedger], environment: "PRODUCTION", page: { next_cursor: null } });
      if (url.pathname === "/api/admin/v1/ledger/entries/" + ledgerId)
        return json({ data: { ...groupedLedger, sources: [{ ...ledger, state: "ALLOCATED", app_id: "app", environment: "PRODUCTION", raw_event_id: ledgerId }], matches: [groupedLedger.active_match], conflicts: [] } });
      if (url.pathname.endsWith("/ledger-entries/" + ledgerId + "/candidates"))
        return json({ data: [] });
      if (url.pathname === "/api/admin/v1/reconciliation/matches/" + matchId)
        return json({ data: paymentMatch });
      if (url.pathname === "/api/admin/v1/settings/site-defaults")
        return json({ data: { revision: 0, policy: siteA.configuration.policy } });
      return undefined;
    },
  });
  return { ...view, listReads };
}

function sidebar(): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "主导航" });
  const container = nav.closest<HTMLElement>("[data-slot=sidebar]");
  if (!container) throw new Error("The main navigation must remain in the sidebar.");
  return container;
}

async function findSidebar() {
  await screen.findByRole("navigation", { name: "主导航" });
  return sidebar();
}

describe("website switch preparation", () => {
  it("keeps the current page until target identity and rows are ready, then switches without a loading frame", async () => {
    let releaseSite!: (response: Response) => void;
    let releaseOrders!: (response: Response) => void;
    const siteResponse = new Promise<Response>(resolve => { releaseSite = resolve; });
    const ordersResponse = new Promise<Response>(resolve => { releaseOrders = resolve; });
    const reads: string[] = [];
    const view = mountSidebar({
      path: "/sites/a/orders",
      handle(request) {
        const path = new URL(request.url).pathname;
        reads.push(path);
        if (path === "/api/admin/v1/sites/b") return siteResponse.then(response => response.clone());
        if (path === "/api/admin/v1/sites/b/orders") return ordersResponse.then(response => response.clone());
        if (path === "/api/admin/v1/sites/a/orders")
          return json({ data: [{ ...order, api_client_id: "a", product_name: "A 当前订单" }], page: { next_cursor: null } });
        return undefined;
      },
    });
    const nav = await findSidebar();
    const currentRow = await screen.findByRole("link", { name: "A 当前订单" });
    const main = screen.getByRole("main");
    const frames: { site: string | null; loading: boolean }[] = [];
    const observer = new MutationObserver(() => frames.push({
      site: nav.querySelector("[data-current-workspace]")?.textContent ?? null,
      loading: !!main.querySelector('[data-slot="skeleton"]'),
    }));
    observer.observe(main, { subtree: true, childList: true, attributes: true });
    const user = userEvent.setup();
    try {
      const target = await within(nav).findByRole("link", { name: "网站 B" });
      await user.click(target);
      await waitFor(() => expect(reads).toContain("/api/admin/v1/sites/b"));
      expect(reads).not.toContain("/api/admin/v1/sites/b/orders");
      expect(view.router.state.location.pathname).toBe("/sites/a/orders");
      expect(currentRow).toBeInTheDocument();
      expect(target).toHaveAttribute("aria-busy", "true");
      expect(main.querySelector("#main-content")).toHaveAttribute("inert");
      expect(nav).toHaveTextContent("正在切换到网站 B…");
      expect(document.title).toContain("网站 A");

      await act(async () => { releaseSite(json({ data: siteB })); });
      await waitFor(() => expect(reads).toContain("/api/admin/v1/sites/b/orders"));
      expect(view.router.state.location.pathname).toBe("/sites/a/orders");
      expect(currentRow).toBeInTheDocument();
      expect(main.querySelector('[data-slot="skeleton"]')).toBeNull();

      await act(async () => {
        releaseOrders(json({ data: [{ ...order, api_client_id: "b", product_name: "B 目标订单" }], page: { next_cursor: null } }));
      });
      await screen.findByRole("link", { name: "B 目标订单" });
      await waitFor(() => expect(view.router.state.navigation.state).toBe("idle"));
      expect(view.router.state.location.pathname).toBe("/sites/b/orders");
      expect(currentRow).not.toBeInTheDocument();
      expect(main.querySelector("#main-content")).not.toHaveAttribute("inert");
      expect(target).toHaveAttribute("aria-current", "location");
      expect(target).toHaveAttribute("aria-busy", "false");
      expect(frames.some(frame => frame.site === "网站 B")).toBe(true);
      expect(frames.some(frame => frame.loading)).toBe(false);
    } finally {
      observer.disconnect();
    }
  });

  it.each(["current", "another"] as const)("cancels a pending website switch when choosing the %s site", async choice => {
    const siteC = site("c", "网站 C");
    let releaseSite!: (response: Response) => void;
    const siteResponse = new Promise<Response>(resolve => { releaseSite = resolve; });
    const reads: string[] = [];
    const view = mountSidebar({
      path: "/sites/a/orders",
      sites: [siteA, siteB, siteC],
      handle(request) {
        const path = new URL(request.url).pathname;
        reads.push(path);
        if (path === "/api/admin/v1/sites/b") return siteResponse;
        const scoped = /^\/api\/admin\/v1\/sites\/([abc])\/orders$/.exec(path);
        if (scoped) return json({
          data: [{ ...order, api_client_id: scoped[1], product_name: scoped[1]!.toUpperCase() + " 站点订单" }],
          page: { next_cursor: null },
        });
        return undefined;
      },
    });
    const nav = await findSidebar();
    await screen.findByRole("link", { name: "A 站点订单" });
    const user = userEvent.setup();
    await user.click(await within(nav).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(reads).toContain("/api/admin/v1/sites/b"));
    const destination = choice === "current" ? "a" : "c";
    await user.click(within(nav).getByRole("link", { name: choice === "current" ? "网站 A" : "网站 C" }));
    await waitFor(() => expect(view.router.state.navigation.state).toBe("idle"));
    await screen.findByRole("link", { name: destination.toUpperCase() + " 站点订单" });
    await act(async () => { releaseSite(json({ data: siteB })); await siteResponse; });
    expect(view.router.state.location.pathname).toBe(`/sites/${destination}/orders`);
    expect(reads).not.toContain("/api/admin/v1/sites/b/orders");
    expect(screen.queryByRole("link", { name: "B 站点订单" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  });

  it("can reopen mobile navigation and cancel a pending switch after closing its sheet", async () => {
    let releaseSite!: (response: Response) => void;
    const siteResponse = new Promise<Response>(resolve => { releaseSite = resolve; });
    const view = mountSidebar({
      path: "/sites/a/orders",
      mobile: true,
      handle(request) {
        if (new URL(request.url).pathname === "/api/admin/v1/sites/b")
          return siteResponse.then(response => response.clone());
        return undefined;
      },
    });
    await screen.findByRole("heading", { name: "本站订单" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "切换导航" }));
    const sheet = await screen.findByRole("dialog", { name: "导航菜单" });
    await user.click(await within(sheet).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(view.router.state.navigation.state).toBe("loading"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    const trigger = screen.getByRole("button", { name: "切换导航" });
    expect(trigger.closest("[inert]")).toBeNull();
    expect(view.container.querySelector("#main-content")).toHaveAttribute("inert");
    await user.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "导航菜单" });
    await user.click(await within(reopened).findByRole("link", { name: "网站 A" }));
    await waitFor(() => expect(view.router.state.navigation.state).toBe("idle"));
    expect(view.router.state.location.pathname).toBe("/sites/a/orders");
    expect(view.container.querySelector("#main-content")).not.toHaveAttribute("inert");
    await act(async () => { releaseSite(json({ data: siteB })); await siteResponse; });
    expect(view.writes()).toHaveLength(0);
  });
});

it("uses the same scoped website choices in the icon rail and restores trigger focus on Escape", async () => {
  const view = mountSidebar({ path: "/sites/a/orders" });
  await findSidebar();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "切换导航" }));
  expect(sidebar()).toHaveAttribute("data-collapsible", "icon");
  const trigger = screen.getByRole("button", { name: /切换业务网站，当前网站 A/ });
  await user.click(trigger);
  expect(await screen.findByRole("link", { name: "网站 B" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  await user.click(await screen.findByRole("link", { name: "网站 B" }));
  await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
});

function primaryLinks(container: HTMLElement) {
  const nav = within(container).getByRole("navigation", { name: "主导航" });
  return within(nav)
    .getAllByRole("link")
    .filter((link) => link.dataset.slot === "sidebar-menu-button")
    .map((link) => link.textContent?.trim());
}

describe("business websites in the sidebar", () => {
  it("opens legacy default-collapsed websites and toggles the whole row once per mouse or keyboard action", async () => {
    sessionStorage.setItem("perpay:sidebar-sites", JSON.stringify({ version: 1, context: "global", open: false }));
    const view = mountSidebar();
    await screen.findByRole("heading", { name: "全部订单", level: 1 });
    const nav = sidebar();
    expect(primaryLinks(nav)).toEqual(["总览", "订单", "待处理", "通知"]);
    const settings = within(nav).getByRole("navigation", { name: "设置导航" });
    const shared = within(nav).getByRole("navigation", { name: "全局管理" });
    expect(within(shared).getAllByRole("link").map(link => link.textContent?.trim())).toEqual(["业务网站", "对账", "运行状态"]);
    expect(within(shared).queryByRole("link", { name: "支付宝流水" })).not.toBeInTheDocument();
    const manage = within(shared).getByRole("link", { name: "业务网站" });
    expect(manage).toHaveAttribute("href", "/sites");
    expect(within(settings).getByRole("link", { name: "设置" })).toHaveAttribute("href", "/settings");
    expect(settings.closest("[data-slot=sidebar-footer]")).toContainElement(shared);
    expect(shared.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const selector = within(nav).getByRole("navigation", { name: "网站选择" });
    expect(within(nav).getByRole("navigation", { name: "主导航" }).compareDocumentPosition(selector) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(selector).queryByRole("link", { name: "业务网站" })).not.toBeInTheDocument();
    expect(within(selector).queryByRole("link", { name: "业务网站" })).not.toBeInTheDocument();
    expect(within(nav).getAllByRole("link", { name: "业务网站" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "切换后台" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    const toggle = within(selector).getByRole("button", { name: /^业务网站 .*，收起$/ });
    expect(toggle).toHaveAccessibleName("业务网站 全部网站，收起");
    expect(within(selector).getAllByRole("button", { name: /业务网站/ })).toHaveLength(1);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await within(nav).findByRole("link", { name: "网站 B" });
    expect(JSON.parse(sessionStorage.getItem("perpay:sidebar-sites")!)).toEqual({ version: 2, context: "global", open: true });
    expect(view.listReads.map((url) => url.searchParams.get("limit"))).toEqual(["30"]);
    const location = view.router.state.location;
    await user.click(within(toggle).getByText("业务网站"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("业务网站 全部网站，展开");
    await waitFor(() => expect(within(nav).queryByRole("link", { name: "网站 B" })).not.toBeInTheDocument());
    await user.click(within(toggle).getByText("业务网站"));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await within(nav).findByRole("link", { name: "网站 B" });
    expect(view.listReads.map((url) => url.searchParams.get("limit"))).toEqual(["30"]);
    expect(within(nav).getByRole("link", { name: "全部网站" })).toHaveAttribute("href", "/orders");

    await user.click(within(toggle).getByText("全部网站"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(within(nav).queryByRole("link", { name: "网站 B" })).not.toBeInTheDocument());
    const arrow = toggle.querySelectorAll("svg").item(toggle.querySelectorAll("svg").length - 1);
    await user.click(arrow);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(within(selector).getByRole("link", { name: "全部网站" }));
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.router.state.location).toBe(location);
    await user.click(manage);
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    await screen.findByRole("link", { name: "创建业务网站" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await within(nav).findByRole("link", { name: "网站 B" })).toBeVisible();
  });

  it.each(["/sites", "/sites/new", "/sites/defaults"])("activates global website management for a direct visit to %s", async (path) => {
    mountSidebar({ path });
    const nav = await findSidebar();
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    expect(await within(nav).findByRole("link", { name: "网站 A" })).toHaveAttribute("href", path + "?selected_site=a");
    const shared = within(nav).getByRole("navigation", { name: "全局管理" });
    const manage = within(shared).getByRole("link", { name: "业务网站" });
    expect(manage).toHaveAttribute("href", "/sites");
    expect(manage).toHaveAttribute("aria-current", "page");
    expect(manage).toHaveAttribute("data-active");
    expect(within(shared).getByRole("link", { name: "对账" })).not.toHaveAttribute("aria-current");
    expect(within(shared).getByRole("link", { name: "运行状态" })).not.toHaveAttribute("aria-current");
  });

  it.each([false, true])("opens global management with remembered site selection while the switcher is collapsed (mobile: %s)", async (mobile) => {
    const view = mountSidebar({ path: "/sites/a/orders", mobile });
    await screen.findByRole("heading", { name: "本站订单", level: 1 });
    const user = userEvent.setup();
    if (mobile) await user.click(screen.getByRole("button", { name: "切换导航" }));
    const nav = sidebar();
    await user.click(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ }));
    const selector = within(nav).getByRole("navigation", { name: "网站选择" });
    const shared = within(nav).getByRole("navigation", { name: "全局管理" });
    expect(within(selector).queryByRole("link", { name: "网站 A" })).not.toBeInTheDocument();
    const manage = within(shared).getByRole("link", { name: "业务网站" });
    expect(manage).toHaveAttribute("href", "/sites?selected_site=a");
    expect(manage).not.toHaveAttribute("aria-current");
    if (mobile) await user.click(manage);
    else {
      manage.focus();
      await user.keyboard("{Enter}");
    }
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("a");
    await waitFor(() => expect(view.container.querySelector("header")).toHaveTextContent("全局"));
    await waitFor(() => expect(view.listReads.length).toBeGreaterThan(0));
    expect(view.listReads.every(url => !url.searchParams.has("api_client_id") && !url.searchParams.has("selected_site"))).toBe(true);
    expect(view.fetchMock.mock.calls.some(([request]) => new URL(request.url).pathname === "/api/admin/v1/sites/a/sites")).toBe(false);
    if (mobile) {
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "切换导航" }));
    }
    const current = sidebar();
    expect(within(current).getByRole("button", { name: /^业务网站 .*，展开$/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(current).getByRole("link", { name: "业务网站" })).toHaveAttribute("aria-current", "page");
    expect(within(current).getByRole("link", { name: "订单" })).toHaveAttribute("href", "/sites/a/orders");
  });

  it("keeps the current site highlighted through its pages, switching and browser history", async () => {
    const view = mountSidebar({ path: "/sites/a/orders?q=original" });
    await screen.findByRole("heading", { name: "本站订单", level: 1 });
    const nav = sidebar();
    expect(primaryLinks(nav)).toEqual(["总览", "订单", "待处理", "通知"]);
    const settings = within(nav).getByRole("navigation", { name: "设置导航" });
    expect(within(settings).getByRole("link", { name: "设置" })).toHaveAttribute("href", "/sites/a/settings/basic");
    expect(within(nav).getByRole("link", { name: "对账" })).toHaveAttribute("href", "/reconciliation?selected_site=a");
    expect(within(nav).getByRole("link", { name: "运行状态" })).toHaveAttribute("href", "/system?selected_site=a");
    expect(within(nav).getByRole("link", { name: "业务网站" })).toHaveAttribute("href", "/sites?selected_site=a");
    expect(await within(nav).findByRole("link", { name: "网站 A" })).toHaveAttribute("aria-current", "location");
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAccessibleName("业务网站 网站 A，收起");
    const user = userEvent.setup();
    await user.click(within(nav).getByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    await screen.findByRole("heading", { name: "本站订单", level: 1 });
    expect(new URLSearchParams(view.router.state.location.search).get("q")).toBe("original");
    await waitFor(() => {
      expect(within(nav).getByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location");
      expect(within(nav).getByRole("link", { name: "网站 A" })).not.toHaveAttribute("aria-current");
    });
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAccessibleName("业务网站 网站 B，收起");

    await user.click(within(nav).getByRole("link", { name: "通知" }));
    await screen.findByRole("heading", { name: "本站通知", level: 1 });
    expect(view.router.state.location.pathname).toBe("/sites/b/notifications");
    expect(within(nav).getByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location");
    await user.click(within(nav).getByRole("link", { name: "全部网站" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/notifications"));
    await screen.findByRole("heading", { name: "全部通知", level: 1 });
    expect(primaryLinks(nav)).toEqual(["总览", "订单", "待处理", "通知"]);
    await waitFor(() => expect(within(nav).getByRole("link", { name: "网站 B" })).not.toHaveAttribute("aria-current"));

    await act(async () => { await view.router.navigate(-1); });
    await screen.findByRole("heading", { name: "本站通知", level: 1 });
    expect(view.router.state.location.pathname).toBe("/sites/b/notifications");
    expect(within(nav).getByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location");
    await act(async () => { await view.router.navigate(1); });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/notifications"));
    await waitFor(() => expect(within(nav).getByRole("link", { name: "网站 B" })).not.toHaveAttribute("aria-current"));
  });

  it("retains a manual collapse in the session and expands when another site is entered", async () => {
    const view = mountSidebar({ path: "/sites/a/orders" });
    const nav = await findSidebar();
    await within(nav).findByRole("link", { name: "网站 A" });
    const user = userEvent.setup();
    await user.click(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ }));
    await user.click(within(nav).getByRole("link", { name: "通知" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/a/notifications"));
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，展开$/ })).toHaveAttribute("aria-expanded", "false");
    await act(async () => { await view.router.navigate("/orders"); });
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，展开$/ })).toHaveAttribute("aria-expanded", "false");
    await act(async () => { await view.router.navigate("/sites/b/orders"); });
    expect(await within(nav).findByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location");
    await user.click(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ }));
    expect(JSON.parse(sessionStorage.getItem("perpay:sidebar-sites")!)).toEqual({ version: 2, context: "site:b", open: false });
    view.unmount();

    mountSidebar({ path: "/sites/b/orders" });
    const restored = await findSidebar();
    expect(within(restored).getByRole("button", { name: /^业务网站 .*，展开$/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(restored).queryByRole("link", { name: "网站 B" })).not.toBeInTheDocument();
  });

  it("shows current metadata before the site list arrives and deduplicates loaded pages", async () => {
    const current = site("current", "当前网站");
    const firstPage = Array.from({ length: 30 }, (_, i) => site(`page-${i}`, `分页网站 ${i + 1}`));
    const last = site("last", "最后一个网站");
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const view = mountSidebar({
      path: "/sites/current/orders",
      sites: [current, ...firstPage, last],
      list: (url) => url.searchParams.has("after")
        ? json({ data: [firstPage[0], current, last], page: { next_cursor: null } })
        : pending,
    });
    const nav = await findSidebar();
    expect(await within(nav).findByRole("link", { name: "当前网站" })).toHaveAttribute("aria-current", "location");
    expect(within(nav).getByRole("link", { name: "全部网站" })).toHaveAttribute("href", "/orders");
    await act(async () => {
      release(json({ data: firstPage, page: { next_cursor: "second-page" } }));
      await pending;
    });
    await within(nav).findByRole("link", { name: "分页网站 30" });
    const submenu = within(nav).getByRole("link", { name: "当前网站" }).closest("ul")!;
    expect(within(submenu).getAllByRole("link").slice(0, 2).map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual(["全部网站", "当前网站"]);
    await userEvent.click(within(nav).getByRole("button", { name: "加载更多网站" }));
    await within(nav).findByRole("link", { name: "最后一个网站" });
    expect(within(submenu).getAllByRole("link")).toHaveLength(33);
    expect(within(submenu).getAllByRole("link").at(-1)).toHaveAccessibleName("最后一个网站");
    expect(within(submenu).queryByRole("link", { name: "业务网站" })).not.toBeInTheDocument();
    expect(within(nav).getAllByRole("link", { name: "当前网站" })).toHaveLength(1);
    expect(within(nav).getAllByRole("link", { name: "分页网站 1" })).toHaveLength(1);
    expect(within(nav).queryByRole("button", { name: "加载更多网站" })).not.toBeInTheDocument();
    expect(view.listReads.map((url) => [url.searchParams.get("limit"), url.searchParams.get("after")])).toEqual([
      ["30", null], ["30", "second-page"],
    ]);
  });

  it("preserves full long names, distinguishes duplicate names and labels paused sites", async () => {
    const longName = "一个需要在侧边栏中省略显示但完整名称仍可以查看的业务网站";
    const paused = site("long", longName);
    paused.configuration.accepting_orders = false;
    mountSidebar({
      sites: [site("site_aaaaaaaa-first", "同名网站"), site("site_bbbbbbbb-next", "同名网站"), paused],
    });
    const nav = await findSidebar();
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    expect(await within(nav).findByRole("link", { name: "同名网站 · aaaaaaaa" })).toHaveAttribute("href", "/sites/site_aaaaaaaa-first/orders");
    expect(within(nav).getByRole("link", { name: "同名网站 · bbbbbbbb" })).toHaveAttribute("href", "/sites/site_bbbbbbbb-next/orders");
    const longLink = within(nav).getByRole("link", { name: new RegExp(longName) });
    expect(within(longLink).getByText(longName)).toHaveClass("truncate");
    expect(longLink).toHaveAccessibleName(longName);
    expect(longLink).toHaveAccessibleDescription("暂停接单 · 通知关闭");
  });

  it("retries an initial list failure locally while keeping the current workspace usable", async () => {
    let attempts = 0;
    const view = mountSidebar({
      path: "/sites/a/orders",
      list: () => ++attempts === 1
        ? json({ error: { code: "internal_error", message: "网站列表暂时无法读取" } }, 503)
        : json({ data: [siteA, siteB], page: { next_cursor: null } }),
    });
    await screen.findByRole("heading", { name: "本站订单", level: 1 });
    const nav = sidebar();
    const failure = await within(nav).findByRole("alert");
    expect(within(nav).getByRole("link", { name: "网站 A" })).toHaveAttribute("aria-current", "location");
    expect(within(nav).getByRole("link", { name: "全部网站" })).toHaveAttribute("href", "/orders");
    await userEvent.click(within(failure).getByRole("button", { name: /重试/ }));
    await within(nav).findByRole("link", { name: "网站 B" });
    expect(within(nav).queryByRole("alert")).not.toBeInTheDocument();
    expect(view.listReads).toHaveLength(2);
    expect(view.router.state.location.pathname).toBe("/sites/a/orders");
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps loaded sites visible and retries only a failed next page", async () => {
    let attempts = 0;
    const view = mountSidebar({
      list: (url) => !url.searchParams.has("after")
        ? json({ data: [siteA], page: { next_cursor: "next" } })
        : ++attempts === 1
          ? json({ error: { code: "internal_error", message: "下一页暂时无法读取" } }, 503)
          : json({ data: [siteB], page: { next_cursor: null } }),
    });
    const nav = await findSidebar();
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    await within(nav).findByRole("link", { name: "网站 A" });
    await userEvent.click(within(nav).getByRole("button", { name: "加载更多网站" }));
    const failure = await within(nav).findByRole("alert");
    expect(within(nav).getByRole("link", { name: "网站 A" })).toBeVisible();
    await userEvent.click(within(failure).getByRole("button", { name: /重试/ }));
    await within(nav).findByRole("link", { name: "网站 B" });
    expect(within(nav).getAllByRole("link", { name: "网站 A" })).toHaveLength(1);
    expect(view.listReads.map((url) => url.searchParams.get("after"))).toEqual([null, "next", "next"]);
  });

  it("blocks loading more during a background refresh and uses the refreshed cursor afterwards", async () => {
    let firstPageReads = 0;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const view = mountSidebar({
      list: (url) => url.searchParams.has("after")
        ? json({ data: [siteB], page: { next_cursor: null } })
        : ++firstPageReads === 1
          ? json({ data: [siteA], page: { next_cursor: "next" } })
          : pending,
    });
    const nav = await findSidebar();
    const user = userEvent.setup();
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    await within(nav).findByRole("link", { name: "网站 A" });
    expect(within(nav).getByRole("button", { name: "加载更多网站" })).toBeEnabled();

    let refresh!: Promise<void>;
    await act(async () => {
      refresh = queryClient.invalidateQueries({ queryKey: ["sites", "switcher"] });
    });
    const refreshing = await within(nav).findByRole("button", { name: "正在刷新网站…" });
    expect(refreshing).toBeDisabled();
    expect(within(nav).getByRole("link", { name: "网站 A" })).toBeVisible();
    await user.click(refreshing);
    expect(view.listReads.map((url) => url.searchParams.get("after"))).toEqual([null, null]);

    await act(async () => {
      release(json({ data: [siteA], page: { next_cursor: "after-refresh" } }));
      await refresh;
    });
    const more = await within(nav).findByRole("button", { name: "加载更多网站" });
    expect(more).toBeEnabled();
    await user.click(more);
    await within(nav).findByRole("link", { name: "网站 B" });
    expect(view.listReads.map((url) => url.searchParams.get("after"))).toEqual([null, null, "after-refresh"]);
    expect(within(nav).queryByRole("button", { name: "加载更多网站" })).not.toBeInTheDocument();
  });

  it("keeps global and management navigation available when there are no sites", async () => {
    mountSidebar({ sites: [] });
    const nav = await findSidebar();
    expect(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    expect(await within(nav).findByText("暂无网站")).toBeVisible();
    expect(within(nav).getByRole("link", { name: "全部网站" })).toHaveAttribute("href", "/orders");
    expect(within(nav).getByRole("link", { name: "业务网站" })).toHaveAttribute("href", "/sites");
    expect(within(nav).queryByRole("button", { name: "加载更多网站" })).not.toBeInTheDocument();
  });

  it("retains the website group's disclosure when the mobile sheet closes and reopens", async () => {
    const view = mountSidebar({ mobile: true });
    const trigger = await screen.findByRole("button", { name: "切换导航" });
    const user = userEvent.setup();
    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "导航菜单" });
    expect(within(sheet).getByRole("button", { name: /^业务网站 .*，收起$/ })).toHaveAttribute("aria-expanded", "true");
    await within(sheet).findByRole("link", { name: "网站 B" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "导航菜单" });
    expect(within(reopened).getByRole("link", { name: "网站 B" })).toBeVisible();
    await user.click(within(reopened).getByRole("button", { name: /^业务网站 .*，收起$/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    await user.click(trigger);
    const collapsed = await screen.findByRole("dialog", { name: "导航菜单" });
    expect(within(collapsed).getByRole("button", { name: /^业务网站 .*，展开$/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(collapsed).queryByRole("link", { name: "网站 B" })).not.toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe("/orders");
    expect(view.listReads).toHaveLength(1);
  });

  it.each([false, true])("keeps dirty edits until a confirmed site change and closes mobile navigation only afterwards (mobile: %s)", async (mobile) => {
    const view = mountSidebar({ path: "/sites/a/settings/basic", mobile });
    const field = await screen.findByLabelText("业务网站名称");
    fireEvent.change(field, { target: { value: "尚未保存的业务网站名称" } });
    const user = userEvent.setup();
    if (mobile) await user.click(screen.getByRole("button", { name: "切换导航" }));
    const sheet = mobile ? await screen.findByRole("dialog", { name: "导航菜单" }) : null;
    const nav = sidebar();
    await within(nav).findByRole("link", { name: "网站 B" });

    await user.click(within(nav).getByRole("button", { name: /^业务网站 .*，收起$/ }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: /^业务网站 .*，展开$/ }));
    await user.click(within(nav).getByRole("link", { name: "网站 B" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(view.router.state.location.pathname).toBe("/sites/a/settings/basic");
    if (sheet) expect(sheet).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(field).toHaveValue("尚未保存的业务网站名称");
    expect(within(nav).getByRole("link", { name: "网站 A" })).toHaveAttribute("aria-current", "location");
    if (sheet) expect(screen.getByRole("dialog", { name: "导航菜单" })).toBe(sheet);

    await user.click(within(nav).getByRole("link", { name: "网站 B" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/settings/basic"));
    await waitFor(() => expect(screen.getByLabelText("业务网站名称")).toHaveValue("网站 B"));
    if (mobile) await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    expect(field).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });
});

describe("website selection on shared pages", () => {
  it("remembers the selected site across shared pages, history and refresh without changing their API scope", async () => {
    const view = mountSidebar({ path: "/sites/a/orders" });
    const nav = await findSidebar();
    await within(nav).findByRole("link", { name: "网站 A" });
    const user = userEvent.setup();
    await user.click(within(nav).getByRole("link", { name: "对账" }));
    const sharedRow = await screen.findByRole("link", { name: groupedLedger.external_event_id });
    expect(within(sharedRow.closest("[data-business-row]")! as HTMLElement).getAllByText("test-merchant-order").length).toBeGreaterThan(0);
    expect(view.router.state.location.pathname).toBe("/reconciliation");
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("a");
    expect(view.container.querySelector("header")).toHaveTextContent("全局");
    const sharedReads = () => view.fetchMock.mock.calls.filter(([request]) => new URL(request.url).pathname === "/api/admin/v1/ledger/entries");
    expect(sharedReads()).toHaveLength(1);

    await user.click(within(nav).getByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b"));
    expect(view.router.state.location.pathname).toBe("/reconciliation");
    expect(screen.getByRole("link", { name: groupedLedger.external_event_id })).toBe(sharedRow);
    expect(sharedReads()).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "订单" })).toHaveAttribute("href", "/sites/b/orders");
    expect(within(nav).getByRole("link", { name: "设置" })).toHaveAttribute("href", "/sites/b/settings/basic");
    expect(within(nav).getByRole("link", { name: "运行状态" })).toHaveAttribute("href", "/system?selected_site=b");
    expect(view.fetchMock.mock.calls.every(([request]) => !new URL(request.url).searchParams.has("selected_site"))).toBe(true);
    expect(view.fetchMock.mock.calls.some(([request]) => /\/sites\/[ab]\/reconciliation/.test(new URL(request.url).pathname))).toBe(false);

    await user.click(within(nav).getByRole("link", { name: "订单" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    await screen.findByRole("heading", { name: "本站订单", level: 1 });
    await waitFor(() => expect(view.fetchMock.mock.calls.some(([request]) => new URL(request.url).pathname === "/api/admin/v1/sites/b/orders")).toBe(true));
    expect(new URLSearchParams(view.router.state.location.search).has("selected_site")).toBe(false);
    await act(async () => { await view.router.navigate(-1); });
    await screen.findByRole("link", { name: groupedLedger.external_event_id });
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b");
    await act(async () => { await view.router.navigate(-1); });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "网站 A" })).toHaveAttribute("aria-current", "location"));
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("a");
    await act(async () => { await view.router.navigate(1); });
    await waitFor(() => expect(within(nav).getByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location"));

    const address = view.router.state.location.pathname + view.router.state.location.search;
    view.unmount();
    queryClient.clear();
    const refreshed = mountSidebar({ path: address });
    const restored = await findSidebar();
    await screen.findByRole("link", { name: groupedLedger.external_event_id });
    expect(await within(restored).findByRole("link", { name: "网站 B" })).toHaveAttribute("aria-current", "location");
    expect(within(restored).getByRole("link", { name: "订单" })).toHaveAttribute("href", "/sites/b/orders");
    await user.click(within(restored).getByRole("link", { name: "全部网站" }));
    await waitFor(() => expect(new URLSearchParams(refreshed.router.state.location.search).has("selected_site")).toBe(false));
    expect(refreshed.router.state.location.pathname).toBe("/reconciliation");
    await waitFor(() => expect(within(restored).getByRole("link", { name: "设置" })).toHaveAttribute("href", "/settings"));
    expect(within(restored).getByRole("link", { name: "订单" })).toHaveAttribute("href", "/orders");
  });

  it("keeps shared filters and the previous-page cursor trail when only the selected site changes", async () => {
    const view = mountSidebar({
      path: "/reconciliation?selected_site=a&tab=matches&q=shared",
      handle: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== "/api/admin/v1/ledger/entries") return undefined;
        const cursor = url.searchParams.get("cursor");
        return json({ data: [groupedLedger], environment: "PRODUCTION", page: { next_cursor: cursor === "page-three" ? null : cursor === "page-two" ? "page-three" : "page-two" } });
      },
    });
    const user = userEvent.setup();
    await screen.findByText("第 1 页 · 本页 1 条");
    expect(new URLSearchParams(view.router.state.location.search).get("tab")).toBe("transactions");
    expect(new URLSearchParams(view.router.state.location.search).get("association_status")).toBe("MATCHED");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 2 页 · 本页 1 条");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("第 3 页 · 本页 1 条");
    const trail = structuredClone(view.router.state.location.state.pagination);
    const nav = sidebar();
    await user.click(await within(nav).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b"));
    const selected = new URLSearchParams(view.router.state.location.search);
    expect(selected.get("cursor")).toBe("page-three");
    expect(selected.get("page")).toBe("3");
    expect(selected.get("q")).toBe("shared");
    expect(view.router.state.location.state.pagination).toEqual(trail);
    await user.click(screen.getByRole("button", { name: "上一页" }));
    await screen.findByText("第 2 页 · 本页 1 条");
    expect(new URLSearchParams(view.router.state.location.search).get("cursor")).toBe("page-two");
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b");
  });

  it("returns to the target site's list when switching from a detail, without carrying its resource or cursor", async () => {
    const view = mountSidebar({ path: `/sites/a/orders/${orderId}?q=keyword&payment=UNPAID&sort_by=created_at&sort_order=asc&cursor=old&page=3` });
    await screen.findAllByText("测试商品");
    const nav = sidebar();
    await userEvent.click(await within(nav).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    const search = new URLSearchParams(view.router.state.location.search);
    expect(search.get("q")).toBe("keyword");
    expect(search.get("payment")).toBe("UNPAID");
    expect(search.get("sort_by")).toBe("created_at");
    expect(search.get("sort_order")).toBe("asc");
    expect(search.has("cursor")).toBe(false);
    expect(search.has("page")).toBe(false);
    expect(view.router.state.location.state?.listReturn).toBeUndefined();
    expect(view.fetchMock.mock.calls.some(([request]) => new URL(request.url).pathname === "/api/admin/v1/sites/b/orders/" + orderId)).toBe(false);
  });

  it("does not add history or close the mobile sheet when the current site is selected again", async () => {
    const view = mountSidebar({ path: "/sites/a/orders", mobile: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "切换导航" }));
    const sheet = await screen.findByRole("dialog", { name: "导航菜单" });
    const current = await within(sheet).findByRole("link", { name: "网站 A" });
    const location = view.router.state.location;
    await user.click(current);
    expect(view.router.state.location).toBe(location);
    expect(screen.getByRole("dialog", { name: "导航菜单" })).toBe(sheet);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("keeps shared records usable when the remembered website cannot be loaded", async () => {
    const view = mountSidebar({ path: "/reconciliation?selected_site=missing" });
    const row = await screen.findByRole("link", { name: groupedLedger.external_event_id });
    const nav = sidebar();
    await waitFor(() => expect(view.fetchMock.mock.calls.some(([request]) => new URL(request.url).pathname === "/api/admin/v1/sites/missing")).toBe(true));
    expect(row).toBeVisible();
    expect(screen.queryByText("页面加载失败")).not.toBeInTheDocument();
    await userEvent.click(await within(nav).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b"));
    expect(row).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/reconciliation");
    expect(view.fetchMock.mock.calls.some(([request]) => /\/sites\/missing\/reconciliation/.test(new URL(request.url).pathname))).toBe(false);
  });

  it.each([false, true])("preserves an unsaved shared draft on a pure selection change, and still protects a real departure (mobile: %s)", async (mobile) => {
    const view = mountSidebar({ path: "/sites/defaults?selected_site=a", mobile });
    const field = await screen.findByLabelText("收银台有效期（秒）");
    fireEvent.change(field, { target: { value: "600" } });
    const user = userEvent.setup();
    if (mobile) await user.click(screen.getByRole("button", { name: "切换导航" }));
    await user.click(await within(sidebar()).findByRole("link", { name: "网站 B" }));
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b"));
    expect(view.router.state.location.pathname).toBe("/sites/defaults");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(field);
    expect(field).toHaveValue(600);
    if (mobile) await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    await act(async () => { await view.router.navigate(-1); });
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("a");
    expect(field).toHaveValue(600);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => { await view.router.navigate(1); });
    if (mobile) await user.click(screen.getByRole("button", { name: "切换导航" }));
    await user.click(within(sidebar()).getByRole("link", { name: "订单" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(field).toHaveValue(600);
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b");
    await user.click(within(sidebar()).getByRole("link", { name: "订单" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    if (mobile) await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航菜单" })).not.toBeInTheDocument());
    expect(view.writes()).toHaveLength(0);
  });

  it("preserves an uncertain shared financial command through selection changes and retries its original global request", async () => {
    const detailPath = "/reconciliation/transactions/" + ledgerId;
    const writes: Request[] = [];
    const view = mountSidebar({
      path: "/reconciliation/matches/" + matchId + "?selected_site=a",
      handle: (request) => {
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/actions/reverse")) {
          writes.push(request.clone());
          return Promise.reject(new TypeError("Response was lost"));
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "收款关联记录" });
    expect(view.router.state.location.pathname).toBe(detailPath);
    expect(view.router.state.location.hash).toBe("#match-" + matchId);
    await user.click(await recordAction("撤销错误关联", "收款关联记录操作"));
    const dialog = await screen.findByRole("dialog", { name: "撤销收款关联？" });
    const reason = within(dialog).getByLabelText("操作理由");
    await user.type(reason, "保留原始核查依据");
    await user.click(within(dialog).getByRole("button", { name: "确认撤销关联" }));
    await screen.findByText("操作结果待确认", { exact: true });
    const original = await writes[0]!.clone().json();

    // Browser history can change selection even while a financial modal covers the sidebar.
    await act(async () => { await view.router.navigate(detailPath + "?selected_site=b"); });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "撤销收款关联？" })).toBe(dialog);
    expect(reason).toHaveValue("保留原始核查依据");
    await user.click(within(dialog).getByRole("button", { name: "重试上一次操作" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(await writes[1]!.json()).toEqual(original);
    expect(writes.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/admin/v1/reconciliation/matches/" + matchId + "/actions/reverse",
      "/api/admin/v1/reconciliation/matches/" + matchId + "/actions/reverse",
    ]);
    await act(async () => { await view.router.navigate("/sites/b/orders"); });
    const confirmation = await screen.findByRole("alertdialog", { name: "结果未确认，仍要离开？" });
    expect(within(confirmation).getByText(original.financial_operation_id)).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "留在此页" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(view.router.state.location.pathname).toBe(detailPath);
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("b");
    expect(reason).toHaveValue("保留原始核查依据");
    await act(async () => { await view.router.navigate("/sites/b/orders"); });
    await user.click(await screen.findByRole("button", { name: "离开并稍后核查" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    expect(screen.queryByRole("dialog", { name: "撤销收款关联？" })).not.toBeInTheDocument();
    expect(writes).toHaveLength(2);
  });
});
