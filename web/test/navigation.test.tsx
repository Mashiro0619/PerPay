// Preload the real chart module outside per-interaction timeouts.
import "../src/pages/Dashboard";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { appRoutes } from "../src/App";
import { queryClient, type SystemAnalytics } from "../src/api/client";
import { apiError, json, settings } from "./fixtures";
import { systemStatus } from "./onboarding-fixture";

function mount(
  options: {
    conflict?: boolean;
    logoutFailure?: boolean;
    path?: string;
    configured?: boolean;
    mobile?: boolean;
  } = {},
) {
  if (!document.querySelector('meta[name="perpay-initialized"]')) {
    const metadata = document.createElement("meta");
    metadata.name = "perpay-initialized";
    metadata.content = "true";
    document.head.append(metadata);
  }

  vi.stubGlobal("innerWidth", options.mobile ? 390 : 1440);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: !!options.mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  let saved = structuredClone(settings);
  if (options.configured) saved.completion.complete = true;
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/session")
      return json({
        data: {
          username: "admin",
          csrf_token_required: true,
          idle_expires_at: "2099-01-01T00:00:00Z",
          absolute_expires_at: "2099-01-01T00:00:00Z",
        },
      });
    if (path === "/api/admin/v1/system/status")
      return json({
        data: {
          ...systemStatus(saved),
          status: "not_ready",
          configured: !!options.configured,
        },
      });
    if (path === "/api/admin/v1/system/analytics")
      return json({
        data: {
          range_days: 30,
          from: "2026-08-08T16:00:00.000Z",
          to: "2026-09-07T16:00:00.000Z",
          orders: {
            created: 0,
            unpaid: 0,
            confirmed: 0,
            disputed: 0,
            closed: 0,
            expired: 0,
          },
          confirmations: { count: 0, amount_cents: 0 },
          notifications: { acknowledged: 0, failed: 0, pending: 0 },
          pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
          daily: Array.from({ length: 30 }, (_, dayIndex) => ({
            date: new Date(Date.UTC(2026, 7, dayIndex + 9))
              .toISOString()
              .slice(0, 10),
            orders_created: 0,
            confirmations: 0,
            confirmed_amount_cents: 0,
            notifications_acknowledged: 0,
            notifications_failed: 0,
          })),
        },
      });
    if (path === "/api/admin/v1/settings") return json({ data: saved });
    if (path === "/api/admin/v1/orders")
      return json({ data: [], page: { next_cursor: null } });
    if (path === "/api/admin/v1/work-items")
      return json({ data: [], page: { next_cursor: null } });
    if (path === "/api/admin/v1/password")
      return new Response(null, { status: 204 });
    if (path === "/api/admin/v1/session/logout")
      return options.logoutFailure
        ? apiError("internal_error", "logout failed", 503)
        : new Response(null, { status: 204 });
    if (request.method === "PUT") {
      if (options.conflict)
        return apiError("settings_revision_conflict", "stale revision");
      const body = (await request.json()) as { order_ttl_seconds: number };
      saved = {
        ...saved,
        revision: saved.revision + 1,
        collection: {
          ...saved.collection!,
          order_ttl_seconds: body.order_ttl_seconds,
        },
      };
      return json({ data: saved });
    }
    return apiError("route_not_found", "unexpected test request", 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter(appRoutes, {
    initialEntries: ["/orders", options.path ?? "/settings/collection"],
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, fetchMock, ...view };
}

async function edit() {
  const user = userEvent.setup();
  const field = await screen.findByLabelText("收银台有效期（秒）");
  await user.clear(field);
  await user.type(field, "450");
  return { user, field };
}

function unloadIsBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("navigation and draft protection", () => {
  it.each(["manager", "navigator"])(
    "does not queue an offline password change after discarding the draft (%s)",
    async (source) => {
      const view = mount({ path: "/settings/security" });
      const user = userEvent.setup();
      await user.type(
        await screen.findByLabelText("新密码"),
        "offline-test-password",
      );
      await user.type(
        screen.getByLabelText("再次输入新密码"),
        "offline-test-password",
      );
      const writes = () =>
        view.fetchMock.mock.calls.filter(
          ([request]) =>
            new URL(request.url).pathname === "/api/admin/v1/password",
        );
      const online = vi.spyOn(navigator, "onLine", "get");
      try {
        if (source === "manager") act(() => onlineManager.setOnline(false));
        else online.mockReturnValue(false);
        await user.click(
          screen.getByRole("button", { name: "修改并重新登录" }),
        );
        expect(
          await screen.findByText(
            "网络已断开，密码未提交。恢复连接后请重新提交。",
          ),
        ).toBeVisible();
        expect(writes()).toHaveLength(0);
        expect(
          queryClient
            .getMutationCache()
            .getAll()
            .some((mutation) => mutation.state.isPaused),
        ).toBe(false);
        await user.click(screen.getByRole("link", { name: "订单" }));
        await user.click(
          await screen.findByRole("button", { name: "放弃修改并继续" }),
        );
        await waitFor(() =>
          expect(view.router.state.location.pathname).toBe("/orders"),
        );
        online.mockReturnValue(true);
        await act(async () => {
          onlineManager.setOnline(true);
          await queryClient.resumePausedMutations();
        });
        expect(writes()).toHaveLength(0);
        expect(
          screen.queryByDisplayValue("offline-test-password"),
        ).not.toBeInTheDocument();
      } finally {
        online.mockRestore();
        act(() => onlineManager.setOnline(true));
      }
    },
  );

  it("requires an explicit resubmit after an offline password failure", async () => {
    const view = mount({ path: "/settings/security" });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("新密码"),
      "resubmit-test-password",
    );
    await user.type(
      screen.getByLabelText("再次输入新密码"),
      "resubmit-test-password",
    );
    const writes = () =>
      view.fetchMock.mock.calls.filter(
        ([request]) =>
          new URL(request.url).pathname === "/api/admin/v1/password",
      );
    try {
      act(() => onlineManager.setOnline(false));
      await user.click(screen.getByRole("button", { name: "修改并重新登录" }));
      await screen.findByText("网络已断开，密码未提交。恢复连接后请重新提交。");
      await act(async () => {
        onlineManager.setOnline(true);
        await queryClient.resumePausedMutations();
      });
      expect(writes()).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: "修改并重新登录" }));
      expect(
        await screen.findByRole("heading", { name: "登录管理后台" }),
      ).toBeVisible();
      expect(writes()).toHaveLength(1);
      expect(await writes()[0]![0].clone().json()).toEqual({
        new_password: "resubmit-test-password",
      });
    } finally {
      act(() => onlineManager.setOnline(true));
    }
  });

  it("keeps the same default tabs on narrow screens and activates explicitly", async () => {
    const view = mount({
      path: "/settings/display",
      configured: true,
      mobile: true,
    });
    const list = await screen.findByRole("tablist", { name: "设置分类" });
    expect(list).toHaveAttribute("data-variant", "default");
    expect(list.closest("[data-settings-tabs-scroll]")).toHaveClass(
      "no-scrollbar",
      "overflow-x-auto",
    );
    const selector = screen.getByRole("tab", { name: "界面显示" });
    expect(selector).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("combobox", { name: "设置分类" }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "经营码与订单" }));
    await screen.findByLabelText("收银台有效期（秒）");
    expect(view.router.state.location.pathname).toBe("/settings/collection");
    expect(screen.getByRole("tab", { name: "经营码与订单" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      view.fetchMock.mock.calls.some(([request]) => request.method !== "GET"),
    ).toBe(false);
  });

  it("preserves a dirty form and the selected settings tab after cancelling navigation", async () => {
    const view = mount();
    const { user, field } = await edit();
    const selector = screen.getByRole("tab", { name: "界面显示" });
    await user.click(selector);
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toBeVisible();
    expect(confirmation).toHaveClass(
      "max-h-[calc(100dvh-2rem)]",
      "w-[calc(100%-2rem)]",
      "overflow-hidden",
    );
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(view.router.state.location.pathname).toBe("/settings/collection");
    expect(field).toHaveValue(450);
    expect(screen.getByRole("tab", { name: "经营码与订单" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await waitFor(() => expect(selector).toHaveFocus());
    expect(unloadIsBlocked()).toBe(true);
    expect(
      view.fetchMock.mock.calls.some(([request]) => request.method !== "GET"),
    ).toBe(false);
  });
  it("moves tab focus with arrows without discarding drafts until Enter activates", async () => {
    const view = mount({ mobile: true });
    const { user, field } = await edit();
    const selected = screen.getByRole("tab", { name: "经营码与订单" });
    selected.focus();
    await user.keyboard("{ArrowRight}");
    const notifications = screen.getByRole("tab", { name: "业务通知" });
    expect(notifications).toHaveFocus();
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(field).toHaveValue(450);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(view.router.state.location.pathname).toBe("/settings/collection");
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(field).toHaveValue(450);
  });

  it("keeps the test-payment action accessible while compacting its visible label on small screens", async () => {
    const { container } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "收款趋势" });
    const testPayment = container.querySelector(
      'header button[aria-haspopup="dialog"]',
    );
    expect(testPayment).not.toHaveClass("hidden");
    expect(testPayment).toHaveClass("inline-flex");
    expect(testPayment).toHaveAccessibleName("测试收款");
    expect(testPayment?.querySelector("span")).toHaveClass(
      "sr-only",
      "sm:not-sr-only",
    );
  });
  it("uses the official account menu without duplicate branding or palette controls", async () => {
    const { container, fetchMock } = mount();
    await screen.findByLabelText("收银台有效期（秒）");
    const user = userEvent.setup();
    expect(screen.getByRole("link", { name: "PerPay" })).toBeVisible();
    expect(
      container.querySelector(
        ".topbar, .instance-label, .sidebar-version, .workspace-footer",
      ),
    ).toBeNull();
    expect(screen.queryByText("个人收款实例")).not.toBeInTheDocument();
    const account = screen.getByRole("button", { name: "账户菜单" });
    await user.click(account);
    expect(
      await screen.findByRole("menuitem", { name: "退出登录" }),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([request]) => request.url.endsWith("/logout")),
    ).toBe(false);
    await user.keyboard("{Escape}");
    expect(account).toHaveFocus();
    expect(screen.getByRole("button", { name: /外观/ })).toBeVisible();
    expect(screen.queryByText("经典蓝")).not.toBeInTheDocument();
  });
  it("surfaces a real outage without hiding payment statistics behind it", async () => {
    const { container, fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "收款趋势" });
    expect(
      container.querySelector(".payment-pipeline, .daily-chart"),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "待处理" })).toBeVisible();
    expect(await screen.findByText("当前暂停新收款")).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "统计口径" }));
    expect(
      await screen.findByText(/待付款为当前开放且未付款的订单/),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([request]) =>
        request.url.includes("/system/status"),
      ),
    ).toBe(true);
  });
  it("shows a loading state rather than labeling old statistics as a new period", async () => {
    const { container, fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "收款趋势" });
    const previous = queryClient.getQueryData<{ data: SystemAnalytics }>([
      "analytics",
      30,
    ])!;
    const originalFetch = fetchMock.getMockImplementation()!;
    let finishRange: (response: Response) => void = () => {};
    fetchMock.mockImplementation((request) =>
      new URL(request.url).searchParams.get("range") === "7"
        ? new Promise<Response>((resolve) => {
            finishRange = resolve;
          })
        : originalFetch(request),
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "近 7 天" }));
    expect(await screen.findByText("正在读取近 7 天…")).toBeVisible();
    expect(container.querySelector("[data-slot=chart]")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "每日数据" }));
    const daily = screen.getByRole("region", { name: "每日数据" });
    expect(daily).toHaveAttribute("aria-busy", "true");
    expect(within(daily).queryAllByRole("cell")).toHaveLength(0);
    await act(async () => {
      finishRange(
        json({
          data: {
            ...previous.data,
            range_days: 7,
            daily: previous.data.daily.slice(-7),
            confirmations: { count: 1, amount_cents: 432100 },
          },
        }),
      );
    });
    expect(
      await screen.findByRole("tab", { name: "每日数据" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("正在读取近 7 天…")).not.toBeInTheDocument();
    expect(daily).not.toHaveAttribute("aria-busy", "true");

    expect(within(daily).getAllByRole("row")).toHaveLength(8);
  });
  it("does not replace the selected period with a late response after rapid switching", async () => {
    const { fetchMock } = mount({ path: "/", configured: true });
    await screen.findByRole("heading", { name: "收款趋势" });
    const previous = queryClient.getQueryData<{ data: SystemAnalytics }>([
      "analytics",
      30,
    ])!;
    const originalFetch = fetchMock.getMockImplementation()!;
    const pending = new Map<string, (response: Response) => void>();
    fetchMock.mockImplementation((request) => {
      const requested = new URL(request.url).searchParams.get("range");
      return requested === "7" || requested === "90"
        ? new Promise<Response>((resolve) => pending.set(requested, resolve))
        : originalFetch(request);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "近 7 天" }));
    await user.click(screen.getByRole("button", { name: "近 90 天" }));
    expect(await screen.findByText("正在读取近 90 天…")).toBeVisible();
    await act(async () => {
      pending.get("90")!(
        json({
          data: {
            ...previous.data,
            range_days: 90,
            confirmations: { count: 1, amount_cents: 9000 },
          },
        }),
      );
    });
    expect(await screen.findByText("¥90.00")).toBeVisible();
    await act(async () => {
      pending.get("7")!(
        json({
          data: {
            ...previous.data,
            range_days: 7,
            confirmations: { count: 1, amount_cents: 700 },
          },
        }),
      );
    });
    expect(screen.getByText("¥90.00")).toBeVisible();
    expect(screen.getByRole("button", { name: "近 90 天" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  it("sends an unconfigured instance to its next required setup step", async () => {
    const { router } = mount({ path: "/" });
    expect(
      await screen.findByRole("navigation", { name: "配置步骤" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toMatch(/^\/settings\/onboarding\//);
  });
  it("protects category changes and sidebar navigation, then discards only on confirmation", async () => {
    const { router } = mount();
    const { user, field } = await edit();
    expect(unloadIsBlocked()).toBe(true);
    await user.click(screen.getByRole("tab", { name: "自动备份" }));
    expect(
      await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/collection");
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(field).toHaveValue(450);
    await user.click(screen.getByRole("link", { name: "订单" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(
      await screen.findByRole("heading", { name: "订单", level: 1 }),
    ).toBeVisible();
    await waitFor(() => expect(unloadIsBlocked()).toBe(false));
  });

  it("blocks browser-back transitions without losing the draft", async () => {
    const { router } = mount();
    const { user, field } = await edit();
    await act(async () => {
      void router.navigate(-1);
    });
    expect(
      await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(field).toHaveValue(450);
    expect(router.state.location.pathname).toBe("/settings/collection");
  });

  it("waits for discard confirmation before logout and clears protected data on success", async () => {
    const { fetchMock } = mount();
    const { user } = await edit();
    await user.click(screen.getByRole("button", { name: "账户菜单" }));
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(
      fetchMock.mock.calls.some(([request]) => request.url.endsWith("/logout")),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(
      await screen.findByRole("heading", { name: "登录管理后台" }),
    ).toBeVisible();
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    expect(unloadIsBlocked()).toBe(false);
  });

  it("keeps the editor and dirty guard if logout fails", async () => {
    mount({ logoutFailure: true });
    const { user, field } = await edit();
    await user.click(screen.getByRole("button", { name: "账户菜单" }));
    await user.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    expect(await screen.findByText(/服务处理失败/)).toBeVisible();
    expect(field).toHaveValue(450);
    expect(unloadIsBlocked()).toBe(true);
  });

  it("clears dirty state after saving and does not prompt when values are reverted", async () => {
    mount();
    const { user, field } = await edit();
    await user.clear(field);
    await user.type(field, "300");
    expect(unloadIsBlocked()).toBe(false);
    await user.clear(field);
    await user.type(field, "450");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/已保存/);
    await waitFor(() => expect(unloadIsBlocked()).toBe(false));
    await user.click(screen.getByRole("tab", { name: "自动备份" }));
    expect(await screen.findByLabelText("备份间隔")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves a conflicted draft and resets it only after an explicit reload", async () => {
    mount({ conflict: true });
    const { user, field } = await edit();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/配置已在其他会话中更新/)).toBeVisible();
    expect(field).toHaveValue(450);
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await user.click(screen.getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() =>
      expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(300),
    );
    expect(unloadIsBlocked()).toBe(false);
  });

  it("does not let a draft block session expiry or retain password edits", async () => {
    mount({ path: "/settings/security" });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("新密码"),
      "unsaved-test-password",
    );
    expect(unloadIsBlocked()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("perpay:session-expired"));
    });
    expect(
      await screen.findByRole("heading", { name: "登录管理后台" }),
    ).toBeVisible();
    expect(
      screen.queryByDisplayValue("unsaved-test-password"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unloadIsBlocked()).toBe(false);
  });

  it("uses the official mobile sidebar and restores its trigger on Escape", async () => {
    mount({ mobile: true });
    await screen.findByLabelText("收银台有效期（秒）");
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "切换导航" });
    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "导航菜单" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
});

describe("overview layout and demo indicator", () => {
  it("places trends immediately after metrics, before recent activity and daily detail", async () => {
    mount({ path: "/", configured: true });
    const trend = await screen.findByRole("heading", { name: "收款趋势" });
    const metrics = screen.getByText("今日确认金额", { exact: true });
    const work = screen.getByRole("heading", { name: "待处理" });
    const recent = screen.getByRole("heading", {
      name: "最近订单",
    });
    const daily = screen.getByRole("tab", { name: "每日数据" });
    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(trend.closest("[data-content-width]")).toHaveClass("max-w-7xl", "mx-auto");
    expect(trend.closest("[data-overview-layout]")).not.toHaveClass("max-w-7xl", "mx-auto");
    expect(daily).toHaveAttribute("aria-selected", "false");
    expect(
      screen.queryByRole("table", { name: "每日收款数据" }),
    ).not.toBeInTheDocument();
    expect(precedes(metrics, trend)).toBe(true);
    expect(precedes(trend, work)).toBe(true);
    expect(precedes(trend, recent)).toBe(true);
    expect(precedes(daily, work)).toBe(true);
    expect(daily.closest("[data-slot=card]")).toBe(
      trend.closest("[data-slot=card]"),
    );
    expect(
      screen.queryByRole("button", { name: "只读演示说明" }),
    ).not.toBeInTheDocument();
  });

  it("keeps demo identification in the existing header with an on-demand accessible explanation", async () => {
    document.documentElement.dataset.perpayDemo = "readonly";
    try {
      mount({ path: "/", configured: true });
      const trigger = await screen.findByRole("button", {
        name: "只读演示说明",
      });
      expect(trigger.closest("header")).not.toBeNull();
      expect(screen.queryByText(/全部为合成数据/)).not.toBeInTheDocument();
      const user = userEvent.setup();
      trigger.focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByText(/健康状态为模拟/)).toBeVisible();
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByText(/全部为合成数据/)).not.toBeInTheDocument(),
      );
      expect(trigger).toHaveFocus();
    } finally {
      delete document.documentElement.dataset.perpayDemo;
    }
  });
});

describe("page actions in the shared header", () => {
  it.each([false, true])(
    "places settings actions before appearance without duplicates (mobile: %s)",
    async (mobile) => {
      const { container, router } = mount({ mobile, configured: true });
      await screen.findByLabelText("收银台有效期（秒）");
      const header = container.querySelector("header")!;
      const wizard = within(header).getByRole("link", { name: "配置向导" });
      const refresh = within(header).getByRole("button", { name: "刷新" });
      const theme = within(header).getByRole("button", { name: /外观/ });
      expect(
        wizard.compareDocumentPosition(theme) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        refresh.compareDocumentPosition(theme) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "刷新" })).toHaveLength(1);
      expect(screen.getAllByRole("link", { name: "配置向导" })).toHaveLength(1);
      await act(async () => {
        await router.navigate("/system");
      });
      expect(
        await within(header).findByRole("button", { name: "刷新" }),
      ).toBeVisible();
      expect(
        within(header).queryByRole("link", { name: "配置向导" }),
      ).not.toBeInTheDocument();
      expect(
        container.querySelector('#main-content button[title="刷新"]'),
      ).toBeNull();
      await act(async () => {
        await router.navigate("/orders");
      });
      expect(
        within(header).queryByRole("button", { name: "刷新" }),
      ).not.toBeInTheDocument();
      expect(
        header.querySelector("[data-page-header-actions]"),
      ).toBeEmptyDOMElement();
    },
  );

  it("keeps dirty settings when header refresh or wizard navigation is cancelled", async () => {
    const { fetchMock, router } = mount();
    const { user, field } = await edit();
    const reads = () =>
      fetchMock.mock.calls.filter(
        ([request]) =>
          new URL(request.url).pathname === "/api/admin/v1/settings",
      ).length;
    const before = reads();
    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh.closest("header")).not.toBeNull();
    await user.click(refresh);
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(field).toHaveValue(450);
    expect(reads()).toBe(before);
    await waitFor(() => expect(refresh).toHaveFocus());
    await user.click(screen.getByRole("link", { name: "配置向导" }));
    await user.click(await screen.findByRole("button", { name: "继续编辑" }));
    expect(router.state.location.pathname).toBe("/settings/collection");
    expect(field).toHaveValue(450);
    expect(unloadIsBlocked()).toBe(true);
  });

  it("disables the header refresh while the page's request is in flight", async () => {
    const { fetchMock } = mount({ path: "/system", configured: true });
    const refresh = await screen.findByRole("button", { name: "刷新" });
    expect(refresh.closest("header")).not.toBeNull();
    await waitFor(() => expect(refresh).toBeEnabled());
    const original = fetchMock.getMockImplementation()!;
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation((request) =>
      new URL(request.url).pathname === "/api/admin/v1/system/status"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(request),
    );
    await userEvent.click(refresh);
    await waitFor(() => expect(refresh).toBeDisabled());
    await act(async () => {
      finish(json({ data: systemStatus() }));
    });
    await waitFor(() => expect(refresh).toBeEnabled());
  });
});


describe("shared content width navigation", () => {
  beforeEach(() => localStorage.removeItem("perpay:content-width"));
  afterEach(() => localStorage.removeItem("perpay:content-width"));

  it("keeps settings drafts, sidebar, focus, route and requests unchanged while switching", async () => {
    const { router, fetchMock, container } = mount({ configured: true });
    const { user, field } = await edit();
    const before = fetchMock.mock.calls.length;
    const location = router.state.location;
    const sidebar = container.querySelector("[data-slot=sidebar]");
    const sidebarState = sidebar?.getAttribute("data-state");
    const control = screen.getByRole("button", { name: "切换为全屏布局" });
    const appearance = screen.getByRole("button", { name: /外观/ });
    expect(control.closest("header")).toBe(appearance.closest("header"));
    expect(control.compareDocumentPosition(appearance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(control);
    expect(container.querySelector("[data-content-width]")).toHaveAttribute("data-content-width", "full");
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(field);
    expect(field).toHaveValue(450);
    expect(unloadIsBlocked()).toBe(true);
    expect(router.state.location).toBe(location);
    expect(sidebar?.getAttribute("data-state")).toBe(sidebarState);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(control).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("retains the layout between routes and does not reset order filters", async () => {
    const path = "/orders?q=long&sort_by=created_at&sort_order=asc&created_from=2026-10-01&created_to=2026-10-02";
    const { router, container, fetchMock } = mount({ configured: true, path });
    await screen.findByRole("heading", { name: "订单" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([request]) => new URL(request.url).pathname === "/api/admin/v1/orders")).toBe(true));
    const before = fetchMock.mock.calls.length;
    const location = router.state.location;
    await userEvent.click(screen.getByRole("button", { name: "切换为全屏布局" }));
    expect(router.state.location).toBe(location);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await act(async () => { await router.navigate("/system"); });
    expect(await screen.findByRole("button", { name: "切换为收缩布局" })).toBeVisible();
    expect(container.querySelector("[data-content-width]")).toHaveAttribute("data-content-width", "full");
  });

  it("does not reset daily-table tab, pagination or analytics observers", async () => {
    const { fetchMock, container } = mount({ path: "/", configured: true });
    const tab = await screen.findByRole("tab", { name: "每日数据" });
    await userEvent.click(tab);
    const table = await screen.findByRole("table", { name: "每日收款数据" });
    await userEvent.click(screen.getByRole("button", { name: "每日数据下一页" }));
    const firstDate = table.querySelector("time")?.dateTime;
    const before = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "切换为全屏布局" }));
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("table", { name: "每日收款数据" })).toBe(table);
    expect(table.querySelector("time")?.dateTime).toBe(firstDate);
    expect(screen.getByText("第 2 / 3 页 · 共 30 天")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(container.querySelector("[data-overview-layout]")).not.toHaveClass("max-w-7xl", "px-4");
  });
});


describe("layout changes during active requests", () => {
  beforeEach(() => localStorage.removeItem("perpay:content-width"));
  afterEach(() => localStorage.removeItem("perpay:content-width"));
  it("keeps a pending page refresh and its original signal without sending a second request", async () => {
    const { fetchMock } = mount({ path: "/system", configured: true });
    const refresh = await screen.findByRole("button", { name: "刷新" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const original = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let pendingRequest!: Request;
    fetchMock.mockImplementation((request) =>
      new URL(request.url).pathname === "/api/admin/v1/system/status"
        ? new Promise(resolve => { finish = resolve; pendingRequest = request; })
        : original(request),
    );
    await userEvent.click(refresh);
    await waitFor(() => expect(refresh).toBeDisabled());
    const count = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "切换为全屏布局" }));
    expect(screen.getByRole("button", { name: "刷新" })).toBe(refresh);
    expect(refresh).toBeDisabled();
    expect(pendingRequest.signal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await act(async () => { finish(json({ data: systemStatus() })); });
    await waitFor(() => expect(refresh).toBeEnabled());
  });
});
