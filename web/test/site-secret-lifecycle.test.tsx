import { Toaster } from "../src/components/ui/toast";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { SiteEditorPage } from "../src/pages/Sites";
import { json } from "./fixtures";

function mount(action: "view" | "rotate", purpose: "api_secret" | "webhook_secret", configured = true) {
  let site: Site = { secrets: { api_secret: configured, webhook_secret: configured }, client_id: "site_a", revision: 0, configuration: {
    name: "A", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
    policy: { orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "A", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 1, retry_maximum_seconds: 60 } },
  }, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T00:00:00Z", deleted_at: null };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Request[] = [];
  let delayNext = false;
  let failNext = false;
  let missingNext = false;
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (request.method === "GET") return json({ data: request.url.endsWith("/site_b") ? { ...site, client_id: "site_b", configuration: { ...site.configuration, name: "B" } } : site });
    requests.push(request);
    if (failNext) {
      failNext = false;
      if (missingNext) return json({ error: { code: "site_secret_missing", message: "尚未生成该网站的密钥。" } }, 409);
      return json({ error: { code: "temporarily_unavailable", message: "密钥读取暂不可用" } }, 503);
    }
    if (delayNext) {
      delayNext = false;
      expect(request.url).toContain(`/secrets/${purpose}/actions/${action}`);
      // A committed rotation can finish after the user has cancelled only its display.
      if (action === "rotate") site = { ...site, revision: site.revision + 1 };
      await held;
      return json({ data: action === "rotate" ? { site, secret: "late-secret" } : { secret: "late-secret" } });
    }
    if (request.url.endsWith("/actions/rotate")) { site = { ...site, secrets: { ...site.secrets, [purpose]: true }, revision: site.revision + 1 }; return json({ data: { site, secret: "explicit-secret" } }); }
    return json({ data: { secret: "explicit-secret" } });
  }));
  const router = createMemoryRouter([{ path: "/sites/:clientId/settings/:section", element: <DraftProvider><SiteEditorPage /></DraftProvider> }], { initialEntries: ["/sites/site_a/settings/integration"] });
  render(<QueryClientProvider client={queryClient}><Toaster><RouterProvider router={router} /></Toaster></QueryClientProvider>);
  return { router, requests, delay: () => { delayNext = true; }, fail: (missing = false) => { failNext = true; missingNext = missing; }, release };
}


const secretName = (purpose: "api_secret" | "webhook_secret") => purpose === "api_secret" ? "API 密钥" : "通知签名密钥";
async function closeSecret(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(screen.getByRole("dialog", { name: /^(API 密钥|通知签名密钥)$/ })).getByRole("button", { name: "关闭" }));
}

describe("网站密钥独立弹窗", () => {
  it.each(["api_secret", "webhook_secret"] as const)("首次直接生成%s，成功后才能查看或轮换", async purpose => {
    const view = mount("rotate", purpose, false), user = userEvent.setup(), name = secretName(purpose);
    const label = (purpose === "api_secret" ? " " : "") + name;
    await user.click(await screen.findByRole("button", { name: "生成" + label }));
    expect(screen.queryByRole("button", { name: "查看" + label })).not.toBeInTheDocument();
    expect(view.requests).toHaveLength(0);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "生成密钥" }));
    expect(await screen.findByDisplayValue("explicit-secret")).toBeVisible();
    await closeSecret(user);
    expect(screen.getByRole("button", { name: "查看" + label })).toBeEnabled();
    expect(screen.getByRole("button", { name: "轮换" + label })).toBeEnabled();
    expect(view.requests).toHaveLength(1);
    expect(view.requests[0]!.url).toContain(`/secrets/${purpose}/actions/rotate`);
  });
  it.each(["api_secret", "webhook_secret"] as const)("在弹窗说明%s缺失，关闭后显示生成入口", async purpose => {
    const view = mount("view", purpose), user = userEvent.setup(), name = secretName(purpose);
    const button = await screen.findByRole("button", { name: "查看" + (purpose === "api_secret" ? " " : "") + name });
    view.fail(true);
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name });
    expect(await within(dialog).findByText("尚未生成该网站的密钥。")).toBeVisible();
    expect(view.requests).toHaveLength(1);
    expect(view.requests[0]!.url).toContain("/actions/view");
    await closeSecret(user);
    await user.click(screen.getByRole("button", { name: "生成" + (purpose === "api_secret" ? " " : "") + name }));
    expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "生成密钥" })).toBeVisible();
    expect(view.requests).toHaveLength(1);
  });

  it.each(["api_secret", "webhook_secret"] as const)("%s读取后只在弹窗显示，关闭清除并返回原按钮", async purpose => {
    const view = mount("view", purpose), user = userEvent.setup(), name = secretName(purpose);
    const button = await screen.findByRole("button", { name: purpose === "api_secret" ? "查看 API 密钥" : "查看通知签名密钥" });
    view.delay();
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name });
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await act(async () => { view.release(); });
    expect(await within(dialog).findByDisplayValue("late-secret")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "复制" + name })).toBeVisible();
    expect(document.querySelector('[data-site-secret-result]')).toBeNull();
    await closeSecret(user);
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    expect(view.requests).toHaveLength(1);
  });

  it.each(["api_secret", "webhook_secret"] as const)("%s读取失败后在同一弹窗重新读取", async purpose => {
    const view = mount("view", purpose), user = userEvent.setup(), name = secretName(purpose);
    view.fail();
    await user.click(await screen.findByRole("button", { name: purpose === "api_secret" ? "查看 API 密钥" : "查看通知签名密钥" }));
    const dialog = await screen.findByRole("dialog", { name });
    expect(await within(dialog).findByText("密钥读取暂不可用")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "重新读取" }));
    expect(await within(dialog).findByDisplayValue("explicit-secret")).toBeVisible();
    expect(within(dialog).queryByText("密钥读取暂不可用")).not.toBeInTheDocument();
    expect(view.requests).toHaveLength(2);
  });

  it.each(["api_secret", "webhook_secret"] as const)("关闭%s读取会取消请求，迟到响应不会重新打开", async purpose => {
    const view = mount("view", purpose), user = userEvent.setup();
    view.delay();
    await user.click(await screen.findByRole("button", { name: purpose === "api_secret" ? "查看 API 密钥" : "查看通知签名密钥" }));
    await waitFor(() => expect(view.requests).toHaveLength(1));
    await closeSecret(user);
    expect(view.requests[0]!.signal.aborted).toBe(true);
    await act(async () => { view.release(); });
    expect(screen.queryByRole("dialog", { name: /^(API 密钥|通知签名密钥)$/ })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
  });

  it.each(["api_secret", "webhook_secret"] as const)("%s轮换显示警告并在处理中禁关，离开页面后迟到结果只更新版本", async purpose => {
    const view = mount("rotate", purpose), user = userEvent.setup(), name = secretName(purpose);
    view.delay();
    await user.click(await screen.findByRole("button", { name: purpose === "api_secret" ? "轮换 API 密钥" : "轮换通知签名密钥" }));
    const warning = await screen.findByRole("alertdialog", { name: "轮换" + (purpose === "api_secret" ? " " : "") + name + "？" });
    expect(view.requests).toHaveLength(0);
    await user.click(within(warning).getByRole("button", { name: "确认轮换" }));
    expect(within(warning).getByRole("button", { name: "取消" })).toBeDisabled();
    await waitFor(() => expect(view.requests).toHaveLength(1));
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(view.requests[0]!.signal.aborted).toBe(false);
    await act(async () => { view.release(); });
    await waitFor(() => expect(queryClient.getQueryData(["site-editor", "site_a"])).toMatchObject({ site: { revision: 1 } }));
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^(API 密钥|通知签名密钥)$/ })).not.toBeInTheDocument();
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain("late-secret");
  });

  it("轮换失败留在警告弹窗，关闭前不能再次提交", async () => {
    const view = mount("rotate", "api_secret"), user = userEvent.setup();
    view.fail();
    await user.click(await screen.findByRole("button", { name: "轮换 API 密钥" }));
    await user.click(screen.getByRole("button", { name: "确认轮换" }));
    const warning = screen.getByRole("alertdialog");
    await within(warning).findByText("密钥读取暂不可用");
    expect(within(warning).getByRole("button", { name: "确认轮换" })).toBeDisabled();
    await user.click(within(warning).getByRole("button", { name: "关闭" }));
    await user.click(screen.getByRole("button", { name: "查看 API 密钥" }));
    expect(await screen.findByDisplayValue("explicit-secret")).toBeVisible();
    expect(view.requests.map(request => new URL(request.url).pathname.split("/").at(-1))).toEqual(["rotate", "view"]);
  });

  it.each(["visibilitychange", "pagehide"])("%s清除可见密钥", async event => {
    mount("view", "api_secret");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "查看 API 密钥" }));
    await screen.findByDisplayValue("explicit-secret");
    if (event === "visibilitychange") vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => { (event === "pagehide" ? window : document).dispatchEvent(new Event(event)); });
    expect(screen.queryByDisplayValue("explicit-secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^(API 密钥|通知签名密钥)$/ })).not.toBeInTheDocument();
  });

  it("60秒后关闭密钥弹窗并清除明文", async () => {
    mount("view", "api_secret");
    const user = userEvent.setup();
    const schedule = vi.spyOn(window, "setTimeout");
    await user.click(await screen.findByRole("button", { name: "查看 API 密钥" }));
    await screen.findByDisplayValue("explicit-secret");
    const expire = schedule.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
    expect(typeof expire).toBe("function");
    await act(async () => { if (typeof expire === "function") expire(); });
    expect(screen.queryByDisplayValue("explicit-secret")).not.toBeInTheDocument();
  });

  it("切换网站后不会显示前一网站的迟到密钥", async () => {
    const view = mount("view", "webhook_secret"), user = userEvent.setup();
    view.delay();
    await user.click(await screen.findByRole("button", { name: "查看通知签名密钥" }));
    await waitFor(() => expect(view.requests).toHaveLength(1));
    await act(async () => { await view.router.navigate("/sites/site_b/settings/integration"); });
    await act(async () => { view.release(); });
    expect(screen.queryByDisplayValue("late-secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^(API 密钥|通知签名密钥)$/ })).not.toBeInTheDocument();
  });
});
