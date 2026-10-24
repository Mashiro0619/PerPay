import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryClient, type RuntimeSettings, type Site, type SiteConfiguration, type SitePolicy } from "../src/api/client";
import { json } from "./fixtures";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";

function instanceSettings(): RuntimeSettings {
  const old = configuredThrough(4);
  const { notifications: _notifications, ...data } = old;
  const { api: _api, notifications: _notificationReady, ...completion } = old.completion;
  return {
    ...data, site_mode: true, completion: { ...completion, sites: false },
    collection: { code_payload: old.collection!.code_payload },
    provider: { environment: old.provider!.environment, app_id: old.provider!.app_id, platform_public_key: old.provider!.platform_public_key, provider_account_key: old.provider!.provider_account_key },
    display: { system_name: "实例后台", dashboard_chart_type: "AREA" },
    secrets: { provider_private_key: old.secrets.provider_private_key, provider_public_key: old.secrets.provider_public_key },
  };
}

function mount(path: string) {
  let data = instanceSettings();
  const writes: Record<string, unknown>[] = [];
  const view = mountOnboarding({ stage: 4, path, handle: request => {
    if (new URL(request.url).pathname !== "/api/admin/v1/settings" && !new URL(request.url).pathname.endsWith("/settings/display")) return undefined;
    if (request.method === "GET") return json({ data });
    return request.json().then((body: Record<string, unknown>) => {
      writes.push(body);
      data = { ...data, revision: data.revision + 1, display: { system_name: String(body.system_name), dashboard_chart_type: "BAR" } };
      return json({ data });
    });
  } });
  return { ...view, writes };
}

describe("website-aware instance settings", () => {
  it("does not show global business keys or a default client ID in security", async () => {
    mount("/settings/security");
    expect(await screen.findByRole("link", { name: "业务网站密钥与客户端 ID" })).toHaveAttribute("href", "/sites");
    expect(screen.queryByRole("button", { name: "生成 API 密钥" })).not.toBeInTheDocument();
    expect(screen.queryByText("default", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("通知签名密钥", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "通知" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看应用私钥" })).toBeVisible();
  });

  it("saves only instance name and chart style without website display fields", async () => {
    const view = mount("/settings/display");
    const name = await screen.findByRole("textbox", { name: "支付系统名称" });
    expect(screen.queryByRole("textbox", { name: "商家帮助链接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "收银台显示商品名称" })).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: "新的后台" } });
    await userEvent.click(screen.getByRole("button", { name: "柱状图" }));
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]).toEqual({ revision: expect.any(Number), system_name: "新的后台", dashboard_chart_type: "BAR" });
  });

  it("explains the retired notification page and links to websites", async () => {
    mount("/settings/notifications");
    expect(await screen.findByText("通知设置已迁移")).toBeVisible();
    expect(screen.getByRole("link", { name: "前往业务网站配置通知" })).toHaveAttribute("href", "/sites");
    expect(screen.queryByRole("switch", { name: "启用通知" })).not.toBeInTheDocument();
  });

  it("takes fresh website-aware setup to website creation instead of global notification credentials", async () => {
    mount("/settings/onboarding");
    expect(await screen.findByRole("link", { name: "创建业务网站" })).toHaveAttribute("href", "/sites/new");
    expect(screen.getByRole("heading", { name: "网站与备份" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "保存通知" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成 API 密钥" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "请先创建业务网站" })).toBeDisabled();
  });

  it("returns from website creation with refreshed setup completion without generating API credentials", async () => {
    let data = instanceSettings();
    let site: Site | null = null;
    const writes: string[] = [];
    const policy: SitePolicy = {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
    };
    const view = mountOnboarding({ stage: 4, path: "/settings/onboarding", handle: request => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") writes.push(path);
      if (path === "/api/admin/v1/settings") return json({ data });
      if (path.endsWith("/site-defaults")) return json({ data: { revision: 0, policy } });
      if (path === "/api/admin/v1/sites" && request.method === "POST") return request.json().then((body: { configuration: SiteConfiguration }) => {
        site = { client_id: "site_created", revision: 0, configuration: body.configuration, created_at: "2026-10-06T00:00:00.000Z", updated_at: "2026-10-06T00:00:00.000Z", deleted_at: null };
        data = { ...data, completion: { ...data.completion, sites: true } };
        return json({ data: site }, 201);
      });
      if (path === "/api/admin/v1/sites/site_created") return json({ data: site });
      return undefined;
    } });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "创建业务网站" }));
    await user.type(await screen.findByRole("textbox", { name: "业务网站名称" }), "测试网站");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites/site_created"));
    await waitFor(() => expect(queryClient.getQueryState(["workspace-site", "site_created"])?.status).toBe("success"));
    await act(async () => { await view.router.navigate("/settings/onboarding/check"); });
    expect(await screen.findByRole("heading", { name: "收款检查" })).toBeVisible();
    expect(writes).toEqual(["/api/admin/v1/sites"]);
  });
});
