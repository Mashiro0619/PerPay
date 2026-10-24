import { Toaster } from "../src/components/ui/toast";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type ListSiteOverviewResponse, type Site, type SiteConfiguration, type SitePolicy } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import Sites, { SiteDefaultsPage, SiteEditorPage } from "../src/pages/Sites";
import { json } from "./fixtures";

const defaultsPath = "/api/admin/v1/settings/site-defaults";
const initialPolicy: SitePolicy = {
  orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
  display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
  notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
};
type TemplateSnapshot = { revision: number; policy: SitePolicy };
type CreateRequest = { operation_id: string; configuration: SiteConfiguration };
type User = ReturnType<typeof userEvent.setup>;
let online = true;

beforeEach(() => {
  online = true;
  onlineManager.setOnline(true);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

function mountDefaults() {
  let saved: TemplateSnapshot = { revision: 0, policy: structuredClone(initialPolicy) };
  let failReads = false;
  let delayedRead: ((snapshot: TemplateSnapshot) => Promise<Response>) | null = null;
  const puts: TemplateSnapshot[] = [];
  const creations: CreateRequest[] = [];
  const attempts: Array<{ path: string; method: string }> = [];
  const sites: Site[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    attempts.push({ path, method: request.method });
    if (!online) throw new TypeError("network offline");
    if (path === defaultsPath && request.method === "GET") {
      if (failReads) throw new TypeError("latest template unavailable");
      const snapshot = structuredClone(saved);
      if (delayedRead) {
        const read = delayedRead;
        delayedRead = null;
        return read(snapshot);
      }
      return json({ data: snapshot });
    }
    if (path === defaultsPath && request.method === "PUT") {
      const body = await request.clone().json() as TemplateSnapshot;
      puts.push(structuredClone(body));
      if (body.policy.notification_delivery.retry_maximum_seconds < body.policy.notification_delivery.retry_base_seconds)
        return json({ error: { code: "validation_failed", message: "请修正模板字段。", fields: {
          "policy.notification_delivery.retry_maximum_seconds": "最大重试间隔不能小于首次重试间隔。",
        } } }, 422);
      if (body.revision !== saved.revision)
        return json({ error: { code: "site_revision_conflict", message: "网站默认模板已变更，请刷新后重试。" } }, 409);
      saved = { revision: saved.revision + 1, policy: structuredClone(body.policy) };
      return json({ data: structuredClone(saved) });
    }
    if (path === "/api/admin/v1/sites/overview" && request.method === "GET") {
      const days = Number(new URL(request.url).searchParams.get("range") ?? 30);
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
    if (path === "/api/admin/v1/sites" && request.method === "GET")
      return json({ data: sites, page: { next_cursor: null } });
    if (path === "/api/admin/v1/sites" && request.method === "POST") {
      const body = await request.clone().json() as CreateRequest;
      creations.push(structuredClone(body));
      const site: Site = { client_id: "site_created", revision: 0, configuration: body.configuration, created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", deleted_at: null };
      sites.push(site);
      return json({ data: site }, 201);
    }
    return json({ error: { code: "route_not_found", message: "Unexpected request in template recovery test" } }, 404);
  }));
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/sites/defaults", element: <SiteDefaultsPage /> },
    { path: "/sites", element: <Sites /> },
    { path: "/sites/new", element: <SiteEditorPage /> },
    { path: "/sites/:clientId", element: <p>新网站已创建</p> },
  ] }], { initialEntries: ["/sites/defaults"] });
  render(<QueryClientProvider client={queryClient}><Toaster><RouterProvider router={router} /></Toaster></QueryClientProvider>);
  return {
    router, puts, creations, attempts,
    snapshot: () => structuredClone(saved),
    changeRemote(edit: (policy: SitePolicy) => void) {
      const policy = structuredClone(saved.policy);
      edit(policy);
      saved = { revision: saved.revision + 1, policy };
    },
    failReads(value: boolean) { failReads = value; },
    delayNextRead() {
      let started = false;
      let release!: () => void;
      delayedRead = snapshot => new Promise(resolve => {
        started = true;
        release = () => resolve(json({ data: snapshot }));
      });
      return { started: () => started, release: () => release() };
    },
  };
}

async function group(user: User, name: "订单设置" | "收银台展示" | "通知策略") {
  await user.click(await screen.findByRole("tab", { name }));
  if (name === "通知策略") {
    const advanced = screen.getByRole("button", { name: "高级设置" });
    if (advanced.getAttribute("aria-expanded") !== "true") await user.click(advanced);
  }
}
function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
const save = () => screen.getByRole("button", { name: "保存默认模板" });
const reload = () => screen.findByRole("button", { name: "读取最新模板并核对" });
async function mergeLatest(user: User) {
  await user.click(await reload());
  await screen.findByText("最新模板已合并，尚未保存");
  await waitFor(() => expect(save()).toBeEnabled());
}
async function network(value: boolean) {
  await act(async () => {
    online = value;
    onlineManager.setOnline(value);
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

describe("website default template conflict recovery", () => {
  it("preserves invalid timeout through an automatic merge of another group", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "通知策略");
    edit("通知超时（秒）", "5.123");
    edit("通知超时（秒）", "5.1234");
    view.changeRemote(policy => { policy.display.checkout_name = "服务器收银台"; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await user.click(await reload());
    await screen.findByText("最新模板已合并，尚未保存");
    expect(screen.queryByRole("button", { name: "应用核对结果" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5.1234);
    expect(screen.getByLabelText("通知超时（秒）")).toBeEnabled();
    expect(screen.getByText("通知超时最多 3 位小数。")).toBeVisible();
    expect(save()).toBeDisabled();
    fireEvent.submit(save().closest("form")!);
    expect(view.puts).toHaveLength(0);
    await group(user, "收银台展示");
    expect(screen.getByLabelText("收银台名称")).toHaveValue("服务器收银台");
    expect(save()).toBeDisabled();
    await group(user, "通知策略");
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5.1234);
    edit("通知超时（秒）", "5.124");
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(1);
    expect(view.puts[0]).toMatchObject({ revision: 1, policy: {
      display: { checkout_name: "服务器收银台" }, notification_delivery: { timeout_milliseconds: 5124 },
    } });
  });

  it("preserves invalid timeout while resolving a conflict in another group", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await group(user, "通知策略");
    edit("通知超时（秒）", "5.123");
    edit("通知超时（秒）", "5.1234");
    view.changeRemote(policy => { policy.orders.order_ttl_seconds = 900; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await user.click(await reload());
    await screen.findByText("服务器值：900");
    await user.click(screen.getByRole("button", { name: "采用服务器值" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5.1234);
    expect(screen.getByLabelText("通知超时（秒）")).toBeEnabled();
    expect(screen.getByText("通知超时最多 3 位小数。")).toBeVisible();
    expect(save()).toBeDisabled();
    fireEvent.submit(save().closest("form")!);
    expect(view.puts).toHaveLength(0);
    await group(user, "订单设置");
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(900);
    expect(save()).toBeDisabled();
  });

  it.each([
    { choice: "保留我的修改", seconds: 5.123, milliseconds: 5123 },
    { choice: "采用服务器值", seconds: 7.555, milliseconds: 7555 },
  ])("resolves an invalid timeout draft only after choosing its conflict value: $choice", async ({ choice, seconds, milliseconds }) => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "通知策略");
    const timeout = screen.getByRole("spinbutton", { name: "通知超时（秒）" });
    edit("通知超时（秒）", "5.123");
    edit("通知超时（秒）", "5.1234");
    view.changeRemote(policy => { policy.notification_delivery.timeout_milliseconds = 7555; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await user.click(await reload());
    expect(await screen.findByText("服务器值：7.555")).toBeVisible();
    expect(screen.getByText("我的值：5.123")).toBeVisible();
    await user.click(screen.getByRole("button", { name: choice }));
    expect(timeout).toHaveValue(5.1234);
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(timeout).toHaveValue(seconds);
    expect(timeout).toBeValid();
    expect(save()).toBeEnabled();
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(1);
    expect(view.puts[0]).toMatchObject({ revision: 1, policy: {
      notification_delivery: { timeout_milliseconds: milliseconds },
    } });
  });

  it("retains invalid seconds across tabs and unrelated edits, blocks submission and protects leaving", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "通知策略");
    edit("通知超时（秒）", "5.0004");
    expect(screen.getByText("通知超时最多 3 位小数。")).toBeVisible();
    expect(save()).toBeDisabled();
    edit("最多发送次数", "15");
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5.0004);
    await group(user, "订单设置");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.submit(save().closest("form")!);
    expect(view.puts).toHaveLength(0);
    await group(user, "通知策略");
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5.0004);
    await act(async () => { void view.router.navigate("/sites"); });
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(view.router.state.location.pathname).toBe("/sites/defaults");
  });
  it("saves exact milliseconds and formats timeout conflicts in seconds before adopting the server value", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "通知策略");
    edit("通知超时（秒）", "5.123");
    await user.click(save());
    await waitFor(() => expect(view.puts).toHaveLength(1));
    expect(view.puts[0]!.policy.notification_delivery.timeout_milliseconds).toBe(5123);
    await screen.findByText("模板已保存");
    edit("通知超时（秒）", "6.234");
    view.changeRemote(policy => { policy.notification_delivery.timeout_milliseconds = 5000; });
    await user.click(save());
    await user.click(await reload());
    expect(await screen.findByText("服务器值：5")).toBeVisible();
    expect(screen.getByText("我的值：6.234")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "采用服务器值" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByLabelText("通知超时（秒）")).toHaveValue(5);
    await user.click(save());
    await waitFor(() => expect(view.puts).toHaveLength(3));
    expect(view.puts[2]!.policy.notification_delivery.timeout_milliseconds).toBe(5000);
  });
  it("preserves every edited group, explicitly saves the merged template and uses it for new sites", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await group(user, "收银台展示");
    edit("收银台名称", "我的模板");
    await group(user, "通知策略");
    edit("最多发送次数", "15");
    view.changeRemote(policy => {
      policy.orders.amount_reuse_cooldown_seconds = 1200;
      policy.display.checkout_help_url = "https://help.example.com";
      policy.notification_delivery.timeout_milliseconds = 7000;
    });
    await user.click(save());
    await waitFor(() => expect(view.puts).toHaveLength(1));
    await reload();
    expect(save()).toBeDisabled();
    await user.click(save());
    fireEvent.submit(save().closest("form")!);
    await act(async () => { await Promise.resolve(); });
    expect(view.puts).toHaveLength(1);
    expect(screen.getByLabelText("最多发送次数")).toHaveValue(15);
    await group(user, "收银台展示");
    expect(screen.getByLabelText("收银台名称")).toHaveValue("我的模板");
    await group(user, "订单设置");
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    await mergeLatest(user);
    expect(view.puts).toHaveLength(1);
    await user.click(save());
    await screen.findByText("模板已保存");
    const expected: SitePolicy = {
      orders: { ...initialPolicy.orders, order_ttl_seconds: 600, amount_reuse_cooldown_seconds: 1200 },
      display: { ...initialPolicy.display, checkout_name: "我的模板", checkout_help_url: "https://help.example.com" },
      notification_delivery: { ...initialPolicy.notification_delivery, maximum_attempts: 15, timeout_milliseconds: 7000 },
    };
    expect(view.puts).toHaveLength(2);
    expect(view.puts[1]).toEqual({ revision: 1, policy: expected });
    expect(view.snapshot()).toEqual({ revision: 2, policy: expected });
    await act(async () => { await view.router.navigate("/sites/new"); });
    await user.type(await screen.findByLabelText("业务网站名称"), "使用恢复后模板的网站");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await screen.findByText("新网站已创建");
    expect(view.creations).toHaveLength(1);
    expect(view.creations[0]).toMatchObject({
      operation_id: expect.any(String),
      configuration: { name: "使用恢复后模板的网站", policy: expected },
    });
  });

  it.each(["保留我的修改", "采用服务器值"])("requires an explicit same-field choice and a separate save: %s", async choice => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await group(user, "通知策略");
    edit("最多发送次数", "15");
    view.changeRemote(policy => {
      policy.orders.order_ttl_seconds = 900;
      policy.display.checkout_name = "服务器收银台";
    });
    await user.click(save());
    await user.click(await reload());
    await screen.findByText("同一字段存在不同修改");
    expect(save()).toBeDisabled();
    expect(screen.getByRole("button", { name: "应用核对结果" })).toBeDisabled();
    expect(screen.getByText("原值：300")).toBeVisible();
    expect(screen.getByText("服务器值：900")).toBeVisible();
    expect(screen.getByText("我的值：600")).toBeVisible();
    await user.click(screen.getByRole("button", { name: choice }));
    expect(save()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    await screen.findByText("最新模板已合并，尚未保存");
    expect(view.puts).toHaveLength(1);
    const ttl = choice === "保留我的修改" ? 600 : 900;
    await group(user, "订单设置");
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(ttl);
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(2);
    expect(view.puts[1]).toEqual({ revision: 1, policy: {
      orders: { ...initialPolicy.orders, order_ttl_seconds: ttl },
      display: { ...initialPolicy.display, checkout_name: "服务器收银台" },
      notification_delivery: { ...initialPolicy.notification_delivery, maximum_attempts: 15 },
    } });
  });

  it("freezes the product-name switch after a revision conflict and while reviewing same-field changes", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "收银台展示");
    edit("收银台名称", "我的模板");
    const productName = screen.getByRole("switch", { name: "显示商品名称" });
    expect(productName).toHaveAttribute("aria-checked", "true");
    view.changeRemote(policy => { policy.display.checkout_name = "服务器模板"; });
    await user.click(save());
    await reload();
    // The Base UI root is a span: native fieldset disabling does not block its
    // click handler, although user-event treats all fieldset descendants as disabled.
    fireEvent.click(productName);
    expect(productName).toHaveAttribute("aria-checked", "true");
    expect(productName).toHaveAttribute("data-disabled");
    await user.click(await reload());
    await screen.findByText("同一字段存在不同修改");
    fireEvent.click(productName);
    expect(productName).toHaveAttribute("aria-checked", "true");
    expect(productName).toHaveAttribute("data-disabled");
    await user.click(screen.getByRole("button", { name: "保留我的修改" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    await screen.findByText("最新模板已合并，尚未保存");
    expect(view.puts).toHaveLength(1);
    expect(productName).not.toHaveAttribute("data-disabled");
    await user.click(productName);
    expect(productName).toHaveAttribute("aria-checked", "false");
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts[1]).toMatchObject({ revision: 1, policy: { display: {
      checkout_name: "我的模板", checkout_show_product_name: false,
    } } });
  });

  it("retains the draft when the recovery read fails and permits an explicit retry", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "收银台展示");
    edit("收银台名称", "读取失败仍保留");
    view.changeRemote(policy => { policy.notification_delivery.maximum_attempts = 18; });
    await user.click(save());
    await reload();
    view.failReads(true);
    await user.click(await reload());
    await screen.findByText("无法连接服务，请检查网络后重试。");
    expect(screen.getByLabelText("收银台名称")).toHaveValue("读取失败仍保留");
    expect(save()).toBeDisabled();
    expect(view.puts).toHaveLength(1);
    view.failReads(false);
    await mergeLatest(user);
    expect(view.puts).toHaveLength(1);
    expect(screen.getByLabelText("收银台名称")).toHaveValue("读取失败仍保留");
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts[1]).toMatchObject({ revision: 1, policy: {
      display: { checkout_name: "读取失败仍保留" },
      notification_delivery: { maximum_attempts: 18 },
    } });
  });

  it("can repeat recovery after another administrator changes the template again", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    view.changeRemote(policy => { policy.display.checkout_name = "第一次远端修改"; });
    await user.click(save());
    await mergeLatest(user);
    edit("待付款订单上限", "7");
    view.changeRemote(policy => { policy.notification_delivery.timeout_milliseconds = 8000; });
    await user.click(save());
    await mergeLatest(user);
    expect(view.puts).toHaveLength(2);
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    expect(screen.getByLabelText("待付款订单上限")).toHaveValue(7);
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts.map(body => body.revision)).toEqual([0, 1, 2]);
    expect(view.snapshot()).toEqual({ revision: 3, policy: {
      orders: { ...initialPolicy.orders, order_ttl_seconds: 600, pending_order_limit: 7 },
      display: { ...initialPolicy.display, checkout_name: "第一次远端修改" },
      notification_delivery: { ...initialPolicy.notification_delivery, timeout_milliseconds: 8000 },
    } });
  });

  it("refreshes the template on reentry instead of repeatedly saving a cached revision", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    expect(await screen.findByLabelText("收银台有效期（秒）")).toHaveValue(300);
    await act(async () => { await view.router.navigate("/sites"); });
    await screen.findByText("暂无网站");
    view.changeRemote(policy => { policy.orders.order_ttl_seconds = 900; });
    await act(async () => { await view.router.navigate("/sites/defaults"); });
    await waitFor(() => expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(900));
    edit("收银台有效期（秒）", "1200");
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(1);
    expect(view.puts[0]).toMatchObject({ revision: 1, policy: { orders: { order_ttl_seconds: 1200 } } });
  });

  it("keeps a successful save when an older background GET completes afterwards", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    const delayed = view.delayNextRead();
    let refresh!: Promise<void>;
    await act(async () => { refresh = queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await waitFor(() => expect(delayed.started()).toBe(true));
    await user.click(save());
    await screen.findByText("模板已保存");
    await act(async () => { delayed.release(); await refresh; });
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    expect(queryClient.getQueryData<{ data: TemplateSnapshot }>(["site-defaults"])?.data).toEqual(view.snapshot());
    edit("收银台有效期（秒）", "900");
    await user.click(save());
    await waitFor(() => expect(view.puts).toHaveLength(2));
    await screen.findByText("模板已保存");
    expect(view.puts.map(body => body.revision)).toEqual([0, 1]);
    expect(view.snapshot().policy.orders.order_ttl_seconds).toBe(900);
  });

  it("keeps a merged draft behind the navigation guard until the administrator saves or discards it", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    view.changeRemote(policy => { policy.display.checkout_name = "服务器模板"; });
    await user.click(save());
    await mergeLatest(user);
    await act(async () => { await view.router.navigate("/sites"); });
    const guard = await screen.findByRole("alertdialog");
    expect(view.router.state.location.pathname).toBe("/sites/defaults");
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    expect(view.puts).toHaveLength(1);
    await user.click(save());
    await screen.findByText("模板已保存");
    await act(async () => { await view.router.navigate("/sites"); });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not queue an offline save or resubmit it after discarding and reconnecting", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await network(false);
    await user.click(save());
    await screen.findByRole("alert");
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    expect(screen.getByLabelText("收银台有效期（秒）")).toBeEnabled();
    expect(queryClient.getMutationCache().getAll().some(mutation => mutation.state.isPaused)).toBe(false);
    const beforeReconnect = view.attempts.filter(request => request.method === "PUT").length;
    await act(async () => { await view.router.navigate("/sites"); });
    const guard = await screen.findByRole("alertdialog");
    await user.click(within(guard).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/sites"));
    await network(true);
    await act(async () => { await queryClient.resumePausedMutations(); });
    expect(view.attempts.filter(request => request.method === "PUT")).toHaveLength(beforeReconnect);
    expect(view.puts).toHaveLength(0);
    expect(view.snapshot()).toEqual({ revision: 0, policy: initialPolicy });
  });

  it("retains an offline draft and waits for an explicit save after the network returns", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await network(false);
    await user.click(save());
    await screen.findByRole("alert");
    await network(true);
    await act(async () => { await queryClient.resumePausedMutations(); });
    expect(view.puts).toHaveLength(0);
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(1);
    expect(view.puts[0]).toMatchObject({ revision: 0, policy: { orders: { order_ttl_seconds: 600 } } });
  });

  it("preserves a dirty draft when a newer background snapshot arrives and requires comparison", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    view.changeRemote(policy => { policy.display.checkout_name = "后台更新的模板"; });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await reload();
    expect(screen.getByLabelText("收银台有效期（秒）")).toHaveValue(600);
    expect(save()).toBeDisabled();
    expect(view.puts).toHaveLength(0);
    await mergeLatest(user);
    expect(view.puts).toHaveLength(0);
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts).toHaveLength(1);
    expect(view.puts[0]).toMatchObject({ revision: 1, policy: {
      orders: { order_ttl_seconds: 600 }, display: { checkout_name: "后台更新的模板" },
    } });
  });

  it("invalidates earlier conflict choices when a newer background snapshot arrives during comparison", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await screen.findByLabelText("收银台有效期（秒）");
    edit("收银台有效期（秒）", "600");
    await group(user, "收银台展示");
    edit("收银台名称", "本地收银台");
    view.changeRemote(policy => {
      policy.orders.order_ttl_seconds = 900;
      policy.notification_delivery.maximum_attempts = 18;
    });
    await user.click(save());
    await user.click(await reload());
    await screen.findByText("服务器值：900");
    await user.click(screen.getByRole("button", { name: "保留我的修改" }));
    expect(screen.getByRole("button", { name: "应用核对结果" })).toBeEnabled();
    view.changeRemote(policy => {
      policy.orders.order_ttl_seconds = 1200;
      policy.display.checkout_help_url = "https://new-help.example.com";
    });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["site-defaults"] }); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "应用核对结果" })).not.toBeInTheDocument());
    expect(save()).toBeDisabled();
    expect(screen.getByLabelText("收银台名称")).toHaveValue("本地收银台");
    await user.click(await reload());
    await screen.findByText("服务器值：1200");
    expect(screen.getByRole("button", { name: "应用核对结果" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "采用服务器值" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(view.puts).toHaveLength(1);
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts.map(body => body.revision)).toEqual([0, 2]);
    expect(view.snapshot()).toEqual({ revision: 3, policy: {
      orders: { ...initialPolicy.orders, order_ttl_seconds: 1200 },
      display: { ...initialPolicy.display, checkout_name: "本地收银台", checkout_help_url: "https://new-help.example.com" },
      notification_delivery: { ...initialPolicy.notification_delivery, maximum_attempts: 18 },
    } });
  });

  it("opens and focuses the failing group when a merged policy violates a cross-field constraint", async () => {
    const view = mountDefaults(), user = userEvent.setup();
    await group(user, "通知策略");
    edit("首次重试间隔（秒）", "600");
    await group(user, "收银台展示");
    edit("收银台名称", "校验失败也保留");
    view.changeRemote(policy => { policy.notification_delivery.retry_maximum_seconds = 300; });
    await user.click(save());
    await mergeLatest(user);
    expect(screen.getByRole("tab", { name: "收银台展示" })).toHaveAttribute("aria-selected", "true");
    await user.click(save());
    await screen.findByText("最大重试间隔不能小于首次重试间隔。");
    expect(screen.getByRole("tab", { name: "通知策略" })).toHaveAttribute("aria-selected", "true");
    const maximum = screen.getByLabelText("最大重试间隔（秒）");
    expect(maximum).toBeVisible();
    expect(maximum).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(maximum).toHaveFocus());
    expect(screen.getByLabelText("首次重试间隔（秒）")).toHaveValue(600);
    expect(maximum).toHaveValue(300);
    expect(view.puts).toHaveLength(2);
    edit("最大重试间隔（秒）", "1200");
    await user.click(save());
    await screen.findByText("模板已保存");
    expect(view.puts.map(body => body.revision)).toEqual([0, 1, 1]);
    expect(view.snapshot().policy).toMatchObject({
      display: { checkout_name: "校验失败也保留" },
      notification_delivery: { retry_base_seconds: 600, retry_maximum_seconds: 1200 },
    });
  });
});
