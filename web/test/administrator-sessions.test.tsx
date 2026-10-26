import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { queryClient, sessionKey, type AdminLoginSession } from "../src/api/client";
import { administratorSessionsKey } from "../src/components/administrator-sessions";
import { apiError, json } from "./fixtures";
import { mountOnboarding } from "./onboarding-fixture";

const currentId = "11111111-1111-4111-8111-111111111111";
const mobileId = "22222222-2222-4222-8222-222222222222";
const legacyId = "33333333-3333-4333-8333-333333333333";
const ipv6 = "2409:8924:405f:40ff:18e0:adf0:f68c:a954";
const rows: AdminLoginSession[] = [
  { session_id: legacyId, is_current: false, user_agent: null, ip_address: null, auth_method: "password", last_seen_at: "2026-10-22T12:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
  { session_id: mobileId, is_current: false, user_agent: "Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36", ip_address: ipv6, auth_method: "password", last_seen_at: "2026-10-24T12:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
  { session_id: currentId, is_current: true, user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36", ip_address: "192.0.2.25", auth_method: "password", last_seen_at: "2026-10-20T12:00:00Z", expires_at: "2099-01-01T00:00:00Z" },
];

function mount(options: { failReads?: boolean; failMutation?: boolean } = {}) {
  const state = { rows: structuredClone(rows), reads: 0, authenticated: true, failReads: options.failReads ?? false, failMutation: options.failMutation ?? false };
  const view = mountOnboarding({ stage: 4, path: "/settings/security", handle: request => {
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/v1/settings/admin-access" && request.method === "GET") {
      return json({ data: { revision: 3, enabled: false, cidrs: [], current_ip: "192.0.2.25" } });
    }
    if (path === "/api/admin/v1/session" && !state.authenticated) return apiError("session_invalid", "会话失效", 401);
    if (path === "/api/admin/v1/sessions" && request.method === "GET") {
      state.reads++;
      if (!state.authenticated) return apiError("session_invalid", "会话失效", 401);
      return state.failReads ? apiError("internal_error", "会话列表暂时不可用", 503) : json({ data: state.rows });
    }
    if (request.method !== "POST") return undefined;
    if (path === "/api/admin/v1/session/logout" || path === "/api/admin/v1/sessions/revoke-all") {
      state.authenticated = false;
      return path.endsWith("/logout") ? new Response(null, { status: 204 }) : json({ data: { revoked_sessions: state.rows.length } });
    }
    if (path === "/api/admin/v1/sessions/revoke-others" || path.endsWith("/revoke")) {
      if (state.failMutation) return apiError("internal_error", "会话撤销暂时不可用", 503);
      if (path.endsWith("/revoke-others")) {
        const revoked = state.rows.filter(row => !row.is_current).length;
        state.rows = state.rows.filter(row => row.is_current);
        return json({ data: { revoked_sessions: revoked } });
      }
      const target = path.split("/").at(-2);
      state.rows = state.rows.filter(row => row.session_id !== target);
      return new Response(null, { status: 204 });
    }
    return undefined;
  } });
  return { ...view, state };
}

async function card() {
  const title = await screen.findByRole("heading", { name: "登录会话" });
  const element = title.closest<HTMLElement>("[data-login-sessions]")!;
  await within(element).findByRole("list", { name: "登录会话列表" });
  return element;
}

async function allConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "会话操作" }));
  await user.click(await screen.findByRole("menuitem", { name: "注销全部会话" }));
}

describe("administrator login sessions", () => {
  it("orders the current session first and shows full IPv6 and missing metadata", async () => {
    mount();
    const element = await card();
    const items = within(element).getAllByRole("listitem");
    expect(items.map(row => row.dataset.sessionId)).toEqual([currentId, mobileId, legacyId]);
    expect(within(items[0]!).getByText("当前")).toBeVisible();
    expect(within(items[0]!).getByRole("button", { name: "退出登录" })).toBeVisible();
    expect(items[1]).toHaveTextContent(`登录 IP：${ipv6}`);
    expect(items[1]).toHaveTextContent("Chrome · Android");
    expect(items[2]).toHaveTextContent("未知浏览器 · 未知系统");
    expect(items[2]).toHaveTextContent("登录 IP：未知");
  });

  it("cancels a targeted revocation without a write and restores its trigger focus", async () => {
    const view = mount();
    const user = userEvent.setup();
    const element = await card();
    const trigger = within(element).getByRole("button", { name: "撤销 Chrome · Android 会话" });
    await user.click(trigger);
    const dialog = await screen.findByRole("alertdialog", { name: "撤销此会话？" });
    expect(dialog).toHaveTextContent(ipv6);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(view.writes()).toHaveLength(0);
    expect(within(element).getAllByRole("listitem")).toHaveLength(3);
  });

  it("revokes an individual session and only refreshes the list while keeping a password draft", async () => {
    const view = mount();
    const user = userEvent.setup();
    const element = await card();
    const password = screen.getByLabelText("新密码");
    fireEvent.change(password, { target: { value: "unsaved-password" } });
    await user.click(within(element).getByRole("button", { name: "撤销 Chrome · Android 会话" }));
    const dialog = await screen.findByRole("alertdialog", { name: "撤销此会话？" });
    await user.click(within(dialog).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(within(element).getAllByRole("listitem")).toHaveLength(2));
    expect(screen.getByLabelText("新密码")).toBe(password);
    expect(password).toHaveValue("unsaved-password");
    expect(view.state.reads).toBeGreaterThan(1);
    const request = view.writes()[0]!;
    expect(new URL(request.url).pathname).toBe(`/api/admin/v1/sessions/${mobileId}/revoke`);
    expect(await request.clone().json()).toEqual({});
    expect(queryClient.getQueryData(sessionKey)).not.toBeNull();
  });

  it("exits other sessions while retaining current login and disables the action afterwards", async () => {
    const view = mount();
    const user = userEvent.setup();
    const element = await card();
    await user.click(within(element).getByRole("button", { name: "退出其他会话" }));
    const dialog = await screen.findByRole("alertdialog", { name: "退出其他会话？" });
    await user.click(within(dialog).getByRole("button", { name: "退出其他会话" }));
    await waitFor(() => expect(within(element).getAllByRole("listitem")).toHaveLength(1));
    expect(within(element).getByRole("button", { name: "退出其他会话" })).toBeDisabled();
    expect(within(element).getByText("当前")).toBeVisible();
    expect(queryClient.getQueryData(sessionKey)).not.toBeNull();
    expect(view.writes()).toHaveLength(1);
  });

  it("keeps security controls usable after a list failure and retries only the list", async () => {
    const view = mount({ failReads: true });
    expect(await screen.findByText("会话列表暂时不可用")).toBeVisible();
    const password = screen.getByLabelText("新密码");
    fireEvent.change(password, { target: { value: "retained-draft" } });
    view.state.failReads = false;
    const failedCard = screen.getByRole("heading", { name: "登录会话" }).closest<HTMLElement>("[data-login-sessions]")!;
    await userEvent.click(within(failedCard).getByRole("button", { name: "重试" }));
    await card();
    expect(screen.getByLabelText("新密码")).toBe(password);
    expect(password).toHaveValue("retained-draft");
    expect(view.writes()).toHaveLength(0);
  });

  it("retains the dialog and session rows after a failed revoke and permits retry", async () => {
    const view = mount({ failMutation: true });
    const user = userEvent.setup();
    const element = await card();
    await user.click(within(element).getByRole("button", { name: "撤销 Chrome · Android 会话" }));
    const dialog = await screen.findByRole("alertdialog", { name: "撤销此会话？" });
    await user.click(within(dialog).getByRole("button", { name: "撤销" }));
    expect(await within(dialog).findByText("会话撤销暂时不可用")).toBeVisible();
    expect(within(element).getAllByRole("listitem", { hidden: true })).toHaveLength(3);
    view.state.failMutation = false;
    await user.click(within(dialog).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(within(element).getAllByRole("listitem")).toHaveLength(2));
    expect(view.writes()).toHaveLength(2);
  });

  it.each(["current", "all"] as const)("preserves a draft when cancelling %s logout then clears protected caches on confirmation", async kind => {
    const view = mount();
    const user = userEvent.setup();
    const element = await card();
    const password = screen.getByLabelText("新密码");
    fireEvent.change(password, { target: { value: "keep-until-confirmed" } });
    const open = async () => kind === "current"
      ? user.click(within(element).getByRole("button", { name: "退出登录" }))
      : allConfirmation(user);
    await open();
    const draft = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(draft).getByRole("button", { name: "继续编辑" }));
    expect(password).toHaveValue("keep-until-confirmed");
    expect(view.writes()).toHaveLength(0);
    await open();
    const draftAgain = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(draftAgain).getByRole("button", { name: "放弃修改并继续" }));
    const dialog = await screen.findByRole("alertdialog", { name: kind === "current" ? "退出当前会话？" : "注销全部会话？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(password).toHaveValue("keep-until-confirmed");
    expect(view.writes()).toHaveLength(0);
    await open();
    const draftLast = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(draftLast).getByRole("button", { name: "放弃修改并继续" }));
    const confirmed = await screen.findByRole("alertdialog", { name: kind === "current" ? "退出当前会话？" : "注销全部会话？" });
    await user.click(within(confirmed).getByRole("button", { name: kind === "current" ? "退出登录" : "注销全部会话" }));
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(queryClient.getQueryData(administratorSessionsKey)).toBeUndefined();
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
  });
});
