import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
function mount(path = "/sites/site_test", failSave = false) {
  let saved = structuredClone(initial), defaults = structuredClone(policy);
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      const body = await request.clone().json() as Record<string, unknown>;
      writes.push({ path, method: request.method, body });
      if (failSave) throw new TypeError("network failure");
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
    { path: "/sites", element: <Sites /> }, { path: "/sites/new", element: <SiteEditorPage /> }, { path: "/sites/defaults", element: <SiteDefaultsPage /> }, { path: "/sites/:clientId", element: <SiteEditorPage /> },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { router, writes, fetchMock };
}
afterEach(() => onlineManager.setOnline(true));

describe("business website management", () => {
  it("prefills a new site from a detached complete template without identities or credentials", async () => {
    const view = mount("/sites/new");
    expect(await screen.findByLabelText("订单有效期（秒）")).toHaveValue(300);
    expect(screen.queryByLabelText("客户端 ID")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "开启通知" })).toHaveAttribute("aria-disabled", "true");
    const user = userEvent.setup(); await user.type(screen.getByLabelText("网站名称"), "新网站");
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    expect(view.writes).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ operation_id: expect.any(String), configuration: { name: "新网站", policy, notification_origin: null, return_origin: null } });
    expect(view.writes[0]!.body).not.toHaveProperty("client_id");
  });
  it("keeps pause independent of notifications and saves the website revision", async () => {
    const view = mount(); const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: "允许新订单" }));
    expect(screen.getByRole("switch", { name: "开启通知" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await waitFor(() => expect(view.writes).toHaveLength(1));
    expect(view.writes[0]!.body).toMatchObject({ revision: 0, configuration: { accepting_orders: false, notifications_enabled: false } });
  });
  it("preserves drafts after a network failure and never queues an automatic resubmit", async () => {
    const view = mount("/sites/site_test", true); const user = userEvent.setup();
    const name = await screen.findByLabelText("网站名称"); await user.clear(name); await user.type(name, "失败后保留");
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    await screen.findByRole("alert");
    expect(name).toHaveValue("失败后保留"); expect(view.writes).toHaveLength(1);
    expect(queryClient.getMutationCache().getAll().some(m => m.state.isPaused)).toBe(false);
    await queryClient.resumePausedMutations(); expect(view.writes).toHaveLength(1);
  });
  it("rotates only the selected website key without replacing an unsaved configuration draft", async () => {
    const view = mount(); const user = userEvent.setup();
    const name = await screen.findByLabelText("网站名称"); await user.clear(name); await user.type(name, "尚未保存的名字");
    await user.click(screen.getByRole("button", { name: "生成／轮换 API 密钥" }));
    await user.click(await screen.findByRole("button", { name: "确认" }));
    expect(await screen.findByDisplayValue("synthetic-site-key")).toBeVisible();
    expect(name).toHaveValue("尚未保存的名字");
    expect(view.writes[0]!.path).toBe("/api/admin/v1/sites/site_test/secrets/api_secret/actions/rotate");
    await user.click(screen.getByRole("button", { name: "保存网站" })); await user.click(await screen.findByRole("button", { name: "确认" }));
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
  it("searches through the server and exposes explicit site management links", async () => {
    const view = mount("/sites"); const user = userEvent.setup();
    expect(await screen.findByRole("link", { name: "网站 A" })).toHaveAttribute("href", "/sites/site_test");
    await user.type(screen.getByLabelText("搜索网站"), "site_test");
    await waitFor(() => expect(view.fetchMock.mock.calls.some(([request]) => new URL(request.url).searchParams.get("q") === "site_test")).toBe(true));
    expect(view.writes).toHaveLength(0);
  });
});
