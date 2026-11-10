import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryClient, type Site } from "../src/api/client";
import { auditActionLabel, auditFieldLabel } from "../src/lib/audit";
import { json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

type Command = { operation_id: string; revision: number; client_id: string };
const stableId = "stable_site";
const initial: Site = { secrets: { api_secret: true, webhook_secret: true }, client_id: stableId, api_client_id: "Public.Shop", revision: 2,
  configuration: { name: "业务网站", accepting_orders: true, notifications_enabled: false,
    notification_origin: null, return_origin: null,
    policy: {
      orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
      display: { checkout_name: "网站收银台", checkout_help_url: null, checkout_show_product_name: true },
      notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 5, retry_maximum_seconds: 60 },
    } }, created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z", deleted_at: null };
function rejected(code = "site_client_id_conflict", fields: Record<string, string> = { client_id: "该客户端 ID 已被使用，请换一个。" }) {
  return json({ error: { code, message: code === "site_revision_conflict" ? "网站配置已变化，请刷新。" : fields.client_id, fields } }, 409);
}
function mountSite(options: {
  path?: string;
  legacy?: boolean;
  change?: (body: Command, attempt: number) => Response | Promise<Response> | undefined;
} = {}) {
  let site = structuredClone(initial);
  if (options.legacy) delete site.api_client_id;
  const commands: Array<{ path: string; body: Command }> = [];
  const view = mountOnboarding({ stage: 4, path: options.path ?? `/sites/${stableId}/edit?section=integration`, handle: request => {
    const path = new URL(request.url).pathname;
    if (path === `/api/admin/v1/sites/${stableId}/actions/change-client-id`) return (async () => {
      const body = await request.json() as Command;
      commands.push({ path, body });
      const response = await options.change?.(body, commands.length);
      if (response) return response;
      site = { ...site, api_client_id: body.client_id, revision: site.revision + 1 };
      return json({ data: site });
    })();
    if (path === `/api/admin/v1/sites/${stableId}`) return json({ data: site });
    if (path === "/api/admin/v1/sites") return json({ data: [site], page: { next_cursor: null } });
    if (path.endsWith("/analytics")) return json({ data: { confirmations: { count: 0, amount_cents: 0 }, pending: { orders: 0 } } });
    if (path.endsWith("/work-items/summary")) return json({ data: { total: 0 } });
    return undefined;
  } });
  return { ...view, commands, remote: () => site, setRemote: (value: Site) => { site = value; } };
}
async function openChange(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "更换客户端 ID" }));
  return screen.findByRole("dialog", { name: "更换客户端 ID" });
}
async function propose(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, value: string) {
  const input = within(dialog).getByRole("textbox", { name: "新客户端 ID" });
  await user.clear(input);
  await user.type(input, value);
  await user.click(within(dialog).getByRole("button", { name: "继续核对" }));
  return screen.findByRole("alertdialog", { name: "确认更换客户端 ID？" });
}

describe("public client ID changes with stable website ownership", () => {
  it.each([`/sites/${stableId}/settings/basic`, `/sites/${stableId}/summary`, `/sites/${stableId}/edit?section=integration`])(
    "copies the public ID from %s", async path => {
      mountSite({ path });
      const user = userEvent.setup();
      const copy = await screen.findByRole("button", { name: "复制客户端 ID" });
      await user.click(copy);
      expect(await navigator.clipboard.readText()).toBe("Public.Shop");
    });

  it("uses the stable ID for legacy snapshots without a public ID", async () => {
    mountSite({ legacy: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "复制客户端 ID" }));
    expect(await navigator.clipboard.readText()).toBe(stableId);
  });

  it("requires explicit confirmation and refreshes public copies while keeping the route and cache owner", async () => {
    const view = mountSite();
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, " New.Shop ");
    expect(within(confirmation).getByText("Public.Shop", { exact: true })).toBeVisible();
    expect(within(confirmation).getByText("New.Shop", { exact: true })).toBeVisible();
    expect(confirmation).toHaveTextContent("旧 ID 将停止用于接入并继续保留占用");
    expect(view.commands).toHaveLength(0);
    await user.click(within(confirmation).getByRole("button", { name: "返回修改" }));
    expect(await within(dialog).findByRole("textbox", { name: "新客户端 ID" })).toHaveValue(" New.Shop ");
    await user.click(within(dialog).getByRole("button", { name: "继续核对" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认更换" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "更换客户端 ID" })).not.toBeInTheDocument());
    expect(view.commands).toHaveLength(1);
    expect(view.commands[0]).toEqual({ path: `/api/admin/v1/sites/${stableId}/actions/change-client-id`,
      body: { client_id: "New.Shop", revision: 2, operation_id: expect.any(String) } });
    expect(new URLSearchParams(view.router.state.location.search).get("overlay")).toBe(`/sites/${stableId}/edit?section=integration`);
    expect(queryClient.getQueryData<{ data: Site }>(["workspace-site", stableId])?.data.api_client_id).toBe("New.Shop");
    expect(queryClient.getQueryData<{ site: Site }>(["site-editor", stableId])?.site.api_client_id).toBe("New.Shop");
    await user.click(screen.getByRole("button", { name: "复制客户端 ID" }));
    expect(await navigator.clipboard.readText()).toBe("New.Shop");
    expect(view.writes().every(request => request.method === "POST")).toBe(true);
  });

  it("keeps configuration drafts and requires saving them before changing the ID", async () => {
    const view = mountSite();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "基本信息" }));
    const name = screen.getByRole("textbox", { name: "业务网站名称" });
    await user.clear(name);
    await user.type(name, "尚未保存的网站名称");
    await user.click(screen.getByRole("tab", { name: "接入与通知" }));
    expect(screen.getByRole("button", { name: "更换客户端 ID" })).toBeDisabled();
    expect(screen.getByText("请先保存或撤销当前配置修改，再更换客户端 ID。")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "基本信息" }));
    expect(screen.getByRole("textbox", { name: "业务网站名称" })).toHaveValue("尚未保存的网站名称");
    expect(view.writes()).toHaveLength(0);
  });

  it("allows correcting an occupied ID with a new command and a single field error", async () => {
    const view = mountSite({ change: (_body, attempt) => attempt === 1 ? rejected() : undefined });
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, "taken");
    await user.click(within(confirmation).getByRole("button", { name: "确认更换" }));
    const input = await within(dialog).findByRole("textbox", { name: "新客户端 ID" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getAllByText("该客户端 ID 已被使用，请换一个。", { exact: true })).toHaveLength(1);
    expect(input).toBeEnabled();
    const retry = await propose(user, dialog, "available");
    await user.click(within(retry).getByRole("button", { name: "确认更换" }));
    await waitFor(() => expect(view.remote().api_client_id).toBe("available"));
    expect(view.commands[1]!.body.operation_id).not.toBe(view.commands[0]!.body.operation_id);
    expect(view.commands[1]!.body.revision).toBe(2);
  });

  it.each(["Requested.Shop", "Later.Shop"])("replays a lost response unchanged and shows the returned current ID %s", async currentId => {
    const view = mountSite({ change: (body, attempt) => {
      if (attempt === 1) {
        view.setRemote({ ...view.remote(), api_client_id: body.client_id, revision: 3 });
        throw new TypeError("lost response");
      }
      view.setRemote({ ...view.remote(), api_client_id: currentId, revision: 4 });
      return json({ data: view.remote() });
    } });
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, "Requested.Shop");
    await user.click(within(confirmation).getByRole("button", { name: "确认更换" }));
    await screen.findByText("更换结果待确认");
    const input = await within(dialog).findByRole("textbox", { name: "新客户端 ID" });
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { value: "other" } });
    expect(input).toHaveValue("Requested.Shop");
    await user.click(await within(dialog).findByRole("button", { name: "重试上一次操作" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "更换客户端 ID" })).not.toBeInTheDocument());
    expect(view.commands[1]).toEqual(view.commands[0]);
    await user.click(screen.getByRole("button", { name: "复制客户端 ID" }));
    expect(await navigator.clipboard.readText()).toBe(currentId);
  });

  it("retains the original request after a lost response followed by a conflict", async () => {
    const view = mountSite({ change: (_body, attempt) => { if (attempt === 1) throw new TypeError("lost response"); return rejected(); } });
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, "Frozen.Shop");
    await user.click(within(confirmation).getByRole("button", { name: "确认更换" }));
    await screen.findByText("更换结果待确认");
    await user.click(await within(dialog).findByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("服务返回冲突，请关闭并刷新，核对原操作是否生效。");
    expect(within(dialog).getByRole("textbox", { name: "新客户端 ID" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "重试上一次操作" })).toBeDisabled();
    expect(view.commands[1]).toEqual(view.commands[0]);
  });

  it("preserves an unsubmitted ID when closing is cancelled", async () => {
    const view = mountSite();
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const input = within(dialog).getByRole("textbox", { name: "新客户端 ID" });
    await user.clear(input); await user.type(input, "Draft.Shop");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(guard).getByRole("button", { name: "继续编辑" }));
    expect(input).toHaveValue("Draft.Shop");
    expect(view.writes()).toHaveLength(0);
  });

  it("focuses malformed replacement input before opening confirmation or writing", async () => {
    const view = mountSite();
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const input = within(dialog).getByRole("textbox", { name: "新客户端 ID" });
    await user.clear(input); await user.type(input, "invalid/id");
    await user.click(within(dialog).getByRole("button", { name: "继续核对" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps the pending replacement open until its server response is confirmed", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const view = mountSite({ change: () => pending });
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, "Pending.Shop");
    await user.click(within(confirmation).getByRole("button", { name: "确认更换" }));
    await within(dialog).findByRole("button", { name: "正在更换…" });
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("dialog", { name: "更换客户端 ID" })).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "新客户端 ID" })).toBeDisabled();
    expect(view.commands).toHaveLength(1);
    await act(async () => { release(json({ data: { ...view.remote(), api_client_id: "Pending.Shop", revision: 3 } })); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "更换客户端 ID" })).not.toBeInTheDocument());
    expect(queryClient.getQueryData<{ site: Site }>(["site-editor", stableId])?.site.api_client_id).toBe("Pending.Shop");
  });

  it("reloads the stable site after a revision conflict before starting a newly confirmed command", async () => {
    const view = mountSite({ change: (_body, attempt) => {
      if (attempt > 1) return undefined;
      view.setRemote({ ...view.remote(), revision: 3, api_client_id: "Remote.Shop" });
      return rejected("site_revision_conflict", {});
    } });
    const user = userEvent.setup();
    const dialog = await openChange(user);
    const confirmation = await propose(user, dialog, "Desired.Shop");
    await user.click(within(confirmation).getByRole("button", { name: "确认更换" }));
    const close = await within(dialog).findByRole("button", { name: "关闭并刷新" });
    expect(within(dialog).getByRole("textbox", { name: "新客户端 ID" })).toBeDisabled();
    await user.click(close);
    await waitFor(() => expect(queryClient.getQueryData<{ site: Site }>(["site-editor", stableId])?.site.api_client_id).toBe("Remote.Shop"));
    await user.click(await screen.findByRole("button", { name: "复制客户端 ID" }));
    expect(await navigator.clipboard.readText()).toBe("Remote.Shop");
    const reopened = await openChange(user);
    const nextConfirmation = await propose(user, reopened, "Desired.Shop");
    await user.click(within(nextConfirmation).getByRole("button", { name: "确认更换" }));
    await waitFor(() => expect(view.remote().api_client_id).toBe("Desired.Shop"));
    expect(view.commands[0]!.body.revision).toBe(2);
    expect(view.commands[1]!.body.revision).toBe(3);
    expect(view.commands[1]!.body.operation_id).not.toBe(view.commands[0]!.body.operation_id);
    expect(view.commands.every(command => command.path === `/api/admin/v1/sites/${stableId}/actions/change-client-id`)).toBe(true);
  });

  it("labels the public change in the audit UI", () => {
    expect(auditActionLabel("site.client_id_changed")).toBe("更换客户端 ID");
    expect(auditFieldLabel("api_client_id")).toBe("客户端 ID");
  });
});
