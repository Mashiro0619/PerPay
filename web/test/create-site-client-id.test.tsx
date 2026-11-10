import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, type Site, type SiteConfiguration, type SitePolicy } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import CreateSite from "../src/pages/CreateSite";
import { alipayAccount, json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const policy: SitePolicy = {
  orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
  display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
  notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 5, retry_maximum_seconds: 60 },
};
type CreateCommand = { operation_id: string; client_id?: string; configuration: SiteConfiguration };
const conflictMessage = "该客户端 ID 已被使用，请换一个。";
function clientIdRejected(status = 409, code = "site_client_id_conflict", message = conflictMessage) {
  return json({ error: { code, message, fields: { client_id: message } } }, status);
}
function mountCreate(reject?: (input: CreateCommand, attempt: number) => Response | undefined) {
  const writes: CreateCommand[] = [];
  const created = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/settings/site-defaults") return json({ data: { revision: 2, policy } });
    if (path === "/api/admin/v1/alipay-accounts") return json({ data: [alipayAccount] });
    if (path === "/api/admin/v1/sites" && request.method === "POST") {
      const input = await request.json() as CreateCommand;
      writes.push(input);
      const response = reject?.(input, writes.length);
      if (response) return response;
      const site: Site = { secrets: { api_secret: false, webhook_secret: false }, client_id: input.client_id ?? "site_generated", revision: 0, configuration: input.configuration,
        created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z", deleted_at: null };
      return json({ data: site }, 201);
    }
    throw new Error("Unexpected fixture request " + request.method + " " + path);
  }));
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/sites/new", element: <CreateSite onCreated={created} /> },
    { path: "/sites", element: <h1>网站列表</h1> },
  ] }], { initialEntries: ["/sites/new"] });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { writes, created, router };
}
async function fillName(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole("textbox", { name: "业务网站名称" }), "我的网站");
  return screen.getByRole("textbox", { name: "客户端 ID（可选）" });
}

describe("optional website client ID", () => {
  it.each([" Shop_2.- ", "a".repeat(64)])("submits the trimmed ID and preserves its case: %s", async value => {
    const view = mountCreate();
    const user = userEvent.setup();
    const input = await fillName(user);
    expect(screen.getByPlaceholderText("shop")).toBe(input);
    expect(input).toHaveAccessibleDescription(expect.stringContaining("留空自动生成"));
    expect(input).toHaveAccessibleDescription(expect.stringContaining("区分大小写"));
    await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.created).toHaveBeenCalledWith(value.trim()));
    expect(view.writes).toHaveLength(1);
    expect(view.writes[0]).toMatchObject({ client_id: value.trim(), operation_id: expect.any(String), configuration: { name: "我的网站", policy } });
  });

  it.each(["", "   "])("omits an empty optional ID: %j", async value => {
    const view = mountCreate();
    const user = userEvent.setup();
    const input = await fillName(user);
    if (value) await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.created).toHaveBeenCalledWith("site_generated"));
    expect(view.writes[0]).not.toHaveProperty("client_id");
  });

  it.each(["ab", "_shop", "shop/other", "网店", "shop code", "a".repeat(65)])("focuses an invalid ID without creating: %s", async value => {
    const view = mountCreate();
    const user = userEvent.setup();
    const input = await fillName(user);
    fireEvent.change(input, { target: { value } });
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription(expect.stringContaining("请填写 3–64 位客户端 ID"));
    expect(view.writes).toHaveLength(0);
  });

  it("allows correcting an occupied ID and creates a fresh operation for the changed ID", async () => {
    const view = mountCreate((_input, attempt) => attempt === 1 ? clientIdRejected() : undefined);
    const user = userEvent.setup();
    const input = await fillName(user);
    await user.type(input, "taken");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(input).toHaveAccessibleDescription(expect.stringContaining(conflictMessage)));
    expect(screen.getAllByText(conflictMessage, { exact: true })).toHaveLength(1);
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    expect(screen.queryByText("创建结果待确认")).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "available");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.created).toHaveBeenCalledWith("available"));
    expect(view.writes[0]!.configuration).toEqual(view.writes[1]!.configuration);
    expect(view.writes.map(command => command.client_id)).toEqual(["taken", "available"]);
    expect(view.writes[1]!.operation_id).not.toBe(view.writes[0]!.operation_id);
  });

  it("keeps normalized payloads on the same operation after a definite field rejection", async () => {
    const view = mountCreate((_input, attempt) => attempt === 1
      ? clientIdRejected(422, "settings_validation_failed", "此客户端 ID 已保留，请换一个。") : undefined);
    const user = userEvent.setup();
    const input = await fillName(user);
    await user.type(input, " shop ");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getAllByText("此客户端 ID 已保留，请换一个。", { exact: true })).toHaveLength(1);
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "shop");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await waitFor(() => expect(view.created).toHaveBeenCalledWith("shop"));
    expect(view.writes[1]).toEqual(view.writes[0]);
  });

  it("retries the identical ID, template and operation after a lost creation response", async () => {
    const view = mountCreate((_input, attempt) => { if (attempt === 1) throw new TypeError("lost response"); });
    const user = userEvent.setup();
    const input = await fillName(user);
    await user.type(input, " Shop ");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await screen.findByText("创建结果待确认");
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "changed" } });
    expect(input).toHaveValue(" Shop ");
    await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
    await waitFor(() => expect(view.created).toHaveBeenCalledWith("Shop"));
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1]).toEqual(view.writes[0]);
  });

  it("retains the unresolved original request when retry receives an ID conflict", async () => {
    const view = mountCreate((_input, attempt) => {
      if (attempt === 1) throw new TypeError("lost response");
      return clientIdRejected();
    });
    const user = userEvent.setup();
    const input = await fillName(user);
    await user.type(input, "original");
    await user.click(screen.getByRole("button", { name: "创建业务网站" }));
    await screen.findByText("创建结果待确认");
    await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("服务返回冲突，请关闭并刷新，核对原操作是否生效。");
    expect(input).toBeDisabled();
    expect(input).toHaveValue("original");
    expect(screen.getByRole("button", { name: "重试上一次操作" })).toBeDisabled();
    expect(view.writes[1]).toEqual(view.writes[0]);
    expect(view.created).not.toHaveBeenCalled();
  });

  it("guards closing an overlay whose only draft change is the optional ID", async () => {
    const view = mountOnboarding({ stage: 4, path: "/sites/new", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/settings/site-defaults") return json({ data: { revision: 0, policy } });
      if (path === "/api/admin/v1/alipay-accounts") return json({ data: [alipayAccount] });
      return undefined;
    } });
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox", { name: "客户端 ID（可选）" });
    await user.type(input, "draft-shop");
    await user.click(within(screen.getByRole("dialog", { name: "添加业务网站" })).getByRole("button", { name: "取消" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    expect(input).toHaveValue("draft-shop");
    await user.click(screen.getByRole("button", { name: "关闭对话框" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(new URLSearchParams(view.router.state.location.search).has("overlay")).toBe(false));
    expect(view.writes()).toHaveLength(0);
  });
});
