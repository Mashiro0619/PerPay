import { Toaster } from "../src/components/ui/toast";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type ListSiteOverviewResponse, type Site, type SitePolicy } from "../src/api/client";
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
  let failRead = false;
  let delayedRead: ((snapshot: Site) => Promise<Response>) | null = null;
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body = await request.clone().json() as Record<string, unknown>;
      writes.push({ path, method: request.method, body });
      if (failSave) throw new TypeError("network failure");
      if (rejectFields) { rejectFields = false; return json({ error: { code: "validation_failed", message: "请修正字段", fields: fieldErrors } }, 422); }
      if (body.revision !== undefined && !path.endsWith("/site-defaults") && body.revision !== saved.revision)
        return json({ error: { code: "site_revision_conflict", message: "业务网站配置已变更，请刷新后重试。" } }, 409);
      if (path.endsWith("/actions/rotate")) { saved = { ...saved, revision: saved.revision + 1 }; return json({ data: { site: saved, secret: "synthetic-site-key" } }); }
      if (path.endsWith("/actions/view")) return json({ data: { secret: "synthetic-site-key" } });
      if (path.endsWith("/site-defaults")) { defaults = body.policy as SitePolicy; return json({ data: { revision: 1, policy: defaults } }); }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      saved = { ...saved, configuration: body.configuration as Site["configuration"], revision: saved.revision + 1 };
      return json({ data: saved }, path === "/api/admin/v1/sites" ? 201 : 200);
    }
    if (path.endsWith("/site-defaults")) return json({ data: { revision: 0, policy: defaults } });
    if (path === "/api/admin/v1/sites/overview") {
      const days = Number(new URL(request.url).searchParams.get("range") ?? 30);
      const last = Date.parse("2026-10-10T12:00:00.000Z");
      return json({
        period: { from: new Date(last - (days - 1) * 86_400_000).toISOString().slice(0, 10), to: "2026-10-10" },
        max_confirmed_amount_cents: 12901,
        data: [{
          client_id: saved.client_id,
          name: saved.configuration.name,
          accepting_orders: saved.configuration.accepting_orders,
          notifications_enabled: saved.configuration.notifications_enabled,
          confirmed_count: 3,
          confirmed_amount_cents: 12901,
          pending_orders: 2,
          work_items: 1,
        }],
        page: { next_cursor: null },
      } satisfies ListSiteOverviewResponse);
    }
    if (path === "/api/admin/v1/sites") return json({ data: [saved], page: { next_cursor: null } });
    if (failRead) throw new TypeError("latest configuration unavailable");
    if (delayedRead) {
      const read = delayedRead;
      delayedRead = null;
      return read(structuredClone(saved));
    }
    return json({ data: saved });
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/sites", element: <Sites /> }, { path: "/sites/new", element: <SiteEditorPage /> }, { path: "/sites/defaults", element: <SiteDefaultsPage /> }, { path: "/sites/:clientId/settings/:section", element: <SiteEditorPage /> },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><Toaster><RouterProvider router={router} /></Toaster></QueryClientProvider>);
  return {
    router, writes, fetchMock,
    changeRemote(edit: (configuration: Site["configuration"]) => void) {
      const configuration = structuredClone(saved.configuration);
      edit(configuration);
      saved = { ...saved, revision: saved.revision + 1, configuration };
    },
    failReads(value: boolean) { failRead = value; },
    delayNextRead() {
      let release!: () => void;
      let started = false;
      delayedRead = snapshot => new Promise(resolve => {
        started = true;
        release = () => resolve(json({ data: snapshot }));
      });
      return { started: () => started, release: () => release() };
    },
  };
}
afterEach(() => onlineManager.setOnline(true));

describe("business website management", () => {
  it("explains notification and return prefix changes separately before saving", async () => {
    const view = mount("/sites/site_test/settings/integration");
    const user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("通知地址前缀"), { target: { value: "https://notify.example.com" } });
    fireEvent.change(screen.getByLabelText("返回地址前缀"), { target: { value: "https://shop.example.com" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("后续通知按新前缀校验，旧地址可能无法发送。");
    expect(confirmation).toHaveTextContent("新订单的返回地址将按新前缀校验。");
    expect(view.writes).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ configuration: { notification_origin: "https://notify.example.com", return_origin: "https://shop.example.com", notifications_enabled: false } });
  });

  it("blocks submission and protects an invalid seconds draft when leaving", async () => {
    const view = mount("/sites/site_test/settings/integration"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "高级设置" }));
    fireEvent.change(screen.getByLabelText("通知超时（秒）"), { target: { value: "5.0004" } });
    const save = screen.getByRole("button", { name: "保存业务网站" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(view.writes).toHaveLength(0);
    await user.click(screen.getByRole("tab", { name: "订单设置" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/sites/site_test/settings/integration");
  });
  it("saves a seconds timeout as integer milliseconds without a precision mismatch", async () => {
    const view = mount("/sites/site_test/settings/integration"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "高级设置" }));
    fireEvent.change(screen.getByLabelText("通知超时（秒）"), { target: { value: "5.123" } });
    expect(screen.getByLabelText("通知超时（秒）")).toBeValid();
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ configuration: { policy: { notification_delivery: { timeout_milliseconds: 5123 } } } });
  });
  it("creates from the latest detached template using only a name, without credentials", async () => {
    const view=mount('/sites/defaults'),user=userEvent.setup();
    fireEvent.change(await screen.findByLabelText('收银台有效期（秒）'),{target:{value:'600'}});await user.click(screen.getByRole('button',{name:'保存默认模板'}));await waitFor(()=>expect(view.writes).toHaveLength(1));
    await act(async()=>{await view.router.navigate('/sites/new');});await user.type(await screen.findByLabelText('业务网站名称'),'新网站');expect(screen.queryByLabelText('收银台有效期（秒）')).not.toBeInTheDocument();expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'创建业务网站'}));await waitFor(()=>expect(view.writes).toHaveLength(2));expect(view.writes[1]!.body).toMatchObject({operation_id:expect.any(String),configuration:{name:'新网站',accepting_orders:true,notifications_enabled:false,notification_origin:null,return_origin:null,policy:{...policy,orders:{...policy.orders,order_ttl_seconds:600}}}});
    expect(view.writes.every(w=>!w.path.includes('secrets'))).toBe(true);
  });
  it("keeps pause independent of notifications and saves the website revision", async () => {
    const view = mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "允许新订单" }));
    expect(screen.queryByRole("switch", { name: "开启通知" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ revision: 0, configuration: { accepting_orders: false, notifications_enabled: false } });
  });
  it("preserves drafts after a network failure and never queues an automatic resubmit", async () => {
    const view = mount("/sites/site_test/settings/basic", true); const user = userEvent.setup();
    const name = await screen.findByLabelText("业务网站名称"); await user.clear(name); await user.type(name, "失败后保留");
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await screen.findByRole("alert");
    expect(name).toHaveValue("失败后保留"); expect(view.writes).toHaveLength(1);
    expect(queryClient.getMutationCache().getAll().some(m => m.state.isPaused)).toBe(false);
    await queryClient.resumePausedMutations(); expect(view.writes).toHaveLength(1);
  });
  it("rotates only the selected website key without replacing an unsaved configuration draft", async () => {
    const view = mount("/sites/site_test/settings/integration"); const user = userEvent.setup();
    const name = await screen.findByLabelText("返回地址前缀"); await user.clear(name); await user.type(name, "https://draft.example.com");
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    expect(await screen.findByDisplayValue("synthetic-site-key")).toBeVisible();
    expect(name).toHaveValue("https://draft.example.com");
    expect(view.writes[0]!.path).toBe("/api/admin/v1/sites/site_test/secrets/api_secret/actions/rotate");
    await user.click(screen.getByRole("button", { name: "保存业务网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("edits only the creation template without modifying any existing website", async () => {
    const view = mount("/sites/defaults"); const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "保存默认模板" })).toHaveClass("w-fit");
    const ttl = await screen.findByLabelText("收银台有效期（秒）"); fireEvent.change(ttl, { target: { value: "600" } });
    expect(screen.queryByLabelText("通知地址前缀")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存默认模板" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.path).toBe("/api/admin/v1/settings/site-defaults");
    expect(view.writes[0]!.body).toMatchObject({ revision: 0, policy: { orders: { order_ttl_seconds: 600 } } });
  });
  it("keeps a single website operating card with separate dashboard and settings links", async () => {
    const view = mount("/sites");
    expect(await screen.findByRole("link", { name: "网站 A" })).toHaveAttribute("href", "/sites/site_test?range=30");
    expect(document.querySelectorAll(".site-management-card")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("site_test", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入后台" })).toHaveAttribute("href", "/sites/site_test?range=30");
    expect(screen.getByRole("link", { name: "网站设置" })).toHaveAttribute("href", "/sites/site_test/settings/basic");
    expect(screen.getByText("¥129.01", { exact: true })).toBeVisible();
    expect(screen.getByText("收款确认笔数", { exact: true })).toBeVisible();
    expect(view.fetchMock.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(["/api/admin/v1/sites/overview"]);
  });

});

describe("website configuration recovery", () => {
  it("preserves invalid timeout through an automatic merge after a key revision conflict", async () => {
    const view = mount("/sites/site_test/settings/integration"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "高级设置" }));
    const timeout = screen.getByLabelText("通知超时（秒）");
    fireEvent.change(timeout, { target: { value: "5.123" } });
    fireEvent.change(timeout, { target: { value: "5.1234" } });
    view.changeRemote(configuration => { configuration.policy.orders.order_ttl_seconds = 600; });
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(screen.queryByRole("button", { name: "应用核对结果" })).not.toBeInTheDocument();
    expect(timeout).toHaveValue(5.1234);
    expect(timeout).toBeEnabled();
    expect(screen.getByText("通知超时最多 3 位小数。")).toBeVisible();
    const save = screen.getByRole("button", { name: "保存业务网站" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(view.writes).toHaveLength(1);
    await user.click(screen.getByRole("tab", { name: "订单设置" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    fireEvent.change(timeout, { target: { value: "5.124" } });
    await user.click(save);
    await screen.findByText("业务网站配置已保存");
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { policy: {
      orders: { order_ttl_seconds: 600 }, notification_delivery: { timeout_milliseconds: 5124 },
    } } });
  });

  it.each(["保留我的修改", "采用服务器值"])("preserves invalid timeout while resolving an unrelated conflict: %s", async choice => {
    const view = mount("/sites/site_test/settings/integration"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "高级设置" }));
    const timeout = screen.getByLabelText("通知超时（秒）");
    fireEvent.change(timeout, { target: { value: "5.123" } });
    fireEvent.change(timeout, { target: { value: "5.1234" } });
    fireEvent.change(screen.getByLabelText("最多发送次数"), { target: { value: "15" } });
    view.changeRemote(configuration => { configuration.policy.notification_delivery.maximum_attempts = 18; });
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("服务器值：18");
    await user.click(screen.getByRole("button", { name: choice }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(timeout).toHaveValue(5.1234);
    expect(timeout).toBeEnabled();
    expect(screen.getByLabelText("最多发送次数")).toHaveValue(choice === "保留我的修改" ? 15 : 18);
    expect(screen.getByText("通知超时最多 3 位小数。")).toBeVisible();
    const save = screen.getByRole("button", { name: "保存业务网站" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(view.writes).toHaveLength(1);
  });

  it.each([
    { choice: "保留我的修改", seconds: 5.123, milliseconds: 5123 },
    { choice: "采用服务器值", seconds: 7.555, milliseconds: 7555 },
  ])("resolves an invalid timeout draft only after choosing its conflict value: $choice", async ({ choice, seconds, milliseconds }) => {
    const view = mount("/sites/site_test/settings/integration"), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "高级设置" }));
    const timeout = screen.getByLabelText("通知超时（秒）");
    fireEvent.change(timeout, { target: { value: "5.123" } });
    fireEvent.change(timeout, { target: { value: "5.1234" } });
    view.changeRemote(configuration => { configuration.policy.notification_delivery.timeout_milliseconds = 7555; });
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    expect(await screen.findByText("服务器值：7.555")).toBeVisible();
    expect(screen.getByText("我的值：5.123")).toBeVisible();
    await user.click(screen.getByRole("button", { name: choice }));
    expect(timeout).toHaveValue(5.1234);
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(timeout).toHaveValue(seconds);
    expect(timeout).toBeValid();
    const save = screen.getByRole("button", { name: "保存业务网站" });
    expect(save).toBeEnabled();
    await user.click(save);
    await screen.findByText("业务网站配置已保存");
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { policy: {
      notification_delivery: { timeout_milliseconds: milliseconds },
    } } });
  });

  it("saves across basic, orders, and basic again with the latest complete configuration", async () => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "第一次改名" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await screen.findByText("业务网站配置已保存");
    await user.click(screen.getByRole("tab", { name: "订单设置" }));
    fireEvent.change(await screen.findByLabelText("收银台有效期（秒）"), { target: { value: "600" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await screen.findByText("业务网站配置已保存");
    await user.click(screen.getByRole("tab", { name: "基本信息" }));
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "第二次改名" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(3));
    expect(view.writes.map(write => write.body.revision)).toEqual([0, 1, 2]);
    expect(view.writes[2]!.body).toMatchObject({ configuration: { name: "第二次改名", policy: { orders: { order_ttl_seconds: 600 } } } });
    await screen.findByText("业务网站配置已保存");
  });

  it("keeps drafts through failed reloads and merges remote fields before an explicit save", async () => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "我的修改" } });
    view.changeRemote(configuration => { configuration.policy.orders.order_ttl_seconds = 600; });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    const reload = await screen.findByRole("button", { name: "读取最新配置并核对" });
    expect(screen.getByRole("button", { name: "保存业务网站" })).toBeDisabled();
    view.failReads(true);
    await user.click(reload);
    await screen.findByText("无法连接服务，请检查网络后重试。");
    expect(screen.getByLabelText("业务网站名称")).toHaveValue("我的修改");
    view.failReads(false);
    await user.click(screen.getByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(view.writes).toHaveLength(1);
    expect(screen.getByLabelText("业务网站名称")).toHaveValue("我的修改");
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2));
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { name: "我的修改", policy: { orders: { order_ttl_seconds: 600 } } } });
    await screen.findByText("业务网站配置已保存");
  });

  it.each(["保留我的修改", "采用服务器值"])("requires an explicit same-field conflict choice: %s", async choice => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "我的修改" } });
    view.changeRemote(configuration => { configuration.name = "服务器修改"; configuration.policy.orders.order_ttl_seconds = 600; });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("同一字段存在不同修改");
    expect(screen.getByRole("button", { name: "保存业务网站" })).toBeDisabled();
    expect(screen.getByText("原值：网站 A")).toBeVisible();
    expect(screen.getByText("服务器值：服务器修改")).toBeVisible();
    expect(screen.getByText("我的值：我的修改")).toBeVisible();
    await user.click(screen.getByRole("button", { name: choice }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(view.writes).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2));
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { name: choice === "保留我的修改" ? "我的修改" : "服务器修改", policy: { orders: { order_ttl_seconds: 600 } } } });
  });

  it("adopts remote snapshots when clean and preserves dirty drafts for explicit comparison", async () => {
    const view = mount(), user = userEvent.setup();
    await screen.findByLabelText("业务网站名称");
    view.changeRemote(configuration => { configuration.name = "远端名称"; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-editor"] }); });
    await waitFor(() => expect(screen.getByLabelText("业务网站名称")).toHaveValue("远端名称"));
    fireEvent.change(screen.getByLabelText("业务网站名称"), { target: { value: "尚未保存" } });
    view.changeRemote(configuration => { configuration.policy.orders.order_ttl_seconds = 900; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-editor"] }); });
    expect(screen.getByLabelText("业务网站名称")).toHaveValue("尚未保存");
    await waitFor(() => expect(screen.getByRole("button", { name: "保存业务网站" })).toBeDisabled());
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ revision: 2, configuration: { name: "尚未保存", policy: { orders: { order_ttl_seconds: 900 } } } });
  });

  it("keeps drafts and repeats comparison when another conflict occurs after merging", async () => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "我的修改" } });
    view.changeRemote(configuration => { configuration.policy.orders.order_ttl_seconds = 600; });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    view.changeRemote(configuration => { configuration.policy.display.checkout_name = "最新收银台"; });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(screen.getByLabelText("业务网站名称")).toHaveValue("我的修改");
    expect(view.writes).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(3));
    expect(view.writes[2]!.body).toMatchObject({ revision: 2, configuration: { name: "我的修改", policy: { orders: { order_ttl_seconds: 600 }, display: { checkout_name: "最新收银台" } } } });
  });

  it("merges separate nested fields in the same group while resolving only the overlapping field", async () => {
    const view = mount("/sites/site_test/settings/orders"), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("收银台有效期（秒）"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("待付款订单上限"), { target: { value: "10" } });
    view.changeRemote(configuration => {
      configuration.name = "远端名称";
      configuration.policy.orders.order_ttl_seconds = 900;
      configuration.policy.orders.amount_reuse_cooldown_seconds = 1200;
    });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await user.click(await screen.findByRole("button", { name: "保留我的修改" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByLabelText("应付金额复用等待（秒）")).toHaveValue(1200);
    expect(screen.getByLabelText("待付款订单上限")).toHaveValue(10);
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2));
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { name: "远端名称", policy: { orders: { order_ttl_seconds: 600, amount_reuse_cooldown_seconds: 1200, pending_order_limit: 10 } } } });
  });

  it("merges display text, nullable links, and remote switches without reverting remote fields", async () => {
    const view = mount("/sites/site_test/settings/display"), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("收银台名称"), { target: { value: "我的收银台" } });
    fireEvent.change(screen.getByLabelText("帮助链接"), { target: { value: "https://help.example.com" } });
    view.changeRemote(configuration => { configuration.policy.display.checkout_show_product_name = false; });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(screen.getByRole("switch", { name: "显示商品名称" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2));
    expect(view.writes[1]!.body).toMatchObject({ revision: 1, configuration: { policy: { display: { checkout_name: "我的收银台", checkout_help_url: "https://help.example.com", checkout_show_product_name: false } } } });
  });

  it("requires explicit retry after a rotation conflict and retains integration drafts through rotation", async () => {
    const view = mount(), user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "接入与通知" }));
    fireEvent.change(await screen.findByLabelText("返回地址前缀"), { target: { value: "https://draft.example.com" } });
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    fireEvent.change(await screen.findByLabelText("最多发送次数"), { target: { value: "15" } });
    view.changeRemote(configuration => {
      configuration.policy.orders.order_ttl_seconds = 600;
      configuration.policy.notification_delivery.timeout_milliseconds = 7000;
    });
    await user.click(screen.getByRole("button", { name: "生成／轮换通知密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(view.writes).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "生成／轮换通知密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByDisplayValue("synthetic-site-key");
    expect(screen.getByLabelText("返回地址前缀")).toHaveValue("https://draft.example.com");
    expect(screen.getByLabelText("最多发送次数")).toHaveValue(15);
    expect(queryClient.getQueryData<{ site: Site }>(["site-editor", "site_test"])?.site.configuration.return_origin).toBeNull();
    await user.click(screen.getByRole("tab", { name: "基本信息" }));
    await screen.findByRole("button", { name: "放弃修改并继续" });
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByText("业务网站配置已保存");
    expect(view.writes[2]!.body).toMatchObject({ revision: 2, configuration: { return_origin: "https://draft.example.com", policy: { orders: { order_ttl_seconds: 600 }, notification_delivery: { maximum_attempts: 15, timeout_milliseconds: 7000 } } } });
    await user.click(screen.getByRole("tab", { name: "基本信息" }));
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "轮换后改名" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(4));
    expect(view.writes[3]!.body.revision).toBe(3);
  });

  it("cancels an older background read before publishing a committed save", async () => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("业务网站名称"), { target: { value: "第一次保存" } });
    const delayed = view.delayNextRead();
    let refresh!: Promise<void>;
    await act(async () => { refresh = queryClient.invalidateQueries({ queryKey: ["site-editor"] }); });
    await waitFor(() => expect(delayed.started()).toBe(true));
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await screen.findByText("业务网站配置已保存");
    await act(async () => { delayed.release(); await refresh; });
    expect(screen.getByLabelText("业务网站名称")).toHaveValue("第一次保存");
    fireEvent.change(screen.getByLabelText("业务网站名称"), { target: { value: "第二次保存" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2));
    expect(view.writes[1]!.body.revision).toBe(1);
  });
});

describe("website field feedback", () => {
  it.each(["basic", "orders", "integration", "display", "defaults"])("keeps per-group field errors and drafts in %s", async section => {
    const path = section === "defaults" ? "/sites/defaults" : "/sites/site_test/settings/" + section;
    const cases: Record<string, [string, string, string][]> = {
      basic: [["业务网站名称", "configuration.name", "新的网站名"]],
      orders: [["收银台有效期（秒）", "configuration.policy.orders.order_ttl_seconds", "600"], ["待付款订单上限", "configuration.policy.orders.pending_order_limit", "10"]],
      integration: [["通知地址前缀", "configuration.notification_origin", "https://notify.example.com"], ["返回地址前缀", "configuration.return_origin", "https://shop.example.com"]],
      display: [["收银台名称", "configuration.policy.display.checkout_name", "草稿名称"], ["帮助链接", "configuration.policy.display.checkout_help_url", "https://help.example.com"]],
      defaults: [["收银台名称", "policy.display.checkout_name", "模板草稿"], ["收银台有效期（秒）", "policy.orders.order_ttl_seconds", "600"]],
    };
    const fields = Object.fromEntries(cases[section]!.map(([label, field]) => [field, label + "错误"]));
    const view = mount(path, false, fields), user = userEvent.setup();
    for (const [label, , value] of cases[section]!) { if(section === "defaults") await user.click(await screen.findByRole("tab",{name:label === "收银台名称" ? "收银台展示" : "订单设置"})); fireEvent.change(await screen.findByLabelText(label), { target: { value } }); }
    const submit = async () => { await user.click(screen.getByRole("button", { name: section === "defaults" ? "保存默认模板" : "保存业务网站" })); if (section === "integration") await user.click(await screen.findByRole("button", { name: "确认" })); };
    await submit();
    for (const [label] of cases[section]!) { if(section === "defaults") await user.click(screen.getByRole("tab",{name:label === "收银台名称" ? "收银台展示" : "订单设置"})); await screen.findByText(label + "错误"); expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true"); }
    expect(view.writes).toHaveLength(1);
    await submit(); await waitFor(() => expect(view.writes).toHaveLength(2));
  });

  it("reopens a saved website with its current configuration and revision", async () => {
    const view = mount(); const user = userEvent.setup();
    const name = await screen.findByLabelText("业务网站名称"); fireEvent.change(name, { target: { value: "保存后的名字" } });
    await user.click(screen.getByRole("button", { name: "保存业务网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByText("业务网站配置已保存");
    await act(async () => { await view.router.navigate("/sites"); });
    await act(async () => { await view.router.navigate("/sites/site_test/settings/basic"); });
    expect(await screen.findByLabelText("业务网站名称")).toHaveValue("保存后的名字");
    await user.click(screen.getByRole("button", { name: "保存业务网站" })); if(view.router.state.location.pathname.endsWith("integration")) await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("keeps key rotation revisions on reentry without caching the revealed secret", async () => {
    const view = mount("/sites/site_test/settings/integration"); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByDisplayValue("synthetic-site-key");
    expect(JSON.stringify(queryClient.getQueryData(["site-editor", "site_test"]))).not.toContain("synthetic-site-key");
    await act(async () => { await view.router.navigate("/sites"); });
    await act(async () => { await view.router.navigate("/sites/site_test/settings/basic"); });
    expect(screen.queryByDisplayValue("synthetic-site-key")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "保存业务网站" }));
    await waitFor(() => expect(view.writes).toHaveLength(2)); expect(view.writes[1]!.body.revision).toBe(1);
  });
  it("evicts the deleted website editor instead of keeping a usable-looking cached form", async () => {
    const view = mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "删除空业务网站" })); await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    expect(queryClient.getQueryData(["site-editor", "site_test"])).toBeUndefined();
  });
});
