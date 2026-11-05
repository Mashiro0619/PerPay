import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type AlipayAccount, type SiteCollection, type Site } from "../src/api/client";
import { SiteSettingsPage } from "../src/pages/Sites";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import { alipayAccount, json, settings } from "./fixtures";

const first: AlipayAccount = { ...alipayAccount, name: "主收款账号", health: {
  state: "healthy", last_success_at: "2026-11-05T00:00:00Z", last_error_code: null, collection_ready: true,
} };
const second: AlipayAccount = { ...first, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "备用收款账号", enabled: false };
const configured: SiteCollection["accounts"] = [{ account_id: first.id, weight: 3 }, { account_id: second.id, weight: 1 }];

function mountCollection(collection: SiteCollection | undefined, read: () => Response | Promise<Response>) {
  const site: Site = { client_id: "shop", revision: 1, configuration: {
    name: "业务网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
    ...(collection ? { collection } : {}),
    policy: {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "收银台", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600 },
    },
  }, created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z", deleted_at: null };
  queryClient.removeQueries({ queryKey: ["alipay-accounts"] });
  const fetcher = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/sites/shop") return json({ data: site });
    if (path === "/api/admin/v1/alipay-accounts") return read();
    throw new Error("Unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  const router = createMemoryRouter([{ path: "/sites/:clientId/settings/:section", element: <SiteSettingsPage /> }], {
    initialEntries: ["/sites/shop/settings/collection"],
  });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return fetcher;
}

describe("settings summaries expose the saved values", () => {
  it("shows weighted account identities, IDs, weights and actual collection readiness", async () => {
    mountCollection({ mode: "WEIGHTED", accounts: configured }, () => json({ data: [first, second] }));
    const list = await screen.findByRole("list", { name: "已分配收款账号" });
    await within(list).findByText(first.name);
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(first.id);
    expect(items[0]).toHaveTextContent("当前可收款");
    expect(items[0]).toHaveTextContent("权重 3");
    expect(items[1]).toHaveTextContent(second.name);
    expect(items[1]).toHaveTextContent("已暂停新订单");
    expect(items[1]).toHaveTextContent("权重 1");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "编辑收款账号" })).toHaveAttribute("href", "/sites/shop/edit?section=collection");
  });

  it.each(["FIXED", "RANDOM"] as const)("omits weights for %s allocation", async mode => {
    mountCollection({ mode, accounts: mode === "FIXED" ? configured.slice(0, 1) : configured }, () => json({ data: [first, second] }));
    await screen.findByText("当前可收款");
    expect(screen.queryByText(/权重/)).not.toBeInTheDocument();
    expect(screen.getByText(first.name)).toBeVisible();
  });

  it("retains historical account IDs and weights when the account is absent from a successful catalog read", async () => {
    mountCollection({ mode: "WEIGHTED", accounts: configured.slice(0, 1) }, () => json({ data: [] }));
    expect(await screen.findByText("账号不存在或已删除，请核对历史配置")).toBeVisible();
    expect(screen.getByText(first.id, { exact: true })).toBeVisible();
    expect(screen.getByText("权重 3")).toBeVisible();
    expect(screen.queryByText("未分配")).not.toBeInTheDocument();
  });

  it("preserves configured accounts on catalog failure and recovers names through retry", async () => {
    let failed = true;
    mountCollection({ mode: "WEIGHTED", accounts: configured }, () => failed
      ? json({ error: { code: "alipay_accounts_unavailable", message: "账号目录暂不可用" } }, 503)
      : json({ data: [first, second] }));
    await screen.findByText("账号目录暂不可用");
    expect(screen.getByText(first.id, { exact: true })).toBeVisible();
    expect(screen.getByText(second.id, { exact: true })).toBeVisible();
    expect(screen.getByText("权重 3")).toBeVisible();
    expect(screen.queryByText(/账号不存在或已删除/)).not.toBeInTheDocument();
    expect(screen.queryByText("未分配")).not.toBeInTheDocument();
    failed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("当前可收款");
    expect(screen.getByText(first.name)).toBeVisible();
  });

  it("does not present cached readiness as current after a catalog refresh fails", async () => {
    let failed = false;
    mountCollection({ mode: "FIXED", accounts: configured.slice(0, 1) }, () => failed
      ? json({ error: { code: "alipay_accounts_unavailable", message: "账号目录更新失败" } }, 503)
      : json({ data: [first] }));
    await screen.findByText("当前可收款");
    failed = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["alipay-accounts"] }); });
    await screen.findByText("账号目录更新失败");
    expect(screen.getByText(first.name)).toBeVisible();
    expect(screen.getByText("可用状态待确认")).toBeVisible();
    expect(screen.queryByText("当前可收款")).not.toBeInTheDocument();
  });

  it("labels an actually unassigned website without reading the account catalog", async () => {
    const fetcher = mountCollection(undefined, () => { throw new Error("No catalog needed"); });
    await screen.findByText("未分配");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("marks cached readiness unconfirmed while its refresh is paused offline", async () => {
    mountCollection({ mode: "FIXED", accounts: configured.slice(0, 1) }, () => json({ data: [first] }));
    await screen.findByText("当前可收款");
    try {
      await act(async () => {
        onlineManager.setOnline(false);
        await queryClient.invalidateQueries({ queryKey: ["alipay-accounts"] });
      });
      await screen.findByText("等待网络恢复，账号可用状态未确认。");
      expect(screen.getByText(first.name)).toBeVisible();
      expect(screen.queryByText("当前可收款")).not.toBeInTheDocument();
    } finally {
      await act(async () => { onlineManager.setOnline(true); });
    }
  });

  it.each([true, false])("shows every saved CIDR while the whitelist is enabled=%s", async enabled => {
    const cidrs = ["192.0.2.0/24", "2001:db8:1234:5678::/64"];
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [] })));
    const router = createMemoryRouter([{ path: "/settings/security", element: <SecuritySettings
      settings={{ ...settings, admin_access: { enabled, cidrs } }} onSaved={vi.fn()} /> }], { initialEntries: ["/settings/security"] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const list = screen.getByRole("list", { name: "已保存的白名单规则" });
    expect(within(list).getAllByRole("listitem").map(item => item.textContent)).toEqual(cidrs);
    const summary = screen.getByRole("heading", { name: "管理员 IP 白名单" }).closest("[data-settings-summary]")! as HTMLElement;
    expect(within(summary).getByText(enabled ? "已启用" : "未启用")).toBeVisible();
    expect(within(summary).queryByRole("textbox")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("正在读取登录会话…")).not.toBeInTheDocument());
  });
});
