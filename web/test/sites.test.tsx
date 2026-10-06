import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type Site, type SitePolicy } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import Sites, { SiteDefaultsPage, SiteEditorPage } from "../src/pages/Sites";
import { json } from "./fixtures";

const policy: SitePolicy = {
  orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
  display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
  notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
};
const initial: Site = { client_id: "site_test", revision: 0, configuration: { name: "网站 A", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy }, created_at: "2026-10-06T00:00:00.000Z", updated_at: "2026-10-06T00:00:00.000Z", deleted_at: null };
function mount(path = "/sites/site_test/settings/basic", failSave = false, fieldErrors?: Record<string, string>) {
  let rejectFields = !!fieldErrors;
  let saved = structuredClone(initial), defaults = structuredClone(policy);
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body = await request.clone().json() as Record<string, unknown>;
      writes.push({ path, method: request.method, body });
      if (failSave) throw new TypeError("network failure");
      if (rejectFields) { rejectFields = false; return json({ error: { code: "validation_failed", message: "请修正字段", fields: fieldErrors } }, 422); }
      if (path.endsWith("/actions/rotate")) { saved = { ...saved, revision: saved.revision + 1 }; return json({ data: { site: saved, secret: "synthetic-site-key" } }); }
      if (path.endsWith("/actions/view")) return json({ data: { secret: "synthetic-site-key" } });
      if (path.endsWith("/site-defaults")) { defaults = body.policy as SitePolicy; return json({ data: { revision: 1, policy: defaults } }); }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      saved = { ...saved, configuration: body.configuration as Site["configuration"], revision: saved.revision + 1 };
      return json({ data: saved }, path === "/api/admin/v1/sites" ? 201 : 200);
    }
    if (path.endsWith("/site-defaults")) return json({ data: { revision: 0, policy: defaults } });
    if (path === "/api/admin/v1/sites") return json({ data: [saved], page: { next_cursor: null } });
    return json({ data: saved });
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/sites", element: <Sites /> }, { path: "/sites/new", element: <SiteEditorPage /> }, { path: "/sites/defaults", element: <SiteDefaultsPage /> }, { path: "/sites/:clientId/settings/:section", element: <SiteEditorPage /> },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, writes, fetchMock };
}
afterEach(() => onlineManager.setOnline(true));

describe("business website management", () => {
  it("creates from the latest detached template using only a name, without credentials", async () => {
    const view=mount('/sites/defaults'),user=userEvent.setup();
    fireEvent.change(await screen.findByLabelText('订单有效期（秒）'),{target:{value:'600'}});await user.click(screen.getByRole('button',{name:'保存默认模板'}));await waitFor(()=>expect(view.writes).toHaveLength(1));
    await act(async()=>{await view.router.navigate('/sites/new');});await user.type(await screen.findByLabelText('网站名称'),'新网站');expect(screen.queryByLabelText('订单有效期（秒）')).not.toBeInTheDocument();expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'创建网站'}));await waitFor(()=>expect(view.writes).toHaveLength(2));expect(view.writes[1]!.body).toMatchObject({operation_id:expect.any(String),configuration:{name:'新网站',accepting_orders:true,notifications_enabled:false,notification_origin:null,return_origin:null,policy:{...policy,orders:{...policy.orders,order_ttl_seconds:600}}}});
    expect(view.writes.every(w=>!w.path.includes('secrets'))).toBe(true);
  });
  it("keeps pause independent of notifications and saves the website revision", async () => {
    const view = mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "允许新订单" }));
    expect(screen.queryByRole("switch", { name: "开启通知" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ revision: 0, configuration: { accepting_orders: false, notifications_enabled: false } });
  });
  it("preserves drafts after a network failure and never queues an automatic resubmit", async () => {
    const view = mount("/sites/site_test/settings/basic", true); const user = userEvent.setup();
    const name = await screen.findByLabelText("网站名称"); await user.clear(name); await user.type(name, "失败后保留");
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await screen.findByRole("alert");
    expect(name).toHaveValue("失败后保留"); expect(view.writes).toHaveLength(1);
    expect(queryClient.getMutationCache().getAll().some(m => m.state.isPaused)).toBe(false);
    await queryClient.resumePausedMutations(); expect(view.writes).toHaveLength(1);
  });
  it("rotates only the selected website key without replacing an unsaved configuration draft", async () => {
    const view = mount("/sites/site_test/settings/integration"); const user = userEvent.setup();
    const name = await screen.findByLabelText("返回来源"); await user.clear(name); await user.type(name, "https://draft.example.com");
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    expect(await screen.findByDisplayValue("synthetic-site-key")).toBeVisible();
    expect(name).toHaveValue("https://draft.example.com");
    expect(view.writes[0]!.path).toBe("/api/admin/v1/sites/site_test/secrets/api_secret/actions/rotate");
    await user.click(screen.getByRole("button", { name: "保存网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("edits only the creation template without modifying any existing website", async () => {
    const view = mount("/sites/defaults"); const user = userEvent.setup();
    const ttl = await screen.findByLabelText("订单有效期（秒）"); fireEvent.change(ttl, { target: { value: "600" } });
    expect(screen.queryByLabelText("通知来源")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存默认模板" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.path).toBe("/api/admin/v1/settings/site-defaults");
    expect(view.writes[0]!.body).toMatchObject({ revision: 0, policy: { orders: { order_ttl_seconds: 600 } } });
  });
  it("uses a compact site list without search or routine client ids",async()=>{mount('/sites');expect(await screen.findByRole('link',{name:'网站 A'})).toHaveAttribute('href','/sites/site_test');expect(screen.queryByRole('textbox')).not.toBeInTheDocument();expect(screen.queryByText('site_test',{exact:true})).not.toBeInTheDocument();expect(screen.getByRole('link',{name:'进入后台'})).toBeVisible();});

});

describe("website field feedback", () => {
  it.each(["basic", "orders", "integration", "display", "defaults"])("keeps per-group field errors and drafts in %s", async section => {
    const path = section === "defaults" ? "/sites/defaults" : "/sites/site_test/settings/" + section;
    const cases: Record<string, [string, string, string][]> = {
      basic: [["网站名称", "configuration.name", "新的网站名"]],
      orders: [["订单有效期（秒）", "configuration.policy.orders.order_ttl_seconds", "600"], ["待付款订单上限", "configuration.policy.orders.pending_order_limit", "10"]],
      integration: [["通知来源", "configuration.notification_origin", "https://notify.example.com"], ["返回来源", "configuration.return_origin", "https://shop.example.com"]],
      display: [["收银台名称", "configuration.policy.display.checkout_name", "草稿名称"], ["帮助链接", "configuration.policy.display.checkout_help_url", "https://help.example.com"]],
      defaults: [["收银台名称", "policy.display.checkout_name", "模板草稿"], ["订单有效期（秒）", "policy.orders.order_ttl_seconds", "600"]],
    };
    const fields = Object.fromEntries(cases[section]!.map(([label, field]) => [field, label + "错误"]));
    const view = mount(path, false, fields), user = userEvent.setup();
    for (const [label, , value] of cases[section]!) { if(section === "defaults") await user.click(await screen.findByRole("tab",{name:label === "收银台名称" ? "收银台展示" : "订单设置"})); fireEvent.change(await screen.findByLabelText(label), { target: { value } }); }
    const submit = async () => { await user.click(screen.getByRole("button", { name: section === "defaults" ? "保存默认模板" : "保存网站" })); if (section === "integration") await user.click(await screen.findByRole("button", { name: "确认" })); };
    await submit();
    for (const [label] of cases[section]!) { if(section === "defaults") await user.click(screen.getByRole("tab",{name:label === "收银台名称" ? "收银台展示" : "订单设置"})); await screen.findByText(label + "错误"); expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true"); }
    expect(view.writes).toHaveLength(1);
    await submit(); await waitFor(() => expect(view.writes).toHaveLength(2));
  });

  it("reopens a saved website with its current configuration and revision", async () => {
    const view = mount(); const user = userEvent.setup();
    const name = await screen.findByLabelText("网站名称"); fireEvent.change(name, { target: { value: "保存后的名字" } });
    await user.click(screen.getByRole("button", { name: "保存网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByText("网站配置已保存");
    await act(async () => { await view.router.navigate("/sites"); });
    await act(async () => { await view.router.navigate("/sites/site_test/settings/basic"); });
    expect(await screen.findByLabelText("网站名称")).toHaveValue("保存后的名字");
    await user.click(screen.getByRole("button", { name: "保存网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("keeps key rotation revisions on reentry without caching the revealed secret", async () => {
    const view = mount("/sites/site_test/settings/integration"); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByDisplayValue("synthetic-site-key");
    expect(JSON.stringify(queryClient.getQueryData(["site-editor", "site_test", "integration"]))).not.toContain("synthetic-site-key");
    await act(async () => { await view.router.navigate("/sites"); });
    await act(async () => { await view.router.navigate("/sites/site_test/settings/basic"); });
    expect(screen.queryByDisplayValue("synthetic-site-key")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "保存网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("evicts the deleted website editor instead of keeping a usable-looking cached form", async () => {
    const view = mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "删除空网站" })); await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    expect(queryClient.getQueryData(["site-editor", "site_test", "basic"])).toBeUndefined();
  });
});
