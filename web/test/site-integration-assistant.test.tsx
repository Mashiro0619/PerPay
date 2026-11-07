import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function mount(options: { dirty?: boolean; currentSite?: Site; failExport?: boolean } = {}) {
  let saved = { ...configuration };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const reload = vi.fn();
  let secretResponse: (() => Promise<Response>) | null = null;
  const fetchMock = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return json({ data: saved });
    const body = await request.clone().json() as Record<string, unknown>;
    writes.push({ path, body });
    if (path.endsWith("/integration/export")) {
      if (options.failExport) return json({ error: { code: "epay_revision_conflict", message: "接入配置已变化，请重新读取。" } }, 409);
      return new Response("PAYMENT_PROTOCOL=" + body.protocol + "\nSYNTHETIC_KEY=secret\n", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path.endsWith("/actions/view")) return secretResponse ? secretResponse() : json({ data: { secret: "synthetic-private-key", public_key: "synthetic-public-key" } });
    if (path.endsWith("/actions/rotate")) {
      saved = { ...saved, revision: saved.revision + 1 };
      return json({ data: { configuration: saved, secret: "rotated-secret-not-cached" } });
    }
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
    deferSecret() {
      let resolve!: (response: Response) => void;
      secretResponse = () => new Promise(done => { resolve = done; });
      return () => resolve(json({ data: { secret: "late-secret" } }));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn(() => "blob:synthetic-config");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(async () => {
  vi.useRealTimers();
  await queryClient.cancelQueries();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("website integration assistant", () => {
  it("uses the configured public origin and exports a version-bound native file without displaying its secrets", async () => {
    const fixture = mount();
    expect(await screen.findByText("https://pay.example.com")).toBeInTheDocument();
    expect(screen.getByText("public_alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载完整配置" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(fixture.writes[0]).toEqual({ path: "/api/admin/v1/sites/site_alpha/integration/export", body: {
      protocol: "native", site_revision: 7, epay_revision: 4,
      notify_url: "https://demo.example.com/webhooks/perpay", return_url: "https://demo.example.com/return",
    } });
    expect(screen.queryByText(/SYNTHETIC_KEY/)).not.toBeInTheDocument();
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("SYNTHETIC_KEY");
    fixture.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-config");
  });

  it("switches V1/V2 instructions, gateway, PID and exported protocol", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    expect(screen.getByText("https://pay.example.com/")).toBeInTheDocument();
    expect(screen.getByText("10001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看V2 商户私钥" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "下载完整配置" }));
    await waitFor(() => expect(fixture.writes[0]?.body.protocol).toBe("epay_v2"));
    await waitFor(() => expect(screen.getByRole("button", { name: "易支付 V1" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.getByRole("button", { name: "查看V1 密钥" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看V2 商户私钥" })).not.toBeInTheDocument();
  });

  it("blocks export and key mutations while the website has unsaved edits", async () => {
    const fixture = mount({ dirty: true });
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成／轮换V1 密钥" })).toBeDisabled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    expect(fixture.writes).toHaveLength(0);
  });

  it("saves switches separately and prevents exporting an unsaved protocol draft", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "保存易支付设置" }));
    await waitFor(() => expect(fixture.writes[0]?.body).toEqual({ revision: 4, v1_enabled: false, v2_enabled: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "保存易支付设置" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeEnabled();
    expect(screen.getByText("此协议已暂停新订单。")).toBeInTheDocument();
  });

  it("points missing and mismatched callback URLs at the relevant fields", async () => {
    mount({ currentSite: { ...site, configuration: { ...site.configuration, notification_origin: null } } });
    await screen.findByText("网站接入助手");
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Demo 通知地址"), { target: { value: "https://evil.example.com/notify" } });
    expect(screen.getByText("请先保存对应的地址前缀。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Demo 返回地址（可选）"), { target: { value: "https://evil.example.com/return" } });
    expect(screen.getByLabelText("Demo 返回地址（可选）")).toHaveAttribute("aria-invalid", "true");
  });

  it("requires a refresh after a concurrent revision conflict", async () => {
    const fixture = mount({ failExport: true });
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "下载完整配置" }));
    await screen.findByText("接入配置已变化，请重新读取。");
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重新读取配置" }));
    await waitFor(() => expect(fixture.reload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "下载完整配置" })).toBeEnabled());
  });

  it("hides revealed private keys on protocol changes and ignores responses after leaving", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V2" }));
    await userEvent.click(screen.getByRole("button", { name: "查看V2 商户私钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    const release = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看V1 密钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(2));
    fixture.unmount();
    await act(async () => release());
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
  });

  it("requires confirmation for rotation and keeps the returned secret out of caches", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    await userEvent.click(screen.getByRole("button", { name: "生成／轮换V1 密钥" }));
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
    await userEvent.click(screen.getByRole("button", { name: "查看V2 商户私钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(event === "visibilitychange");
    const hide = () => act(() => { (event === "pagehide" ? window : document).dispatchEvent(new Event(event)); });
    hide();
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    hidden.mockReturnValue(false);
    const release = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看V2 商户私钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(2));
    const request = fixture.fetchMock.mock.calls.map(([request]) => request).at(-1)!;
    hidden.mockReturnValue(event === "visibilitychange");
    hide();
    expect(request.signal.aborted).toBe(true);
    hidden.mockReturnValue(false);
    await act(async () => release());
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    const releaseFresh = fixture.deferSecret();
    await userEvent.click(screen.getByRole("button", { name: "查看V2 商户私钥" }));
    await waitFor(() => expect(fixture.writes.filter(write => write.path.endsWith("/actions/view"))).toHaveLength(3));
    await act(async () => releaseFresh());
    expect(await screen.findByDisplayValue("late-secret")).toBeInTheDocument();
  });

  it("expires a revealed key after 60 seconds and clears keys on revision changes", async () => {
    mount();
    await screen.findByText("网站接入助手");
    await userEvent.click(screen.getByRole("button", { name: "易支付 V1" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "查看V1 密钥" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(screen.getByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument();
    vi.useRealTimers();
    await userEvent.click(screen.getByRole("button", { name: "查看V1 密钥" }));
    expect(await screen.findByDisplayValue("synthetic-private-key")).toBeInTheDocument();
    act(() => queryClient.setQueryData(siteEpayKey(site.client_id), { ...configuration, revision: 5 }));
    await waitFor(() => expect(screen.queryByDisplayValue("synthetic-private-key")).not.toBeInTheDocument());
  });

  it("aborts a hidden configuration export and requires an explicit new download", async () => {
    const fixture = mount();
    await screen.findByText("网站接入助手");
    let release!: (response: Response) => void;
    fixture.fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "下载完整配置" }));
    await waitFor(() => expect(fixture.fetchMock.mock.calls.some(([request]) => request.url.endsWith("/integration/export"))).toBe(true));
    const request = fixture.fetchMock.mock.calls.map(([request]) => request).at(-1)!;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(request.signal.aborted).toBe(true);
    hidden.mockReturnValue(false);
    await act(async () => release(new Response("SYNTHETIC_KEY=late-export", { headers: { "content-type": "text/plain" } })));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "下载完整配置" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "下载完整配置" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  });
});
