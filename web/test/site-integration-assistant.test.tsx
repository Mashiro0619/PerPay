import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { siteEpayKey, type SiteEpayConfiguration } from "../src/api/integration";
import { SiteIntegrationAssistant } from "../src/components/site-integration-assistant";
import { DraftProvider } from "../src/drafts";
import { json } from "./fixtures";

const site: Site = {
  client_id: "site_alpha", api_client_id: "public_alpha", revision: 7,
  created_at: "2026-11-07T00:00:00Z", updated_at: "2026-11-07T00:00:00Z", deleted_at: null,
  configuration: {
    name: "网站 A", accepting_orders: true, notifications_enabled: true,
    notification_origin: "https://demo.example.com", return_origin: "https://demo.example.com",
    policy: {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "收银台", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 12, retry_base_seconds: 5, retry_maximum_seconds: 3600 },
    },
  },
};
const configuration: SiteEpayConfiguration = {
  client_id: "site_alpha", pid: "10001", revision: 4, v1_enabled: true, v2_enabled: true,
  v1_key_version: 1, merchant_key_version: 1, platform_key_version: 1, public_origin: "https://pay.example.com",
};

function mount(options: { dirty?: boolean; currentSite?: Site } = {}) {
  let saved = { ...configuration };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reload = vi.fn();
  let secretResponse: (() => Promise<Response>) | null = null;
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return json({ data: saved });
    const body = await request.clone().json() as Record<string, unknown>;
    writes.push({ path, body });
    if (path.endsWith("/actions/view")) return secretResponse ? secretResponse() : json({ data: { secret: "synthetic-private-key", public_key: "synthetic-public-key" } });
    if (path.endsWith("/actions/rotate")) {
      saved = { ...saved, revision: saved.revision + 1 };
      return json({ data: { configuration: saved, secret: "rotated-secret-not-cached" } });
    }
    if (body.revision !== saved.revision) return json({ error: { code: "epay_revision_conflict", message: "接入配置已变化，请重新读取。" } }, 409);
    saved = { ...saved, ...body, revision: saved.revision + 1 };
    return json({ data: saved });
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter([{
    path: "/sites/:clientId/settings/integration",
    element: <DraftProvider><SiteIntegrationAssistant site={options.currentSite ?? site} siteDirty={options.dirty ?? false} onReloadSite={reload} /></DraftProvider>,
  }], { initialEntries: ["/sites/site_alpha/settings/integration"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, writes, reload, fetchMock,
    replaceConfiguration(next: SiteEpayConfiguration) { saved = { ...next }; },
    deferSecret() {
      let resolve!: (response: Response) => void;
      secretResponse = () => new Promise(done => { resolve = done; });
      return () => resolve(json({ data: { secret: "late-secret" } }));
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("website integration assistant", () => {
  it("shows website connection parameters and documentation without a Demo workflow", async () => {
    const fixture = mount();
    expect(await screen.findByText("https://pay.example.com")).toBeVisible();
    expect(screen.getByText("public_alpha")).toBeVisible();
    expect(screen.getByRole("link", { name: "管理 API 与通知密钥" })).toHaveAttribute("href", expect.stringContaining("/sites/site_alpha/edit?section=integration"));
    for (const label of ["原生 API", "易支付 V1", "易支付 V2"]) {
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(screen.getByRole("link", { name: "接入文档" })).toHaveAttribute("href",
        "https://github.com/Mashiro0619/PerPay/blob/main/docs/" + (label === "原生 API" ? "integration-quickstart.md" : "epay-integration.md"));
      expect(fixture.container).not.toHaveTextContent(/Demo|调用示例/);
      expect(screen.queryByRole("textbox", { name: /通知地址|返回地址/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /下载/ })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "查看商户私钥" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看平台公钥" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更新商户私钥" })).toBeVisible();
    expect(screen.getByRole("button", { name: "更新平台私钥" })).toBeVisible();
    expect(fixture.writes).toHaveLength(0);
  });

  it("switches V1/V2 gateway, PID and key controls", async () => {
    mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    expect(screen.getByText("https://pay.example.com/")).toBeVisible();
    expect(screen.getByText("10001")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看商户私钥" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.getByRole("button", { name: "查看商户密钥" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看商户私钥" })).not.toBeInTheDocument();
  });

  it("blocks key reads and mutations while the website has unsaved edits", async () => {
    const fixture = mount({ dirty: true });
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.getByRole("button", { name: "查看商户密钥" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更新商户密钥" })).toBeDisabled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    expect(fixture.writes).toHaveLength(0);
  });

  it("saves switches separately and makes existing credentials available while paused", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("button", { name: "查看商户密钥" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await waitFor(() => expect(fixture.writes[0]?.body).toEqual({ revision: 4, v1_enabled: false, v2_enabled: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存易支付设置" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "查看商户密钥" })).toBeEnabled();
    expect(screen.getByText("此协议已暂停新订单。")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "查看商户密钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeVisible();
  });

  it("shows only the platform public key from the V2 integration entry", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    await userEvent.click(screen.getByRole("button", { name: "查看平台公钥" }));
    await waitFor(() => expect(fixture.container).toHaveTextContent("synthetic-public-key"));
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    expect(fixture.container).not.toHaveTextContent("synthetic-private-key");
    expect(fixture.writes[0]?.path).toBe("/api/admin/v1/sites/site_alpha/secrets/epay_platform/actions/view");
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("synthetic-private-key");
  });

  it("shows read progress and toggles a credential in place without issuing another read", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    const group = screen.getByRole("group", { name: "商户密钥" });
    const view = within(group).getByRole("button", { name: "查看商户密钥" });
    expect(within(group).getByRole("button", { name: "更新商户密钥" })).toBeVisible();
    const release = fixture.deferSecret();
    await userEvent.click(view);
    expect(view).toHaveAttribute("aria-busy", "true");
    expect(view).toHaveTextContent("正在读取");
    expect(view).toBeDisabled();
    await act(async () => release());
    expect(await within(group).findByDisplayValue("late-secret")).toBeVisible();
    expect(view).toHaveAccessibleName("隐藏商户密钥");
    expect(within(group).queryByRole("button", { name: "查看商户密钥" })).not.toBeInTheDocument();
    await userEvent.click(view);
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    expect(view).toHaveAccessibleName("查看商户密钥");
    expect(fixture.writes).toHaveLength(1);
  });

  it("replaces platform private key output when viewing the public key", async () => {
    mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    await userEvent.click(screen.getByRole("button", { name: "查看平台私钥" }));
    expect(await within(screen.getByRole("group", { name: "平台私钥" })).findByDisplayValue("synthetic-private-key")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "查看平台公钥" }));
    await waitFor(() => expect(screen.getByRole("group", { name: "平台公钥" })).toHaveTextContent("synthetic-public-key"));
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看平台私钥" })).toBeVisible();
    expect(screen.getByRole("button", { name: "隐藏平台公钥" })).toBeVisible();
  });

  it("hides revealed private keys on protocol changes and ignores responses after leaving", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    await userEvent.click(screen.getByRole("button", { name: "查看商户私钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    const release = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看商户密钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(2));
    fixture.unmount();
    await act(async () => release());
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
  });

  it("requires confirmation for rotation and keeps the returned secret out of caches", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("button", { name: "更新商户密钥" }));
    expect(fixture.writes).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "确认更新" }));
    await waitFor(() => expect(queryClient.getQueryData<SiteEpayConfiguration>(siteEpayKey(site.client_id))?.revision).toBe(5));
    expect(fixture.writes[0]?.body).toEqual({ revision: 4 });
    const cache = JSON.stringify({ queries: queryClient.getQueryCache().getAll().map(query => query.state.data), mutations: queryClient.getMutationCache().getAll().map(mutation => mutation.state.data) });
    expect(cache).not.toContain("rotated-secret");
  });

  for (const event of ["visibilitychange", "pagehide"] as const) it(`clears shown and in-flight keys on ${event}, then allows an explicit fresh read`, async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    await userEvent.click(screen.getByRole("button", { name: "查看商户私钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(event === "visibilitychange");
    const hide = () => act(() => { (event === "pagehide" ? window : document).dispatchEvent(new Event(event)); });
    hide();
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    hidden.mockReturnValue(false);
    const release = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看商户私钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(2));
    const request = fixture.fetchMock.mock.calls.map(([request]) => request).at(-1)!;
    hidden.mockReturnValue(event === "visibilitychange");
    hide();
    expect(request.signal.aborted).toBe(true);
    hidden.mockReturnValue(false);
    await act(async () => release());
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    const releaseFresh = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看商户私钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(3));
    await act(async () => releaseFresh());
    expect(await screen.findByDisplayValue("late-secret")).toBeInTheDocument();
  });

  it("expires a revealed key after 60 seconds and clears keys on revision changes", async () => {
    mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "查看商户密钥" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(screen.getByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "查看商户密钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    act(() => queryClient.setQueryData(siteEpayKey(site.client_id), { ...configuration, revision: 5 }));
    await waitFor(() => expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument());
  });


  for (const remoteV2 of [true, false]) it(`rebases a rejected switch edit without overwriting remote V2=${remoteV2}`, async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("switch"));
    fixture.replaceConfiguration({ ...configuration, revision: 5, v2_enabled: remoteV2, v1_key_version: 2 });
    // A background cache refresh must not silently change the edit baseline.
    act(() => queryClient.setQueryData(siteEpayKey(site.client_id), { ...configuration, revision: 5, v2_enabled: remoteV2, v1_key_version: 2 }));
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await screen.findByRole("button", { name: "重新读取配置" });
    expect(fixture.writes[0]?.body).toEqual({ revision: 4, v1_enabled: false, v2_enabled: true });
    expect(screen.getByRole("button", { name: "保存易支付设置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await screen.findByText("配置已重新读取，已保留你的修改，请核对后保存。");
    expect(fixture.writes).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await waitFor(() => expect(fixture.writes[1]?.body).toEqual({ revision: 5, v1_enabled: false, v2_enabled: remoteV2 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存易支付设置" })).not.toBeInTheDocument());
  });

  it("clears the draft if a concurrent change already applied the same switch value", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("switch"));
    fixture.replaceConfiguration({ ...configuration, revision: 5, v1_enabled: false });
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await userEvent.click(await screen.findByRole("button", { name: "重新读取配置" }));
    await screen.findByText("配置已重新读取，当前修改已与服务器一致。");
    expect(screen.queryByRole("button", { name: "保存易支付设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(fixture.writes).toHaveLength(1);
  });

  it("retains the draft and the explicit reload action when conflict recovery cannot read", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("switch"));
    fixture.replaceConfiguration({ ...configuration, revision: 5, v2_enabled: false });
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await screen.findByRole("button", { name: "重新读取配置" });
    fixture.fetchMock.mockImplementationOnce(async () => json({ error: { code: "internal_error", message: "暂时读取失败" } }, 503));
    await userEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新读取配置" })).toBeEnabled());
    expect(screen.getByRole("switch")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "保存易支付设置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await screen.findByText("配置已重新读取，已保留你的修改，请核对后保存。");
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await waitFor(() => expect(fixture.writes[1]?.body).toEqual({ revision: 5, v1_enabled: false, v2_enabled: false }));
  });
});
