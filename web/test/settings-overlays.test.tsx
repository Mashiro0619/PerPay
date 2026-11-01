import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryClient, type AdminLoginSession, type AlipayAccount, type Site } from "../src/api/client";
import { mergeSiteConfiguration } from "../src/lib/site-configuration";
import { apiError, json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

function sampleSite(): Site {
  return { client_id: "overlay_site", revision: 1, configuration: {
    name: "弹窗测试网站", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
    policy: {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
    },
  }, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z", deleted_at: null };
}

function sampleAccount(): AlipayAccount {
  return { id: "11111111-1111-4111-8111-111111111111", revision: 1, name: "弹窗账号", enabled: true, configured: true, environment: "PRODUCTION", app_id: "app-original", code_payload: "https://qr.alipay.com/overlay", platform_public_key: "public-key", provider_account_key: "provider", application_public_key: "application-public-key", application_key_fingerprint: "a".repeat(64), pending_application_key: null, sites: [], deletable: true, last_check: null, created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z" };
}

function footer(dialog: HTMLElement) {
  const element = dialog.querySelector<HTMLElement>("[data-overlay-actions]");
  expect(element).not.toBeNull();
  return within(element!);
}

describe("settings summaries and owned editing overlays", () => {
  it("moves website metrics into its overview and never labels a previous period as the newly requested one", async () => {
    const site = sampleSite();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mountOnboarding({ stage: 4, path: "/sites/overlay_site/summary?range=7", handle: request => {
      const url = new URL(request.url), path = url.pathname;
      if (path === "/api/admin/v1/sites") return json({ data: [site], page: { next_cursor: null } });
      if (path === "/api/admin/v1/sites/overlay_site") return json({ data: site });
      if (path.endsWith("/analytics")) return url.searchParams.get("range") === "30" ? pending : json({ data: { confirmations: { count: 17, amount_cents: 12901 }, pending: { orders: 23 } } });
      if (path.endsWith("/work-items/summary")) return json({ data: { total: 5 } });
      return undefined;
    } });
    const dialog = await screen.findByRole("dialog", { name: site.configuration.name });
    const metric = (label: string) => within(dialog).getByText(label, { selector: "dt" }).nextElementSibling;
    await waitFor(() => expect(metric("近 7 天实收")).toHaveTextContent("¥129.01"));
    expect(metric("收款确认笔数")).toHaveTextContent(/^17$/);
    expect(metric("当前待付款")).toHaveTextContent(/^23$/);
    expect(metric("待处理")).toHaveTextContent(/^5$/);
    expect(metric("通知")).toHaveTextContent(/^关闭$/);
    const source = view.router.state.location;
    const nextSearch = new URLSearchParams(source.search);
    nextSearch.set("overlay", "/sites/overlay_site/summary?range=30");
    await act(async () => { await view.router.navigate(source.pathname + "?" + nextSearch); });
    expect(metric("近 30 天实收")).toHaveTextContent("正在读取…");
    expect(within(dialog).queryByText("¥129.01")).not.toBeInTheDocument();
    await act(async () => { release(apiError("internal_error", "周期统计暂不可用", 503)); });
    await waitFor(() => expect(metric("近 30 天实收")).toHaveTextContent("暂不可用"));
    expect(within(dialog).queryByText("¥0.00")).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("opens display editing over its summary and cancels without losing the source URL or silently saving", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/display?selected_site=site_test" });
    const user = userEvent.setup();
    const edit = await screen.findByRole("link", { name: "编辑界面显示" });
    expect(screen.queryByLabelText("支付系统名称")).not.toBeInTheDocument();
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "编辑界面显示" });
    const name = within(dialog).getByLabelText("支付系统名称");
    await user.clear(name); await user.type(name, "尚未保存的名称");
    await user.click(footer(dialog).getByRole("button", { name: "关闭" }));
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    expect(name).toHaveValue("尚未保存的名称");
    await user.click(footer(dialog).getByRole("button", { name: "关闭" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.router.state.location.pathname).toBe("/settings/display");
    expect(new URLSearchParams(view.router.state.location.search).get("selected_site")).toBe("site_test");
    expect(view.writes()).toHaveLength(0);
  });

  it("submits the portalled settings action against its owning form and updates the summary", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/display" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "编辑界面显示" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑界面显示" });
    const field = within(dialog).getByLabelText("支付系统名称");
    await user.clear(field); await user.type(field, "保存后的系统名称");
    const save = footer(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.closest("form")).toBeNull();
    expect(save.form).toBe(field.closest("form"));
    await user.click(save);
    await waitFor(() => expect(view.saved.display.system_name).toBe("保存后的系统名称"));
    expect(view.writes()).toHaveLength(1);
    expect(new URL(view.writes()[0]!.url).pathname).toBe("/api/admin/v1/settings/display");
    await user.click(footer(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("保存后的系统名称", { exact: true, selector: "dd" })).toBeVisible();
  });

  it("keeps changes from every website tab when reviewing a newer remote configuration", async () => {
    let saved = sampleSite();
    const writes: Site["configuration"][] = [];
    mountOnboarding({ stage: 4, path: "/sites/overlay_site/settings/basic", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sites") return json({ data: [saved], page: { next_cursor: null } });
      if (path !== "/api/admin/v1/sites/overlay_site") return undefined;
      if (request.method === "GET") return json({ data: saved });
      return (async () => {
        const input = await request.clone().json() as { revision: number; configuration: Site["configuration"] };
        writes.push(input.configuration);
        if (writes.length === 1) {
          saved = { ...saved, revision: 2, configuration: { ...saved.configuration, policy: { ...saved.configuration.policy, display: { ...saved.configuration.policy.display, checkout_help_url: "https://example.com/latest-help" } } } };
          return apiError("site_revision_conflict", "网站配置已更新", 409);
        }
        saved = { ...saved, revision: 3, configuration: input.configuration };
        return json({ data: saved });
      })();
    } });
    const user = userEvent.setup();
    const edit = await screen.findByRole("link", { name: "编辑基本信息" });
    expect(screen.queryByLabelText("业务网站名称")).not.toBeInTheDocument();
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "编辑弹窗测试网站" });
    const name = within(dialog).getByLabelText("业务网站名称");
    await user.clear(name); await user.type(name, "两个分组的修改");
    await user.click(within(dialog).getByRole("tab", { name: "订单设置" }));
    fireEvent.change(within(dialog).getByLabelText("收银台有效期（秒）"), { target: { value: "600" } });
    await user.click(footer(dialog).getByRole("button", { name: "保存业务网站" }));
    await user.click(await within(dialog).findByRole("button", { name: "读取最新配置并核对" }));
    await waitFor(() => expect(footer(dialog).getByRole("button", { name: "保存业务网站" })).toBeEnabled());
    await user.click(within(dialog).getByRole("tab", { name: "基本信息" }));
    expect(within(dialog).getByLabelText("业务网站名称")).toHaveValue("两个分组的修改");
    await user.click(footer(dialog).getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ name: "两个分组的修改", policy: { orders: { order_ttl_seconds: 600 }, display: { checkout_help_url: "https://example.com/latest-help" } } });
  });

  it("retains account fields across modal tabs and saves one complete account draft", async () => {
    let account = sampleAccount();
    const writes: Record<string, unknown>[] = [];
    mountOnboarding({ stage: 4, path: "/settings/accounts/" + account.id, handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/alipay-accounts") return json({ data: [account] });
      if (path !== "/api/admin/v1/alipay-accounts/" + account.id) return undefined;
      if (request.method === "GET") return json({ data: account });
      return (async () => { const input = await request.clone().json(); writes.push(input); account = { ...account, ...input, revision: 2 }; return json({ data: account }); })();
    } });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "支付宝账号" });
    const name = await within(dialog).findByLabelText("账号名称");
    await user.click(footer(dialog).getByRole("button", { name: "更多账号操作" }));
    expect(await screen.findByRole("menuitem", { name: "保存草稿" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "重新检查" })).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.clear(name); await user.type(name, "跨分组账号");
    await user.click(within(dialog).getByRole("tab", { name: "应用信息" }));
    const appId = within(dialog).getByLabelText("应用 ID（App ID）");
    await user.clear(appId); await user.type(appId, "app-updated");
    await user.click(within(dialog).getByRole("tab", { name: "收款码" }));
    await user.click(within(dialog).getByRole("tab", { name: "基本信息" }));
    expect(within(dialog).getByLabelText("账号名称")).toHaveValue("跨分组账号");
    await user.click(footer(dialog).getByRole("button", { name: "更多账号操作" }));
    expect(await screen.findByRole("menuitem", { name: "重新检查" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "保存草稿" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ name: "跨分组账号", app_id: "app-updated", code_payload: "https://qr.alipay.com/overlay", revision: 1 });
  });

  it("returns secondary-action validation focus to an invalid field in another account tab without writing", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/accounts/new" });
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "支付宝账号" });
    await user.click(within(dialog).getByRole("tab", { name: "应用信息" }));
    await user.click(footer(dialog).getByRole("button", { name: "更多账号操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "保存草稿" }));
    await waitFor(() => expect(within(dialog).getByRole("tab", { name: "基本信息" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(within(dialog).getByLabelText("账号名称")).toHaveFocus());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it.each(["保存草稿", "保存并检查"])("replaces the new-account overlay only after %s succeeds", async label => {
    const account = sampleAccount();
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mountOnboarding({ stage: 4, path: "/settings/accounts/new", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/alipay-accounts") return request.method === "POST" ? pending : json({ data: [] });
      if (path === "/api/admin/v1/alipay-accounts/" + account.id) return json({ data: account });
      if (path.endsWith("/check")) return json({ data: { ok: true, message: "连接检查通过" } });
      return undefined;
    } });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("账号名称"), account.name);
    if (label === "保存草稿") {
      await user.click(screen.getByRole("button", { name: "更多账号操作" }));
      await user.click(await screen.findByRole("menuitem", { name: label }));
    } else await user.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "更多账号操作" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe("/settings/accounts/new");
    await act(async () => { release(json({ data: account }, 201)); });
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe("/settings/accounts/" + account.id));
    expect(view.writes()).toHaveLength(label === "保存并检查" ? 2 : 1);
    expect(screen.getByLabelText("账号名称")).toHaveValue(account.name);
  });

  it("closes an account after confirmed deletion and evicts the deleted editor", async () => {
    const account = sampleAccount();
    let deleted = false;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mountOnboarding({ stage: 4, path: "/settings/accounts/" + account.id, handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/alipay-accounts") return json({ data: deleted ? [] : [account] });
      if (path !== "/api/admin/v1/alipay-accounts/" + account.id) return undefined;
      if (request.method === "DELETE") { deleted = true; return pending; }
      return deleted ? apiError("account_not_found", "账号不存在", 404) : json({ data: account });
    } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "使用情况" }));
    await user.click(screen.getByRole("button", { name: "删除账号" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe("/settings/accounts/" + account.id);
    await act(async () => { release(new Response(null, { status: 204 })); });
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).has("overlay")).toBe(false));
    expect(queryClient.getQueryData(["alipay-account", account.id])).toBeUndefined();
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps a website creation pending, then replaces it with the created website editor", async () => {
    const site = sampleSite();
    let created = false;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mountOnboarding({ stage: 4, path: "/sites/new", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/alipay-accounts") return json({ data: [sampleAccount()] });
      if (path === "/api/admin/v1/settings/site-defaults") return json({ data: { revision: 1, policy: site.configuration.policy } });
      if (path === "/api/admin/v1/sites") {
        if (request.method === "POST") { created = true; return pending; }
        return json({ data: created ? [site] : [], page: { next_cursor: null } });
      }
      if (path === "/api/admin/v1/sites/overlay_site") return json({ data: site });
      return undefined;
    } });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("业务网站名称"), site.configuration.name);
    const dialog = screen.getByRole("dialog", { name: "添加业务网站" });
    await user.click(footer(dialog).getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe("/sites/new");
    await act(async () => { release(json({ data: site }, 201)); });
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe("/sites/overlay_site/edit?section=basic"));
    expect(view.writes()).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "保存业务网站" })).toBeEnabled();
  });

  it("closes the website editor after confirmed deletion and evicts its protected data", async () => {
    const site = sampleSite();
    let deleted = false;
    const view = mountOnboarding({ stage: 4, path: "/sites/overlay_site/edit?section=basic", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sites") return json({ data: deleted ? [] : [site], page: { next_cursor: null } });
      if (path !== "/api/admin/v1/sites/overlay_site") return undefined;
      if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      return deleted ? apiError("site_not_found", "网站不存在", 404) : json({ data: site });
    } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "删除空业务网站" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    expect(new URLSearchParams(view.router.state.location.search).has("overlay")).toBe(false);
    expect(queryClient.getQueryData(["site-editor", site.client_id])).toBeUndefined();
    expect(view.writes()).toHaveLength(1);
  });

  it("opens a session detail from the compact list and revokes only that session after confirmation", async () => {
    let sessions: AdminLoginSession[] = [{ session_id: "22222222-2222-4222-8222-222222222222", is_current: false, user_agent: "Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36", ip_address: "2001:db8::1", auth_method: "password", last_seen_at: "2026-10-29T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" }];
    const view = mountOnboarding({ stage: 4, path: "/settings/security", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/sessions") return json({ data: sessions });
      if (path === "/api/admin/v1/sessions/22222222-2222-4222-8222-222222222222/revoke") { sessions = []; return new Response(null, { status: 204 }); }
      return undefined;
    } });
    const user = userEvent.setup();
    expect(screen.queryByLabelText("新密码")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("link", { name: "Chrome · Android" }));
    const dialog = await screen.findByRole("dialog", { name: "登录会话详情" });
    expect(await within(dialog).findByText("2001:db8::1")).toBeVisible();
    await user.click(footer(dialog).getByRole("button", { name: "撤销此会话" }));
    const confirm = await screen.findByRole("alertdialog", { name: "撤销此会话？" });
    expect(view.writes()).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "撤销" }));
    expect(await within(dialog).findByText("此会话已结束")).toBeVisible();
    expect(view.writes()).toHaveLength(1);
    expect(queryClient.getQueryData(["administrator-sessions"])).toEqual({ data: [] });
  });
});

it("merges all edited website groups while keeping untouched remote values and reporting real conflicts", () => {
  const base = sampleSite().configuration, draft = structuredClone(base), remote = structuredClone(base);
  draft.name = "本地名称"; draft.policy.orders.order_ttl_seconds = 600;
  remote.name = "他人名称"; remote.policy.display.checkout_name = "新的远程收银台";
  const result = mergeSiteConfiguration(base, draft, remote, "all");
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]).toMatchObject({ path: "name", local: "本地名称", remote: "他人名称" });
  expect(result.configuration.policy.orders.order_ttl_seconds).toBe(600);
  expect(result.configuration.policy.display.checkout_name).toBe("新的远程收银台");
});
