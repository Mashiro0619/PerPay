import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type AdminWorkItem } from "../src/api/client";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";
import { json } from "./fixtures";

let online = true;
beforeEach(() => {
  online = true;
  onlineManager.setOnline(true);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});
afterEach(() => { onlineManager.setOnline(true); });
async function network(value: boolean) {
  await act(async () => {
    online = value;
    window.dispatchEvent(new Event(value ? "online" : "offline"));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}
async function editName() {
  const input = await screen.findByRole("textbox", { name: "支付系统名称" });
  fireEvent.change(input, { target: { value: "明确保存的设置" } });
  return input;
}
async function leave(view: ReturnType<typeof mountOnboarding>) {
  await act(async () => { await view.router.navigate("/orders"); });
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "放弃修改并继续" }));
  await waitFor(() => expect(view.router.state.location.pathname).toBe("/orders"));
}

describe("settings saves never wait in an offline queue", () => {
  it("does not send an abandoned save after route navigation and reconnection", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/display" });
    const input = await editName();
    await network(false);
    fireEvent.submit(input.closest("form")!);
    await act(async () => { await Promise.resolve(); });
    await leave(view);
    await network(true);
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps the draft editable after offline rejection and requires an explicit online save", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/display" });
    const input = await editName();
    await network(false);
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText(/网络已断开，设置未提交/)).toBeVisible();
    expect(input).toBeEnabled();
    expect(input).toHaveValue("明确保存的设置");
    await network(true);
    expect(view.writes()).toHaveLength(0);
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(view.writes()).toHaveLength(1));
    await screen.findByText("已保存");
  });

  it("rejects before dispatch when navigator is offline before QueryCore observes an event", async () => {
    const view = mountOnboarding({ stage: 4, path: "/settings/display" });
    const input = await editName();
    online = false;
    expect(onlineManager.isOnline()).toBe(true);
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText(/网络已断开，设置未提交/)).toBeVisible();
    expect(view.writes()).toHaveLength(0);
  });

  it("does not promise cancellation of a dispatched save and refreshes settings after unmount", async () => {
    let saved = configuredThrough(4);
    let finish!: () => void;
    let writes = 0;
    const view = mountOnboarding({ stage: 4, path: "/settings/display", handle: request => {
      const path = new URL(request.url).pathname;
      if (path === "/api/admin/v1/settings") return json({ data: saved });
      if (path.endsWith("/settings/display") && request.method === "PUT") {
        writes++;
        return request.json().then(body => new Promise<Response>(resolve => {
          finish = () => { saved = { ...saved, revision: saved.revision + 1, display: { ...saved.display, system_name: body.system_name } }; resolve(json({ data: saved })); };
        }));
      }
      return undefined;
    } });
    const input = await editName();
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(writes).toBe(1));
    await act(async () => { await view.router.navigate("/orders"); });
    const dialog = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(within(dialog).queryByText("此页面的修改不会保存。")).not.toBeInTheDocument();
    expect(within(dialog).getByText("已提交的保存可能仍在执行，请重新读取后核对结果。")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/orders"));
    await act(async () => { finish(); });
    await waitFor(() => expect(queryClient.getMutationCache().getAll().some(m => m.state.status === "pending")).toBe(false));
    await act(async () => { await view.router.navigate("/settings/display"); });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "支付系统名称" })).toHaveValue("明确保存的设置"));
  });
});

const item: AdminWorkItem = {
  type: "FINANCIAL_EXCEPTION", status: "OPEN", exception_type: "UNMATCHED_CREDIT", candidate_id: null,
  resource_id: "00000000-0000-4000-8000-000000000001", provider_account_key: "primary", order_id: null, ledger_entry_id: null,
  created_at: "2026-10-08T00:00:00Z", actionable_at: "2026-10-08T00:00:00Z", ignored_at: null, ignored_by: null, ended: false,
  detail_url: "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000001",
};
it("never queues bulk ignore offline and preserves its operation ID across explicit retries", async () => {
  const bodies: Array<{ operation_id: string }> = [];
  mountOnboarding({ stage: 4, path: "/work-items", handle: request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/work-items")) return json({ data: [item], page: { next_cursor: null } });
    if (path.endsWith("/ignore-all")) return request.json().then(body => {
      bodies.push(body);
      return bodies.length === 1 ? json({ error: { code: "unavailable", message: "响应暂不可用" } }, 503) : json({ data: { ...body, ignored_count: 1 } });
    });
    return undefined;
  } });
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "忽略全部筛选结果（跨页）" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  const submit = within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认忽略" });
  await network(false);
  await user.click(submit);
  expect(await screen.findByText(/网络已断开，忽略操作未提交/)).toBeVisible();
  expect(submit).toBeEnabled();
  await network(true);
  expect(bodies).toHaveLength(0);
  await user.click(submit);
  await waitFor(() => expect(bodies).toHaveLength(1));
  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]?.operation_id).toBe(bodies[0]?.operation_id);
});
