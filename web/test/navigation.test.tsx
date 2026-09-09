import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { appRoutes } from "../src/App";
import { queryClient, type SystemAnalytics } from "../src/api/client";
import { apiError, json, settings } from "./fixtures";
import { systemStatus } from "./onboarding-fixture";

function mount(options: { conflict?: boolean; logoutFailure?: boolean; path?: string; configured?: boolean } = {}) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  let saved = structuredClone(settings);
  if (options.configured) saved.completion.complete = true;
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/session") return json({ data: { username: "admin", csrf_token_required: true, idle_expires_at: "2099-01-01T00:00:00Z", absolute_expires_at: "2099-01-01T00:00:00Z" } });
    if (path === "/api/admin/v1/system/status") return json({ data: options.configured ? { ...systemStatus(), status: "not_ready" } : { status: "not_ready", version: "0.1.0" } });
    if (path === "/api/admin/v1/system/analytics") return json({ data: {
      range_days: 30, from: "2026-08-08T16:00:00.000Z", to: "2026-09-07T16:00:00.000Z",
      orders: { created: 0, unpaid: 0, confirmed: 0, disputed: 0, closed: 0, expired: 0 },
      confirmations: { count: 0, amount_cents: 0 }, notifications: { acknowledged: 0, failed: 0, pending: 0 },
      pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
      daily: Array.from({ length: 30 }, (_, dayIndex) => ({
        date: new Date(Date.UTC(2026, 7, dayIndex + 9)).toISOString().slice(0, 10),
        orders_created: 0, confirmations: 0, confirmed_amount_cents: 0, notifications_acknowledged: 0, notifications_failed: 0,
      })),
    } });
    if (path === "/api/admin/v1/settings") return json({ data: saved });
    if (path === "/api/admin/v1/orders") return json({ data: [], page: { next_cursor: null } });
    if (path === "/api/admin/v1/work-items") return json({ data: [], page: { next_cursor: null } });
    if (path === "/api/admin/v1/session/logout") return options.logoutFailure ? apiError("internal_error", "logout failed", 503) : new Response(null, { status: 204 });
    if (request.method === "PUT") {
      if (options.conflict) return apiError("settings_revision_conflict", "stale revision");
      const body = await request.json() as { order_ttl_seconds: number };
      saved = { ...saved, revision: saved.revision + 1, collection: { ...saved.collection!, order_ttl_seconds: body.order_ttl_seconds } };
      return json({ data: saved });
    }
    return apiError("route_not_found", "unexpected test request", 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/orders", options.path ?? "/settings/collection"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, fetchMock, ...view };
}

async function edit() {
  const user = userEvent.setup();
  const field = await screen.findByLabelText("收银台有效期（秒）");
  await user.clear(field); await user.type(field, "450");
  return { user, field };
}

function unloadIsBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("navigation and draft protection", () => {
  it("keeps only accessible icon controls at the sidebar bottom without redundant instance information", async () => {
    const { container, fetchMock } = mount();
    await screen.findByLabelText("收银台有效期（秒）");
    for (const brand of container.querySelectorAll(".brand")) {
      expect(brand).toHaveTextContent("PerPay");
      expect(brand.querySelector("img, svg")).toBeNull();
    }
    expect(container.querySelector(".topbar")).toBeNull();
    expect(container.querySelector(".instance-label, .sidebar-version, .sidebar-bottom")).toBeNull();
    expect(container.querySelector(".workspace-footer")).toBeNull();
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.queryByText("PerPay · 每一笔，都有据可查")).not.toBeInTheDocument();
    expect(screen.queryByText("金额：人民币 · 时间与日统计：北京时间（UTC+8）")).not.toBeInTheDocument();
    expect(screen.queryByText("个人收款实例")).not.toBeInTheDocument();
    const logout = screen.getByRole("button", { name: "退出登录" });
    const theme = screen.getByRole("button", { name: /切换主题/ });
    expect(logout.closest("aside")).not.toBeNull();
    expect(theme.closest(".sidebar-controls")).toBe(logout.closest(".sidebar-controls"));
    expect(logout.textContent).toBe("");
    expect(theme.textContent).toBe("");
    expect(logout).toHaveAttribute("title", "退出登录");
    expect(theme).toHaveAttribute("title", "切换主题，当前跟随系统");
    expect(logout.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "打开导航" }).closest(".page-heading")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([request]) => request.url.includes("/system/status"))).toBe(false);
  });

  it("keeps collection data prominent while surfacing operational outages on a configured overview", async () => {
    const { container, fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "每日收款与订单" });
    expect(screen.queryByRole("region", { name: "收款链路状态" })).not.toBeInTheDocument();
    expect(container.querySelector(".payment-pipeline")).toBeNull();
    expect(container.querySelector(".dashboard-footnote, .page-heading p, .panel-heading p")).toBeNull();
    expect(screen.queryByText(/统计来自本实例/)).not.toBeInTheDocument();
    expect(screen.queryByText("所选周期内创建")).not.toBeInTheDocument();
    expect(screen.queryByText("所选周期内的确认事件")).not.toBeInTheDocument();
    expect(screen.getByText("非净结算收入")).toBeVisible();
    expect(screen.getByText("当前收银台开放且未付款")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "完成配置，开始收款" })).not.toBeInTheDocument();
    expect(container.querySelector("main h2")).toHaveTextContent("收款数据");
    expect(screen.getByRole("heading", { name: "需要你关注" })).toBeVisible();
    expect(screen.getByRole("link", { name: "运行状态" })).toHaveAttribute("href", "/system");
    expect(fetchMock.mock.calls.some(([request]) => request.url.includes("/system/status"))).toBe(true);
    expect(await screen.findByText("当前暂停新收款")).toBeVisible();
  });

  it("keeps the previous statistics and chart visible while loading a different period", async () => {
    const { container, fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "每日收款与订单" });
    const initialChart = container.querySelector(".daily-chart");
    const previous = queryClient.getQueryData<{ data: SystemAnalytics }>(["analytics", 30])!;
    const originalFetch = fetchMock.getMockImplementation()!;
    let finishRange: (response: Response) => void = () => {};
    fetchMock.mockImplementation((request) => new URL(request.url).searchParams.get("range") === "7"
      ? new Promise<Response>((resolve) => { finishRange = resolve; }) : originalFetch(request));
    await userEvent.setup().click(screen.getByRole("button", { name: "近 7 天" }));
    expect(await screen.findByText("正在读取近 7 天，当前显示近 30 天数据")).toBeVisible();
    expect(container.querySelector(".daily-chart")).toBe(initialChart);
    expect(container.querySelector(".metrics-row")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector(".metric-money")).toHaveTextContent("¥0.00");
    await act(async () => { finishRange(json({ data: { ...previous.data, range_days: 7, daily: previous.data.daily.slice(-7), confirmations: { count: 1, amount_cents: 432100 } } })); });
    await waitFor(() => expect(container.querySelector(".metric-money")).toHaveTextContent("¥4,321.00"));
    expect(container.querySelector(".metrics-row")).toHaveAttribute("aria-busy", "false");
    expect(container.querySelector(".daily-chart")).toBe(initialChart);
    expect(screen.queryByText(/当前显示近 30 天数据/)).not.toBeInTheDocument();
  });

  it("does not replace the selected period with a late response after rapid switching", async () => {
    const { container, fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "每日收款与订单" });
    const previous = queryClient.getQueryData<{ data: SystemAnalytics }>(["analytics", 30])!;
    const originalFetch = fetchMock.getMockImplementation()!;
    const pending = new Map<string, (response: Response) => void>();
    fetchMock.mockImplementation((request) => {
      const requested = new URL(request.url).searchParams.get("range");
      return requested === "7" || requested === "90"
        ? new Promise<Response>((resolve) => pending.set(requested, resolve)) : originalFetch(request);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "近 7 天" }));
    await user.click(screen.getByRole("button", { name: "近 90 天" }));
    expect(await screen.findByText("正在读取近 90 天，当前显示近 30 天数据")).toBeVisible();
    await act(async () => { pending.get("90")!(json({ data: { ...previous.data, range_days: 90, confirmations: { count: 1, amount_cents: 9000 } } })); });
    await waitFor(() => expect(container.querySelector(".metric-money")).toHaveTextContent("¥90.00"));
    await act(async () => { pending.get("7")!(json({ data: { ...previous.data, range_days: 7, confirmations: { count: 1, amount_cents: 700 } } })); });
    expect(container.querySelector(".metric-money")).toHaveTextContent("¥90.00");
    expect(screen.getByRole("button", { name: "近 90 天" })).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves first-run configuration guidance on an unconfigured overview", async () => {
    mount({ path: "/" });
    expect(await screen.findByRole("heading", { name: "完成配置，开始收款" })).toBeVisible();
    expect(screen.getByRole("link", { name: /生成应用密钥/ })).toHaveAttribute("href", "/settings/provider");
    expect(screen.queryByRole("region", { name: "收款链路状态" })).not.toBeInTheDocument();
  });

  it("protects category changes and sidebar navigation, then discards only on confirmation", async () => {
    const { router } = mount();
    const { user, field } = await edit();
    expect(unloadIsBlocked()).toBe(true);
    await user.click(screen.getByRole("link", { name: "自动备份" }));
    expect(await screen.findByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/collection");
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(field).toHaveValue(450);
    await user.click(screen.getByRole("link", { name: "订单" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(await screen.findByRole("heading", { name: "订单", level: 1 })).toBeVisible();
    await waitFor(() => expect(unloadIsBlocked()).toBe(false));
  });

  it("blocks browser-back transitions without losing the draft", async () => {
    const { router } = mount();
    const { user, field } = await edit();
    await act(async () => { void router.navigate(-1); });
    expect(await screen.findByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(field).toHaveValue(450);
    expect(router.state.location.pathname).toBe("/settings/collection");
  });

  it("waits for discard confirmation before logout and clears protected data on success", async () => {
    const { fetchMock } = mount();
    const { user } = await edit();
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(fetchMock.mock.calls.some(([request]) => request.url.endsWith("/logout"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    expect(unloadIsBlocked()).toBe(false);
  });

  it("keeps the editor and dirty guard if logout fails", async () => {
    mount({ logoutFailure: true });
    const { user, field } = await edit();
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(await screen.findByText(/服务处理失败/)).toBeVisible();
    expect(field).toHaveValue(450);
    expect(unloadIsBlocked()).toBe(true);
  });

  it("clears dirty state after saving and does not prompt when values are reverted", async () => {
    mount();
    const { user, field } = await edit();
    await user.clear(field); await user.type(field, "300");
    expect(unloadIsBlocked()).toBe(false);
    await user.clear(field); await user.type(field, "450");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await screen.findByText(/配置已保存/);
    await waitFor(() => expect(unloadIsBlocked()).toBe(false));
    await user.click(screen.getByRole("link", { name: "自动备份" }));
    expect(await screen.findByLabelText("备份间隔（秒）")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves a conflicted draft and resets it only after an explicit reload", async () => {
    mount({ conflict: true });
    const { user, field } = await edit();
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText(/配置已在其他会话中更新/)).toBeVisible();
    expect(field).toHaveValue(450);
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(300));
    expect(unloadIsBlocked()).toBe(false);
  });

  it("does not let a draft block session expiry or retain password edits", async () => {
    mount({ path: "/settings/security" });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("新密码"), "unsaved-test-password");
    expect(unloadIsBlocked()).toBe(true);
    act(() => { window.dispatchEvent(new Event("perpay:session-expired")); });
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(screen.queryByDisplayValue("unsaved-test-password")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unloadIsBlocked()).toBe(false);
  });

  it("opens the native mobile drawer and restores the title trigger on Escape", async () => {
    mount();
    await screen.findByLabelText("收银台有效期（秒）");
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "打开导航" });
    await user.click(trigger);
    fireEvent(screen.getByRole("dialog", { name: "导航菜单" }), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
