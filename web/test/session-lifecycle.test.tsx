import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { appRoutes } from "../src/App";
import { queryClient, sessionKey } from "../src/api/client";
import { apiError, json, settings } from "./fixtures";

const session = { data: { username: "admin", csrf_token_required: true, idle_expires_at: "2099-01-01T00:00:00Z", absolute_expires_at: "2099-01-01T00:00:00Z" } };

function mount() {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  queryClient.setQueryData(sessionKey, session);
  const router = createMemoryRouter(appRoutes, { initialEntries: ["/settings/collection"] });
  return render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("administrator session lifecycle", () => {
  it.each(["network", "server"])("retains unsaved settings through a temporary %s session failure", async (failure) => {
    let unavailable = false;
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/session")) {
        if (unavailable && failure === "network") throw new TypeError("temporary network outage");
        return unavailable ? apiError("temporary_unavailable", "temporary outage", 503) : json(session);
      }
      return json({ data: settings });
    }));
    mount();
    const user = userEvent.setup();
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    await user.clear(ttl); await user.type(ttl, "450");
    unavailable = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: sessionKey, exact: true }); });
    await screen.findByRole("alert");
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
    expect(screen.getByText("有未保存的修改")).toBeVisible();
    await user.click(screen.getByRole("link", { name: "自动备份" }));
    expect(await screen.findByRole("dialog", { name: "放弃未保存的修改？" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    unavailable = false;
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("收银台有效期（秒）")).toBe(ttl);
    expect(ttl).toHaveValue(450);
  });

  it.each([401, 403])("still discards protected drafts for an explicit session rejection (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => new URL(request.url).pathname.endsWith("/session")
      ? apiError("session_invalid", "会话失效", status) : json({ data: settings })));
    mount();
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    fireEvent.change(ttl, { target: { value: "450" } });
    await act(async () => { await queryClient.refetchQueries({ queryKey: sessionKey, exact: true }); });
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    await waitFor(() => expect(queryClient.getQueryData(["settings"])).toBeUndefined());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never restores protected cache from a settings save completed after session expiry", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = vi.fn((request: Request) => request.method === "PUT"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(json({ data: settings })));
    vi.stubGlobal("fetch", fetchMock);
    mount();
    const user = userEvent.setup();
    const ttl = await screen.findByLabelText("收银台有效期（秒）");
    await user.clear(ttl); await user.type(ttl, "450");
    await user.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([request]) => request.method === "PUT")).toBe(true));
    fireEvent(window, new Event("perpay:session-expired"));
    expect(await screen.findByRole("heading", { name: "登录管理后台" })).toBeVisible();
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    const saved = { ...settings, revision: 4, collection: { ...settings.collection!, order_ttl_seconds: 450 } };
    await act(async () => { finish(json({ data: saved })); });
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    expect(queryClient.getQueryData(sessionKey)).toBeNull();
    expect(screen.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
  });
});
