import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient, type AdminWorkItem } from "../src/api/client";
import WorkItems from "../src/pages/WorkItems";
import { apiError, json } from "./fixtures";

const scopes = [["ALL", "全部事项"], ["FINANCIAL_EXCEPTION", "账务异常"], ["LEDGER_CONFLICT", "账本冲突"], ["NOTIFICATION_FAILURE", "通知失败"]] as const;
const item: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION", status: "OPEN", exception_type: "UNMATCHED_CREDIT", candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001", provider_account_key: "primary",
  order_id: null, ledger_entry_id: null, created_at: "2026-09-06T12:00:00Z", actionable_at: "2026-09-06T12:00:00Z",
  ignored_at: null, ignored_by: null, ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};
function Location() { return <output aria-label="当前地址">{useLocation().search}</output>; }
function renderPage(search = "") {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/work-items" + search]}><WorkItems /><Location /></MemoryRouter></QueryClientProvider>);
}
const page = (items: AdminWorkItem[] = [item]) => json({ data: items, page: { next_cursor: "next-page" } });

describe("reminder dismissal", () => {
  it.each(scopes)("dismisses all pages only within %s and refreshes home and every scope", async (type, name) => {
    const requests: Request[] = [];
    for (const [scope] of scopes) queryClient.setQueryData(["work-items", scope, "ACTIVE", "unvisited"], { data: [] });
    queryClient.setQueryData(["work-items", "recent"], { data: [item] });
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      if (request.method === "POST") {
        const body = await request.json();
        return json({ data: { ...body, ignored_count: 35 } });
      }
      return page();
    }));
    const user = userEvent.setup();
    renderPage("?type=" + type + "&cursor=later-page&page=3");
    await waitFor(() => expect(screen.getByRole("button", { name: "全部忽略" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "全部忽略" }));
    const dialog = screen.getByRole("dialog", { name: "全部忽略 · " + name });
    expect(dialog).toHaveAccessibleDescription(/所有分页.*仅关闭提醒.*不停止通知重试/);
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认全部忽略" }));
    expect(await screen.findByText("已忽略“" + name + "”中的 35 条提醒。")).toBeVisible();
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0]!.url).pathname).toBe("/api/admin/v1/work-items/actions/ignore-all");
    expect(await writes[0]!.json()).toEqual({ type, operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(screen.getByLabelText("当前地址")).toHaveTextContent("?type=" + type);
    await waitFor(() => {
      expect(screen.getByLabelText("当前地址")).not.toHaveTextContent("cursor");
      expect(screen.getByLabelText("当前地址")).not.toHaveTextContent("page");
    });
    await waitFor(() => expect(queryClient.getQueryState(["work-items", "recent"])?.isInvalidated).toBe(true));
    for (const [scope] of scopes) expect(queryClient.getQueryState(["work-items", scope, "ACTIVE", "unvisited"])?.isInvalidated).toBe(true);
  });

  it("retains a batch UUID after a lost response and captures the confirmed scope", async () => {
    const writes: Array<Record<string, string>> = [];
    let finish: (response: Response) => void = () => { throw new Error("request not started"); };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (request.method === "GET") return page();
      const body = await request.json(); writes.push(body);
      if (writes.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return json({ data: { ...body, ignored_count: 35 } });
    }));
    const user = userEvent.setup(); renderPage("?type=LEDGER_CONFLICT");
    await waitFor(() => expect(screen.getByRole("button", { name: "全部忽略" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "全部忽略" }));
    await user.click(screen.getByRole("button", { name: "确认全部忽略" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(screen.getByRole("button", { name: "确认全部忽略" })).toBeDisabled();
    for (const [, name] of scopes) expect(screen.getByRole("button", { name })).toBeDisabled();
    finish(apiError("internal_error", "response lost", 500));
    await screen.findByText(/服务处理失败/);
    await user.click(screen.getByRole("button", { name: "确认全部忽略" }));
    await screen.findByText("已忽略“账本冲突”中的 35 条提醒。");
    expect(writes[1]).toEqual(writes[0]);
    await user.click(screen.getByRole("button", { name: "通知失败" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "全部忽略" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "全部忽略" }));
    await user.click(screen.getByRole("button", { name: "确认全部忽略" }));
    await screen.findByText("已忽略“通知失败”中的 35 条提醒。");
    expect(writes[2]!.type).toBe("NOTIFICATION_FAILURE");
    expect(writes[2]!.operation_id).not.toBe(writes[0]!.operation_id);
  });

  it("lists ignored and ended records, preserves the filter and restores only one live reminder", async () => {
    const requests: Request[] = [];
    const ignored = { ...item, ignored_at: "2026-09-07T12:00:00Z", ignored_by: "admin" };
    const ended = { ...ignored, resource_id: "00000000-0000-4000-8000-000000000002", status: "RESOLVED" as const, ended: true };
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      if (request.method === "POST") return json({ data: { operation_id: (await request.json()).operation_id, type: item.type, resource_id: item.resource_id, restored: true } });
      return page(new URL(request.url).searchParams.get("visibility") === "IGNORED" ? [ignored, ended] : [item]);
    }));
    const user = userEvent.setup(); renderPage("?type=FINANCIAL_EXCEPTION");
    await screen.findByRole("heading", { name: "收入尚未匹配订单" });
    await user.click(screen.getByRole("button", { name: "已忽略" }));
    expect(await screen.findByRole("button", { name: "已结束" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "全部忽略" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link").some((link) => link.getAttribute("href") === "/reconciliation/exceptions/" + item.resource_id)).toBe(true);
    await user.click(screen.getByRole("button", { name: "恢复提醒" }));
    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toHaveLength(1));
    const write = requests.find((request) => request.method === "POST")!;
    expect(new URL(write.url).pathname).toBe("/api/admin/v1/work-items/FINANCIAL_EXCEPTION/" + item.resource_id + "/actions/restore");
    expect(await write.json()).toEqual({ operation_id: expect.any(String) });
    await user.click(screen.getByRole("button", { name: "账本冲突" }));
    await waitFor(() => expect(requests.some((request) => new URL(request.url).searchParams.get("type") === "LEDGER_CONFLICT" && new URL(request.url).searchParams.get("visibility") === "IGNORED")).toBe(true));
    expect(screen.getByRole("button", { name: "未忽略" })).toBeVisible();
  });
});
