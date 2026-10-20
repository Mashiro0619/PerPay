import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { useState } from "react";
import { Link, useDetailBack, useLedgerListPosition, useNavigate } from "../src/navigation";

function LedgerList() {
  const [ready, setReady] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useLedgerListPosition(ready);
  return <>
    <Link to="/ledger/entry-1">流水详情</Link>
    <button onClick={() => void navigate("/orders/order-1")}>打开关联订单</button>
    <button onClick={() => setReady(true)}>页面数据已就绪</button>
    <Link state={location.state} to={{ pathname: "/ledger", search: location.search + "&selected_site=shop" }}>切换导航记忆</Link>
    <output>{JSON.stringify(location.state)}</output>
  </>;
}
function Detail() {
  const back = useDetailBack("/ledger", "支付宝流水");
  const location = useLocation();
  return <>
    <Link to={back.to} state={back.state}>返回{back.label}</Link>
    <Link to="/orders/order-2">继续查看订单</Link>
    <Link to="/ledger/entry-1?selected_site=shop-b" state={location.state}>详情切换网站记忆</Link>
  </>;
}
function setup(key: string) {
  const router = createMemoryRouter([
    { path: "/ledger", element: <LedgerList /> },
    { path: "/ledger/:id", element: <Detail /> },
    { path: "/orders/:id", element: <Detail /> },
  ], { initialEntries: [{ pathname: "/ledger", search: "?q=book&cursor=cursor-2&page=2", key,
    state: { pagination: { cursor: { scope: "ledger", cursors: [null, "cursor-2"] } } } }] });
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  render(<RouterProvider router={router} />);
  return { router, scroll, user: userEvent.setup() };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ledger return position", () => {
  it("captures at click time and waits for the page before restoring across nested order navigation", async () => {
    const { router, scroll, user } = setup("nested-ledger-return");
    vi.stubGlobal("scrollY", 640);
    await user.click(screen.getByRole("link", { name: "流水详情" }));
    expect(router.state.location.state.listReturn.state.ledgerPosition.y).toBe(640);
    await user.click(screen.getByRole("link", { name: "继续查看订单" }));
    vi.stubGlobal("scrollY", 0);
    await user.click(screen.getByRole("link", { name: "返回支付宝流水" }));
    expect(router.state.location.search).toBe("?q=book&cursor=cursor-2&page=2");
    expect(router.state.location.state.pagination.cursor.cursors).toEqual([null, "cursor-2"]);
    expect(scroll).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "页面数据已就绪" }));
    expect(scroll).toHaveBeenCalledWith({ top: 640, left: 0, behavior: "instant" });
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    const before = scroll.mock.calls.length;
    await user.click(screen.getByRole("link", { name: "切换导航记忆" }));
    expect(router.state.location.search).toContain("selected_site=shop");
    expect(scroll.mock.calls.length).toBe(before);
  });

  it("captures programmatic row navigation to the real associated order", async () => {
    const { router, scroll, user } = setup("row-ledger-return");
    vi.stubGlobal("scrollY", 920);
    await user.click(screen.getByRole("button", { name: "打开关联订单" }));
    expect(router.state.location.pathname).toBe("/orders/order-1");
    expect(router.state.location.state.listReturn.state.ledgerPosition.y).toBe(920);
    await user.click(screen.getByRole("link", { name: "返回支付宝流水" }));
    await user.click(screen.getByRole("button", { name: "页面数据已就绪" }));
    expect(scroll).toHaveBeenCalledWith({ top: 920, left: 0, behavior: "instant" });
  });

  it("also restores the original history entry on browser back", async () => {
    const { router, scroll, user } = setup("browser-ledger-return");
    vi.stubGlobal("scrollY", 480);
    await user.click(screen.getByRole("link", { name: "流水详情" }));
    vi.stubGlobal("scrollY", 0);
    await act(() => router.navigate(-1));
    expect(router.state.location.key).toBe("browser-ledger-return");
    await user.click(screen.getByRole("button", { name: "页面数据已就绪" }));
    expect(scroll).toHaveBeenCalledWith({ top: 480, left: 0, behavior: "instant" });
  });

  it("returns with the latest website memory while retaining the list query and position", async () => {
    const { router, scroll, user } = setup("selected-ledger-return");
    vi.stubGlobal("scrollY", 720);
    await user.click(screen.getByRole("link", { name: "流水详情" }));
    await user.click(screen.getByRole("link", { name: "详情切换网站记忆" }));
    await user.click(screen.getByRole("link", { name: "返回支付宝流水" }));
    expect(router.state.location.search).toBe("?q=book&cursor=cursor-2&page=2&selected_site=shop-b");
    await user.click(screen.getByRole("button", { name: "页面数据已就绪" }));
    expect(scroll).toHaveBeenCalledWith({ top: 720, left: 0, behavior: "instant" });
  });
});
