import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { expect, it, vi } from "vitest";
import { queryClient, type AlipayAccount, type AlipayAccountInput } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { AlipayAccountEditor } from "../src/pages/AlipayAccounts";
import { alipayAccount, json } from "./fixtures";

type CreateInput = AlipayAccountInput & { operation_id: string };
function fixture(reply: (request: Request, input: CreateInput, attempt: number, commit: () => AlipayAccount) => Response | Promise<Response>) {
  const requests: CreateInput[] = [];
  const accounts = new Map<string, AlipayAccount>();
  const saved = vi.fn(), back = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (request.method !== "POST") return json({ data: [...accounts.values()] });
    const input = await request.json() as CreateInput;
    requests.push(input);
    const commit = () => {
      const id = "alipay_" + input.operation_id;
      if (!accounts.has(id)) accounts.set(id, { ...alipayAccount, id, revision: 0, name: input.name,
        app_id: input.app_id ?? null, code_payload: input.code_payload ?? null, configured: false,
        platform_public_key: null, provider_account_key: null, application_public_key: null, application_key_fingerprint: null,
        pending_application_key: null, sites: [], last_check: null });
      return accounts.get(id)!;
    };
    return reply(request, input, requests.length, commit);
  }));
  const router = createMemoryRouter([{ element: <DraftProvider><Outlet /></DraftProvider>, children: [
    { path: "/settings/accounts/new", element: <AlipayAccountEditor initial={null} onSaved={saved} onBack={back} /> },
    { path: "/settings/accounts", element: <h1>账号列表</h1> },
  ] }], { initialEntries: ["/settings/accounts/new"] });
  const view = render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return { ...view, requests, accounts, saved, back, router };
}
async function create(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("账号名称"), "待创建的账号");
  await user.click(screen.getByRole("button", { name: "创建账号并继续" }));
}

it("replays the committed creation after a lost response and accepts its current account state", async () => {
  const f = fixture((_request, _input, attempt, commit) => {
    const account = commit();
    if (attempt === 1) throw new TypeError("response lost after commit");
    return json({ data: account }, 201);
  });
  const user = userEvent.setup();
  await create(user);
  await screen.findByText("创建结果待确认");
  expect(screen.getByLabelText("账号名称")).toBeDisabled();
  expect(f.accounts.size).toBe(1);
  expect(f.saved).not.toHaveBeenCalled();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const account = [...f.accounts.values()][0]!;
  f.accounts.set(account.id, { ...account, name: "其他会话已更新名称", revision: 3 });
  await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
  await screen.findByText("账号已保存");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual(f.requests[0]);
  expect(f.accounts.size).toBe(1);
  expect(f.saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: account.id, revision: 3, name: "其他会话已更新名称" }));
  await user.click(screen.getByRole("tab", { name: "基本信息" }));
  expect(screen.getByLabelText("账号名称")).toHaveValue("其他会话已更新名称");
  expect(screen.getByLabelText("账号名称")).toBeEnabled();
});

it.each(["incomplete", "wrong-account", "invalid-json"])("keeps a %s 2xx creation response recoverable", async kind => {
  const f = fixture((_request, _input, attempt, commit) => {
    const account = commit();
    if (attempt > 1) return json({ data: account }, 201);
    if (kind === "invalid-json") return new Response("{", { status: 201, headers: { "content-type": "application/json" } });
    return json({ data: kind === "incomplete" ? { id: account.id } : { ...account, id: "alipay_wrong-account" } }, 201);
  });
  const user = userEvent.setup();
  await create(user);
  await screen.findByText("创建结果待确认");
  expect(f.saved).not.toHaveBeenCalled();
  expect(screen.getByLabelText("账号名称")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
  await screen.findByText("账号已保存");
  expect(f.requests[1]).toEqual(f.requests[0]);
  expect(f.accounts.size).toBe(1);
  expect(f.saved).toHaveBeenCalledOnce();
});

it("allows correcting an explicit validation rejection and issues a new operation identity", async () => {
  const f = fixture((_request, _input, attempt, commit) => attempt === 1
    ? json({ error: { code: "settings_validation_failed", message: "请修正账号名称", fields: { name: "请换一个名称" } } }, 422)
    : json({ data: commit() }, 201));
  const user = userEvent.setup();
  await create(user);
  await screen.findByText("请换一个名称");
  const name = screen.getByLabelText("账号名称");
  expect(name).toBeEnabled();
  expect(screen.queryByText("创建结果待确认")).not.toBeInTheDocument();
  await user.clear(name);
  await user.type(name, "修正后的账号");
  await user.click(screen.getByRole("button", { name: "创建账号并继续" }));
  await screen.findByText("账号已保存");
  expect(f.requests[1]!.operation_id).not.toBe(f.requests[0]!.operation_id);
  expect(f.requests[1]!.name).toBe("修正后的账号");
  expect(f.accounts.size).toBe(1);
});

it.each([422, 409])("retains an earlier unknown creation when its retry receives %s", async status => {
  const f = fixture((_request, _input, attempt, commit) => {
    if (attempt === 1) { commit(); throw new TypeError("lost response"); }
    if (attempt === 2) return json({ error: { code: status === 422 ? "validation_failed" : "alipay_account_creation_conflict", message: "retry rejected" } }, status);
    return json({ data: commit() }, 201);
  });
  const user = userEvent.setup();
  await create(user);
  await screen.findByText("创建结果待确认");
  await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
  await waitFor(() => expect(f.requests).toHaveLength(2));
  expect(screen.getByLabelText("账号名称")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "创建账号并继续" })).not.toBeInTheDocument();
  if (status === 422) {
    await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("账号已保存");
    expect(f.requests[2]).toEqual(f.requests[0]);
  } else {
    await waitFor(() => expect(screen.getByRole("button", { name: "重试上一次操作" })).toBeDisabled());
    await user.click(screen.getByRole("button", { name: "返回账号列表" }));
    const dialog = await screen.findByRole("alertdialog", { name: "结果未确认，仍要离开？" });
    expect(f.back).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "留在此页" }));
    expect(screen.getByLabelText("账号名称")).toBeDisabled();
  }
  expect(f.requests[1]).toEqual(f.requests[0]);
  expect(f.accounts.size).toBe(1);
});

it("aborts waiting on unmount and ignores a late successful creation response", async () => {
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  let committed!: AlipayAccount;
  const f = fixture((request, _input, _attempt, commit) => {
    signal = request.signal; committed = commit();
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const user = userEvent.setup();
  await create(user);
  await waitFor(() => expect(f.accounts.size).toBe(1));
  f.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(json({ data: committed }, 201)); });
  expect(f.saved).not.toHaveBeenCalled();
  expect(f.accounts.size).toBe(1);
});

it("keeps the same creation recoverable after the bounded wait expires", async () => {
  const setTimeout = window.setTimeout.bind(window);
  let timeout!: () => void;
  const timer = vi.spyOn(window, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === 20_000 && typeof handler === "function") timeout = () => handler(...args);
    return setTimeout(handler, delay, ...args) as unknown as ReturnType<typeof window.setTimeout>;
  });
  let finish!: (response: Response) => void;
  let originalSignal!: AbortSignal;
  let committed!: AlipayAccount;
  const f = fixture((request, _input, attempt, commit) => {
    committed = commit();
    if (attempt > 1) return json({ data: committed }, 201);
    originalSignal = request.signal;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  try {
    const user = userEvent.setup();
    await create(user);
    await waitFor(() => expect(timeout).toBeTypeOf("function"));
    await act(async () => { timeout(); });
    await screen.findByText("创建结果待确认");
    expect(originalSignal.aborted).toBe(true);
    expect(screen.getByLabelText("账号名称")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重试上一次操作" }));
    await screen.findByText("账号已保存");
    await act(async () => { finish(json({ data: committed }, 201)); });
    expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.accounts.size).toBe(1);
    expect(f.saved).toHaveBeenCalledOnce();
  } finally { timer.mockRestore(); }
});

it("asks before route navigation leaves an unknown creation and keeps the original retry when staying", async () => {
  const f = fixture((_request, _input, _attempt, commit) => { commit(); throw new TypeError("response lost"); });
  const user = userEvent.setup();
  await create(user);
  await screen.findByText("创建结果待确认");
  await act(async () => { await f.router.navigate("/settings/accounts"); });
  const dialog = await screen.findByRole("alertdialog", { name: "结果未确认，仍要离开？" });
  expect(f.router.state.location.pathname).toBe("/settings/accounts/new");
  await user.click(within(dialog).getByRole("button", { name: "留在此页" }));
  expect(screen.getByRole("button", { name: "重试上一次操作" })).toBeEnabled();
  expect(screen.getByLabelText("账号名称")).toBeDisabled();
  expect(f.requests).toHaveLength(1);
  await act(async () => { await f.router.navigate("/settings/accounts"); });
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "离开并稍后核查" }));
  await screen.findByRole("heading", { name: "账号列表" });
  expect(f.accounts.size).toBe(1);
  expect(f.requests).toHaveLength(1);
});
