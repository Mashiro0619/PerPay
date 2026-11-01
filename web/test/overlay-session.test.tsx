import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet, Route, RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient, sessionKey } from "../src/api/client";
import { AuthBoundary } from "../src/auth";
import { DraftProvider, useDirtyDraft } from "../src/drafts";
import { PageHeading } from "../src/components/page-heading";
import { OverlayHost, OverlayProvider } from "../src/components/overlay-host";
import { useOverlayCloseGuard } from "../src/lib/overlay-context";
import { OVERLAY_HISTORY_KEY, readOverlayTarget } from "../src/lib/overlay-navigation";

function ProtectedDetail() {
  useDirtyDraft(true);
  useOverlayCloseGuard(() => true);
  return <><PageHeading title="待确认的记录" /><input aria-label="敏感草稿" defaultValue="只属于旧会话" /></>;
}

function mount(signedIn: boolean) {
  const metadata = document.createElement("meta");
  metadata.name = "perpay-initialized"; metadata.content = "true"; document.head.append(metadata);
  const session = { data: { username: "admin", csrf_token_required: true, idle_expires_at: "2099-01-01T00:00:00Z", absolute_expires_at: "2099-01-01T00:00:00Z" } };
  queryClient.setQueryData(sessionKey, signedIn ? session : null);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname.endsWith("/session/login")) signedIn = true;
    return Response.json(signedIn ? session : null);
  }));
  const background = "/orders?q=kept%20filter";
  const router = createMemoryRouter([{ element: <AuthBoundary><DraftProvider><OverlayProvider><Outlet />
    <OverlayHost routes={<Route path="/orders/:orderId" element={<ProtectedDetail />} />} />
  </OverlayProvider></DraftProvider></AuthBoundary>, children: [{ path: "/orders", element: <main id="main-content" tabIndex={-1}><h1>原始订单列表</h1></main> }] }], {
    initialEntries: [{ pathname: "/orders", search: "?q=kept%20filter&overlay=%2Forders%2Forder-1", state: {
      parentMarker: "keep", [OVERLAY_HISTORY_KEY]: { version: 1, rootKey: "direct:record", rootUrl: background, depth: 1, rootState: { parentMarker: "keep" }, detailState: null, scrollY: 0 },
    } }],
  });
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

async function signIn() {
  await userEvent.type(await screen.findByLabelText("管理员密码"), "fresh-session-password");
  await userEvent.click(screen.getByRole("button", { name: "登录" }));
}

describe("overlay session ownership", () => {
  it("removes an expired session's overlay before login despite active draft and pending guards", async () => {
    const router = mount(true);
    await screen.findByRole("dialog", { name: "待确认的记录" });
    act(() => { window.dispatchEvent(new Event("perpay:session-expired")); });
    await screen.findByRole("heading", { name: "登录管理后台" });
    await waitFor(() => expect(router.state.location.search).toBe("?q=kept%20filter"));
    expect(router.state.location.state).toEqual({ parentMarker: "keep" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("敏感草稿")).not.toBeInTheDocument();
    await signIn();
    await screen.findByRole("heading", { name: "原始订单列表" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(router.state.location.search).toBe("?q=kept%20filter");
  });

  it("preserves an initially unauthenticated shared URL for the first successful sign-in", async () => {
    const router = mount(false);
    await screen.findByRole("heading", { name: "登录管理后台" });
    expect(readOverlayTarget(router.state.location.search)?.pathname).toBe("/orders/order-1");
    await signIn();
    await screen.findByRole("dialog", { name: "待确认的记录" });
    expect(screen.getByLabelText("敏感草稿")).toHaveValue("只属于旧会话");
  });
});
