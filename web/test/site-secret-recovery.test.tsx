import { Toaster } from "../src/components/ui/toast";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { SiteEditorPage } from "../src/pages/Sites";
import { json } from "./fixtures";

type Purpose = "api_secret" | "webhook_secret";
type SecretAction = "view" | "rotate";
const editorKey = ["site-editor", "site_secret_recovery"];
const viewLabel = (purpose: Purpose) => purpose === "api_secret" ? "查看 API 密钥" : "查看通知密钥";
const rotateLabel = (purpose: Purpose) => purpose === "api_secret" ? "生成／轮换 API 密钥" : "生成／轮换通知密钥";

function mount() {
  let site: Site = {
    client_id: "site_secret_recovery", revision: 0,
    configuration: {
      name: "网站 A", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null,
      policy: {
        orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
        display: { checkout_name: "A", checkout_help_url: null, checkout_show_product_name: true },
        notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 1, retry_maximum_seconds: 60 },
      },
    },
    created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", deleted_at: null,
  };
  const secrets: Record<Purpose, string> = { api_secret: "api-original", webhook_secret: "webhook-original" };
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const held = new Map<string, (response: Response) => Promise<Response>>();
  function rotate(purpose: Purpose) {
    site = { ...site, revision: site.revision + 1 };
    secrets[purpose] = purpose + "-revision-" + site.revision;
    return secrets[purpose];
  }
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return json({ data: site });
    const body = await request.clone().json() as Record<string, unknown>;
    writes.push({ path, method: request.method, body });
    const match = path.match(/\/secrets\/(api_secret|webhook_secret)\/actions\/(view|rotate)$/);
    if (match) {
      const purpose = match[1] as Purpose, action = match[2] as SecretAction;
      if (action === "rotate" && body.revision !== site.revision)
        return json({ error: { code: "site_revision_conflict", message: "网站配置已变更，请刷新后重试。" } }, 409);
      if (action === "rotate") rotate(purpose);
      // Capture the response at dispatch, before a later rotation can retire it.
      const response = json({ data: action === "rotate" ? { site, secret: secrets[purpose] } : { secret: secrets[purpose] } });
      const key = purpose + ":" + action, delay = held.get(key);
      held.delete(key);
      return delay ? delay(response) : response;
    }
    if (request.method === "PUT") {
      if (body.revision !== site.revision)
        return json({ error: { code: "site_revision_conflict", message: "网站配置已变更，请刷新后重试。" } }, 409);
      site = { ...site, revision: site.revision + 1, configuration: body.configuration as Site["configuration"] };
      return json({ data: site });
    }
    throw new Error("Unexpected request: " + request.method + " " + path);
  }));
  const router = createMemoryRouter([
    { path: "/sites/:clientId/settings/:section", element: <DraftProvider><SiteEditorPage /></DraftProvider> },
  ], { initialEntries: ["/sites/site_secret_recovery/settings/integration"] });
  render(<QueryClientProvider client={queryClient}><Toaster><RouterProvider router={router} /></Toaster></QueryClientProvider>);
  return {
    writes,
    secret: (purpose: Purpose) => secrets[purpose],
    revision: () => site.revision,
    rotateRemote: rotate,
    changeRemote(edit: (configuration: Site["configuration"]) => void) {
      const configuration = structuredClone(site.configuration);
      edit(configuration);
      site = { ...site, revision: site.revision + 1, configuration };
    },
    holdNext(action: SecretAction, purpose: Purpose) {
      let release!: () => void;
      let started = false;
      held.set(purpose + ":" + action, response => new Promise(resolve => {
        started = true;
        release = () => resolve(response);
      }));
      return { started: () => started, release: () => release() };
    },
  };
}

async function refreshSnapshot() {
  await act(async () => { await queryClient.invalidateQueries({ queryKey: editorKey }); });
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认" }));
}
function expectNoCachedSecret(secret: string) {
  expect(JSON.stringify(queryClient.getQueryCache().getAll().map(query => query.state.data))).not.toContain(secret);
}

describe("website secret display after configuration recovery", () => {
  it.each([false, true])("invalidates an obsolete key through 409 recovery and a successful save (same field: %s)", async sameField => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret("api_secret");
    await user.click(await screen.findByRole("button", { name: viewLabel("api_secret") }));
    await screen.findByDisplayValue(oldSecret);
    fireEvent.change(screen.getByLabelText("返回来源"), { target: { value: "https://draft.example.com" } });
    view.rotateRemote("api_secret");
    if (sameField) view.changeRemote(configuration => { configuration.return_origin = "https://remote.example.com"; });
    const remoteRevision = view.revision();
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await confirm(user);
    await user.click(await screen.findByRole("button", { name: "读取最新配置并核对" }));
    if (sameField) {
      await screen.findByText("同一字段存在不同修改");
      expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "保留我的修改" }));
      await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    }
    await screen.findByText("最新配置已合并，尚未保存");
    expect(screen.getByLabelText("返回来源")).toHaveValue("https://draft.example.com");
    await user.click(screen.getByRole("button", { name: "保存网站" }));
    await confirm(user);
    await screen.findByText("网站配置已保存");
    expect(view.writes.filter(write => write.method === "PUT").map(write => write.body.revision)).toEqual([0, remoteRevision]);
    expect(queryClient.getQueryData(editorKey)).toMatchObject({ site: { revision: remoteRevision + 1 } });
    expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: viewLabel("api_secret") }));
    expect(await screen.findByDisplayValue(view.secret("api_secret"))).toBeVisible();
    expectNoCachedSecret(view.secret("api_secret"));
  });

  it("hides the old key when a clean editor adopts a newer background snapshot", async () => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret("api_secret");
    await user.click(await screen.findByRole("button", { name: viewLabel("api_secret") }));
    await screen.findByDisplayValue(oldSecret);
    view.rotateRemote("api_secret");
    await refreshSnapshot();
    await waitFor(() => expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "读取最新配置并核对" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: viewLabel("api_secret") }));
    expect(await screen.findByDisplayValue(view.secret("api_secret"))).toBeVisible();
  });

  it("invalidates displayed keys while keeping a dirty draft and permits an explicit current-key read", async () => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret("api_secret");
    await user.click(await screen.findByRole("button", { name: viewLabel("api_secret") }));
    await screen.findByDisplayValue(oldSecret);
    fireEvent.change(screen.getByLabelText("返回来源"), { target: { value: "https://draft.example.com" } });
    view.rotateRemote("api_secret");
    await refreshSnapshot();
    await screen.findByRole("button", { name: "读取最新配置并核对" });
    expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument();
    expect(screen.getByLabelText("返回来源")).toHaveValue("https://draft.example.com");
    await user.click(screen.getByRole("button", { name: viewLabel("api_secret") }));
    const current = await screen.findByDisplayValue(view.secret("api_secret"));
    await user.click(screen.getByRole("button", { name: "读取最新配置并核对" }));
    await screen.findByText("最新配置已合并，尚未保存");
    expect(current).toBeVisible();
    expect(screen.getByLabelText("返回来源")).toHaveValue("https://draft.example.com");
  });

  it.each(["api_secret", "webhook_secret"] as const)("does not reveal a late %s read after a newer snapshot arrives", async purpose => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret(purpose);
    const pending = view.holdNext("view", purpose);
    await user.click(await screen.findByRole("button", { name: viewLabel(purpose) }));
    await waitFor(() => expect(pending.started()).toBe(true));
    view.rotateRemote(purpose);
    await refreshSnapshot();
    await act(async () => { pending.release(); });
    await waitFor(() => expect(screen.getByRole("button", { name: viewLabel(purpose) })).toBeEnabled());
    expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: viewLabel(purpose) }));
    expect(await screen.findByDisplayValue(view.secret(purpose))).toBeVisible();
    expectNoCachedSecret(oldSecret);
    expectNoCachedSecret(view.secret(purpose));
  });

  it.each(["api_secret", "webhook_secret"] as const)("preserves newer state without revealing the old result of a late %s rotation", async purpose => {
    const view = mount(), user = userEvent.setup();
    fireEvent.change(await screen.findByLabelText("返回来源"), { target: { value: "https://draft.example.com" } });
    const pending = view.holdNext("rotate", purpose);
    await user.click(screen.getByRole("button", { name: rotateLabel(purpose) }));
    await confirm(user);
    await waitFor(() => expect(pending.started()).toBe(true));
    const retiredResult = view.secret(purpose);
    view.rotateRemote(purpose);
    await refreshSnapshot();
    await act(async () => { pending.release(); });
    await waitFor(() => expect(screen.getByRole("button", { name: viewLabel(purpose) })).toBeEnabled());
    expect(screen.queryByDisplayValue(retiredResult)).not.toBeInTheDocument();
    expect(queryClient.getQueryData(editorKey)).toMatchObject({ site: { revision: 2 } });
    expect(view.writes.filter(write => write.path.endsWith("/actions/rotate"))).toHaveLength(1);
    expect(screen.getByLabelText("返回来源")).toHaveValue("https://draft.example.com");
    await user.click(screen.getByRole("button", { name: viewLabel(purpose) }));
    expect(await screen.findByDisplayValue(view.secret(purpose))).toBeVisible();
    expectNoCachedSecret(retiredResult);
    expectNoCachedSecret(view.secret(purpose));
  });

  it.each(["api_secret", "webhook_secret"] as const)("shows a still-current %s rotation result after its own revision was already observed", async purpose => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret(purpose);
    await user.click(await screen.findByRole("button", { name: viewLabel(purpose) }));
    await screen.findByDisplayValue(oldSecret);
    const pending = view.holdNext("rotate", purpose);
    await user.click(screen.getByRole("button", { name: rotateLabel(purpose) }));
    await confirm(user);
    await waitFor(() => expect(pending.started()).toBe(true));
    // The GET sees this operation's committed revision before its POST response arrives.
    await refreshSnapshot();
    await waitFor(() => expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument());
    await act(async () => { pending.release(); });
    await waitFor(() => expect(screen.getByRole("button", { name: rotateLabel(purpose) })).toBeEnabled());
    expect(screen.getByDisplayValue(view.secret(purpose))).toBeVisible();
    expect(queryClient.getQueryData(editorKey)).toMatchObject({ site: { revision: 1 } });
    expectNoCachedSecret(view.secret(purpose));
  });

  it("keeps an explicitly hidden rotation result hidden after its revision is observed", async () => {
    const view = mount(), user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: viewLabel("api_secret") }));
    await screen.findByDisplayValue(view.secret("api_secret"));
    const pending = view.holdNext("rotate", "api_secret");
    await user.click(screen.getByRole("button", { name: rotateLabel("api_secret") }));
    await confirm(user);
    await waitFor(() => expect(pending.started()).toBe(true));
    await user.click(screen.getByRole("button", { name: "隐藏密钥" }));
    await refreshSnapshot();
    await act(async () => { pending.release(); });
    await waitFor(() => expect(screen.getByRole("button", { name: rotateLabel("api_secret") })).toBeEnabled());
    expect(screen.queryByDisplayValue(view.secret("api_secret"))).not.toBeInTheDocument();
    expect(queryClient.getQueryData(editorKey)).toMatchObject({ site: { revision: 1 } });
    expect(view.writes.filter(write => write.path.endsWith("/actions/rotate"))).toHaveLength(1);
  });

  it.each(["api_secret", "webhook_secret"] as const)("keeps the fresh %s returned by this explicit rotation visible", async purpose => {
    const view = mount(), user = userEvent.setup(), oldSecret = view.secret(purpose);
    await user.click(await screen.findByRole("button", { name: viewLabel(purpose) }));
    await screen.findByDisplayValue(oldSecret);
    await user.click(screen.getByRole("button", { name: rotateLabel(purpose) }));
    await confirm(user);
    await waitFor(() => expect(queryClient.getQueryData(editorKey)).toMatchObject({ site: { revision: 1 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: rotateLabel(purpose) })).toBeEnabled());
    expect(screen.getByDisplayValue(view.secret(purpose))).toBeVisible();
    expect(screen.queryByDisplayValue(oldSecret)).not.toBeInTheDocument();
    expectNoCachedSecret(view.secret(purpose));
  });
});
