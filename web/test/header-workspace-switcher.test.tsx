import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Site, SiteEpayConfiguration } from "../src/api/client";
import { json, order } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

function site(clientId: string): Site {
  return {
    client_id: clientId, revision: 0,
    configuration: {
      name: "网站 " + clientId.toUpperCase(), accepting_orders: true, notifications_enabled: false,
      notification_origin: null, return_origin: null,
      policy: {
        orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
        display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
        notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
      },
    },
    created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", deleted_at: null,
  };
}

function mountHeader({
  path = "/sites/a/orders", width = 1440, handle,
}: {
  path?: string;
  width?: number;
  handle?: (request: Request) => Response | Promise<Response> | undefined;
} = {}) {
  vi.stubGlobal("innerWidth", width);
  const sites = [site("a"), site("b")];
  return mountOnboarding({ stage: 4, path, viewportWidth: width, handle(request) {
    const override = handle?.(request);
    if (override !== undefined) return override;
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/admin/v1/sites") return json({ data: sites, page: { next_cursor: null } });
    const metadata = /^\/api\/admin\/v1\/sites\/([ab])$/.exec(pathname);
    if (metadata) return json({ data: sites.find(value => value.client_id === metadata[1])! });
    const epay = /^\/api\/admin\/v1\/sites\/([ab])\/epay$/.exec(pathname);
    if (epay) return json({ data: {
      client_id: epay[1]!, pid: "10001", revision: 0, v1_enabled: true, v2_enabled: true,
      v1_key_version: 1, merchant_key_version: 1, platform_key_version: 1, public_origin: "https://pay.example.com",
    } satisfies SiteEpayConfiguration });
    if (pathname.endsWith("/work-items/summary")) return json({ data: { total: 0 } });
    return undefined;
  } });
}

async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole("button", { name: "切换网站，当前网站 A" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu", { name: "切换网站" });
  await within(menu).findByRole("menuitem", { name: "网站 B" });
  return { trigger, menu };
}

describe("desktop breadcrumb website switching", () => {
  it("opens at the desktop breakpoint with real links and restores trigger focus on Escape", async () => {
    mountHeader({ width: 1024 });
    const user = userEvent.setup();
    const { trigger, menu } = await openSwitcher(user);
    expect(trigger.closest('[aria-label="页面路径"]')).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "网站 A" })).toHaveAttribute("aria-current", "location");
    expect(within(menu).getByRole("menuitem", { name: "网站 B" })).toHaveAttribute("href", "/sites/b/orders");
    expect(within(menu).getByRole("menuitem", { name: "全部网站" })).toHaveAttribute("href", "/orders");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "切换网站" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("keeps the section and supported filters, while selecting the current site adds no history", async () => {
    const view = mountHeader({ path: "/sites/a/orders?payment=UNPAID&q=keyword&cursor=old&page=3" });
    const user = userEvent.setup();
    const { menu } = await openSwitcher(user);
    const previousLocation = view.router.state.location;
    await user.click(within(menu).getByRole("menuitem", { name: "网站 A" }));
    expect(view.router.state.location).toBe(previousLocation);
    expect(screen.getByRole("menu", { name: "切换网站" })).toBe(menu);
    await user.click(within(menu).getByRole("menuitem", { name: "网站 B" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/b/orders"));
    const search = new URLSearchParams(view.router.state.location.search);
    expect(Object.fromEntries(search)).toEqual({ payment: "UNPAID", q: "keyword" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "切换网站" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "切换网站，当前网站 B" })).toBeEnabled();
    await act(async () => { await view.router.navigate(-1); });
    await waitFor(() => expect(view.router.state.location.key).toBe(previousLocation.key));
  });

  it("lets the original site cancel a slow switch without accepting the late target response", async () => {
    let releaseSite!: (response: Response) => void;
    const siteResponse = new Promise<Response>(resolve => { releaseSite = resolve; });
    const reads: string[] = [];
    const view = mountHeader({ handle(request) {
      const pathname = new URL(request.url).pathname;
      reads.push(pathname);
      if (pathname === "/api/admin/v1/sites/b") return siteResponse.then(response => response.clone());
      if (pathname === "/api/admin/v1/sites/a/orders") return json({
        data: [{ ...order, api_client_id: "a", product_name: "A 当前订单" }], page: { next_cursor: null },
      });
      return undefined;
    } });
    await screen.findByRole("link", { name: "A 当前订单" });
    const user = userEvent.setup();
    const { menu } = await openSwitcher(user);
    await user.click(within(menu).getByRole("menuitem", { name: "网站 B" }));
    await waitFor(() => expect(view.router.state.navigation.state).toBe("loading"));
    expect(view.router.state.location.pathname).toBe("/sites/a/orders");
    expect(screen.getByRole("menu", { name: "切换网站" })).toBe(menu);
    expect(view.container.querySelector("#main-content")).toHaveAttribute("inert");
    await user.click(within(menu).getByRole("menuitem", { name: "网站 A" }));
    await waitFor(() => expect(view.router.state.navigation.state).toBe("idle"));
    await act(async () => { releaseSite(json({ data: site("b") })); await siteResponse; });
    expect(view.router.state.location.pathname).toBe("/sites/a/orders");
    expect(screen.getByRole("link", { name: "A 当前订单" })).toBeVisible();
    expect(view.container.querySelector("#main-content")).not.toHaveAttribute("inert");
    expect(reads).not.toContain("/api/admin/v1/sites/b/orders");
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps a real integration draft editable when website navigation is cancelled", async () => {
    const view = mountHeader({ path: "/sites/a/settings/integration" });
    await screen.findByText("网站接入助手");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "易支付 V1" }));
    const enabled = screen.getByRole("switch");
    await user.click(enabled);
    expect(enabled).not.toBeChecked();
    const { menu } = await openSwitcher(user);
    await user.click(within(menu).getByRole("menuitem", { name: "网站 B" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(view.router.state.location.pathname).toBe("/sites/a/settings/integration");
    await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("switch")).toBe(enabled);
    expect(enabled).not.toBeChecked();
    expect(screen.getByRole("button", { name: "保存易支付设置" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await user.click(enabled);
    expect(enabled).toBeChecked();
    expect(screen.queryByRole("button", { name: "保存易支付设置" })).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("reaches a failed next-page retry by keyboard and retains the loaded website choices", async () => {
    let attempts = 0;
    const cursors: Array<string | null> = [];
    mountHeader({ handle(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/admin/v1/sites") return undefined;
      const cursor = url.searchParams.get("after");
      cursors.push(cursor);
      return cursor === null
        ? json({ data: [site("a")], page: { next_cursor: "next" } })
        : ++attempts === 1
          ? json({ error: { code: "internal_error", message: "下一页暂时无法读取" } }, 503)
          : json({ data: [site("a"), site("b")], page: { next_cursor: null } });
    } });
    const user = userEvent.setup();
    const trigger = await screen.findByRole("button", { name: "切换网站，当前网站 A" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "切换网站" });
    const more = await within(menu).findByRole("menuitem", { name: "加载更多网站" });
    await user.keyboard("{End}");
    expect(more).toHaveFocus();
    await user.keyboard("{Enter}");
    const retry = await within(menu).findByRole("menuitem", { name: "重试" });
    const current = within(menu).getByRole("menuitem", { name: "网站 A" });
    expect(current).toBeVisible();
    current.focus();
    await user.keyboard("{Home}");
    expect(retry).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await within(menu).findByRole("menuitem", { name: "网站 B" })).toBeVisible();
    expect(within(menu).getAllByRole("menuitem", { name: "网站 A" })).toHaveLength(1);
    expect(within(menu).queryByRole("menuitem", { name: "重试" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "加载更多网站" })).not.toBeInTheDocument();
    expect(cursors).toEqual([null, "next", "next"]);
  });

  it.each([
    { path: "/sites/a/orders", width: 1023, label: "网站 A" },
    { path: "/sites/a/orders", width: 1023.5, label: "网站 A" },
    { path: "/system?selected_site=a", width: 1440, label: "全局" },
  ])("keeps the existing header on $path at $width px", async ({ path, width, label }) => {
    const view = mountHeader({ path, width });
    const breadcrumb = await screen.findByRole("navigation", { name: "页面路径" });
    await waitFor(() => expect(breadcrumb).toHaveTextContent(label));
    expect(within(breadcrumb).queryByRole("button", { name: /^切换网站，当前/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "切换网站" })).not.toBeInTheDocument();
    expect(view.router.state.location.pathname).toBe(path.split("?")[0]);
  });
});
