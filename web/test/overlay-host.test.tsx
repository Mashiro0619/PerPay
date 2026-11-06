import { useEffect, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet, Route, RouterProvider, createMemoryRouter, useLocation, useParams, useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { DraftProvider, useDirtyDraft } from "../src/drafts";
import { Link, useNavigate } from "../src/navigation";
import { useCursor } from "../src/lib/cursor";
import { readOverlayTarget } from "../src/lib/overlay-navigation";
import { useOverlayCloseGuard, useOverlayContext } from "../src/lib/overlay-context";
import { RequestNoticeProvider } from "../src/lib/request-notices";
import { RequestNoticeBanner } from "../src/components/request-notice-banner";
import { ErrorNotice } from "../src/components/request-state";
import { LegacyOverlayRedirect, OverlayHost, OverlayProvider } from "../src/components/overlay-host";
import { OverlayActions } from "../src/components/overlay-actions";
import { PageHeading } from "../src/components/page-heading";
import { PageHeaderActions, PageHeaderActionsProvider, PageHeaderActionsSlot } from "../src/components/page-header-actions";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogCancel } from "../src/components/admin-dialog";
import { useWorkspace } from "../src/workspace";
import { TechnicalDetails } from "../src/components/detail/DetailPrimitives";
import { Toaster, createToastManager } from "../src/components/ui/toast";

let mounts = 0;
const parentFailure = new Error("父页面读取失败");
const detailFailure = new Error("当前记录读取失败");
const retryDetail = vi.fn();
function ListPage() {
  const pagination = useCursor();
  const location = useLocation();
  const [draft, setDraft] = useState("");
  useDirtyDraft(!!draft);
  useEffect(() => { mounts += 1; }, []);
  return <main id="main-content" tabIndex={-1}>
    <h1>原始列表</h1>
    <PageHeaderActions><button>父页刷新</button></PageHeaderActions>
    <input aria-label="父页面草稿" value={draft} onChange={event => setDraft(event.target.value)} />
    <output data-testid="parent-location">{location.pathname + location.search}</output>
    <output data-testid="parent-page">{pagination.page}</output>
    <Link id="open-record" to="/orders/order-1">打开记录</Link>
    <Link id="open-second-record" to="/orders/order-2">打开另一条记录</Link>
    <Link replace to="/orders/order-1">替换打开记录</Link>
    <Link to="/orders/order-1" target="_blank">新标签查看记录</Link>
    <Link to="/sites/shop/orders/order-1">查看本站记录</Link>
    <Link to="/notifications">其他列表</Link>
    <button onClick={pagination.previous}>父上一页</button>
    <ErrorNotice scope="page" error={new URLSearchParams(location.search).has("parent_notice") ? parentFailure : null} />
  </main>;
}
function Detail() {
  const { orderId, deliveryId, clientId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const pagination = useCursor();
  const { clientId: resourceScope } = useWorkspace();
  const overlay = useOverlayContext()!;
  const [draft, setDraft] = useState("");
  const [edit, setEdit] = useState(false);
  const [reason, setReason] = useState("");
  const [savedReason, setSavedReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useDirtyDraft(!!draft);
  useOverlayCloseGuard(() => pending);
  useEffect(() => {
    if (!location.hash) return;
    const anchor = document.getElementById(location.hash.slice(1));
    anchor?.scrollIntoView({ block: "start" });
    anchor?.focus();
  }, [location.hash]);
  return <>
    <PageHeading title={"记录 " + (orderId ?? deliveryId)} />
    <PageHeaderActions><button>详情刷新</button></PageHeaderActions>
    <output data-testid="detail-identity">{`${orderId ?? deliveryId}:${clientId ?? "global"}:${resourceScope ?? "global"}`}</output>
    <output data-testid="detail-section">{search.get("section") ?? "summary"}</output>
    <output data-testid="detail-page">{pagination.page}</output>
    <input aria-label="详情草稿" value={draft} onChange={event => setDraft(event.target.value)} />
    <ErrorNotice scope="page" error={orderId === "failure" ? detailFailure : null} retry={retryDetail} />
    <button onClick={() => setPending(true)}>开始提交</button>
    <button onClick={() => setPending(false)}>提交完成</button>
    <button onClick={() => pagination.next("detail-cursor")}>详情下一页</button>
    <button onClick={() => setSearch(current => { const next = new URLSearchParams(current); next.set("section", "events"); return next; }, { replace: true })}>切换详情页签</button>
    <Link global to="/notifications/delivery-1">关联通知</Link>
    <Link global to="/orders/order-1">全局记录</Link>
    <Link to="#source-record">核对这份记录</Link>
    <Link to="?section=events">查看记录事件</Link>
    <button onClick={() => navigate({ hash: "#source-record" })}>定位内部记录</button>
    <button onClick={() => navigate("?section=events", { replace: true })}>切换内部查询</button>
    <section id="source-record" tabIndex={-1}>查账记录锚点</section>
    <TechnicalDetails data={{ record: orderId ?? deliveryId }} identifiers={[["记录编号", orderId ?? deliveryId ?? ""]]} />
    <OverlayActions><button ref={trigger} onClick={() => setEdit(true)}>编辑内部步骤</button><button onClick={overlay.requestClose}>完成查看</button></OverlayActions>
    {edit && <Dialog open onOpenChange={setEdit}>
      <DialogContent finalFocus={search.has("default_step_focus") ? undefined : trigger}>
        <DialogHeader><DialogTitle>编辑内部步骤</DialogTitle></DialogHeader>
        <form className="contents" onSubmit={event => { event.preventDefault(); setSavedReason(reason); }}>
          <DialogBody>
            <input aria-label="内部步骤理由" value={reason} onChange={event => setReason(event.target.value)} />
            <button type="button" onClick={() => setConfirm(true)}>打开高风险确认</button>
            <output aria-label="已保存理由">{savedReason}</output>
          </DialogBody>
          <DialogFooter><button type="submit">保存步骤</button></DialogFooter>
        </form>
        <AlertDialog open={confirm} onOpenChange={setConfirm}><AlertDialogContent><AlertDialogTitle>确认这次操作？</AlertDialogTitle><AlertDialogCancel>取消确认</AlertDialogCancel></AlertDialogContent></AlertDialog>
      </DialogContent>
    </Dialog>}
  </>;
}
const detailRoutes = <>
  <Route path="/orders/:orderId" element={<Detail />} />
  <Route path="/notifications/:deliveryId" element={<Detail />} />
  <Route path="/sites/:clientId/orders/:orderId" element={<Detail />} />
</>;

function mount(entries: NonNullable<Parameters<typeof createMemoryRouter>[1]>["initialEntries"] = ["/orders"], initialIndex?: number, toastManager?: ReturnType<typeof createToastManager>) {
  const router = createMemoryRouter([{ element: <RequestNoticeProvider><PageHeaderActionsProvider><DraftProvider><OverlayProvider><div data-testid="parent-actions"><PageHeaderActionsSlot /></div><div data-testid="parent-banner"><RequestNoticeBanner /></div><Outlet /><OverlayHost routes={detailRoutes} /></OverlayProvider></DraftProvider></PageHeaderActionsProvider></RequestNoticeProvider>, children: [
    { path: "/orders", element: <ListPage /> }, { path: "/notifications", element: <ListPage /> },
    { path: "/orders/:orderId", element: <LegacyOverlayRedirect /> }, { path: "/outside", element: <div>外部来源</div> },
  ] }], { initialEntries: entries, ...(initialIndex !== undefined ? { initialIndex } : {}) });
  const application = <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>;
  const rendered = render(toastManager ? <Toaster toastManager={toastManager}>{application}</Toaster> : application);
  return { router, ...rendered };
}

beforeEach(() => { mounts = 0; retryDetail.mockClear(); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });

describe("one routed detail surface", () => {
  it("keeps the detail mounted while an independent technical dialog owns Escape and focus", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const parent = await screen.findByRole("dialog", { name: "记录 order-1" });
    const primary = parent.querySelector('[data-overlay-primary]')!;
    const body = parent.querySelector('[data-overlay-detail]')!;
    const address = view.router.state.location;
    const trigger = within(parent).getByRole("button", { name: "技术信息" });
    await user.click(trigger);
    const technical = await screen.findByRole("dialog", { name: "技术信息" });
    expect(technical.closest('[data-overlay-content]')).toBeNull();
    expect(technical).not.toHaveAttribute("data-overlay-step");
    expect(parent).toHaveAttribute("data-overlay-record", "true");
    expect(primary).not.toHaveAttribute("hidden");
    expect(body.querySelector("pre")).toBeNull();
    expect(view.router.state.location).toBe(address);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "记录 order-1" })).toBe(parent);
    expect(parent.querySelector('[data-overlay-detail]')).toBe(body);
    expect(screen.queryByRole("dialog", { name: "技术信息" })).not.toBeInTheDocument();
    await user.click(trigger);
    await user.click(within(await screen.findByRole("dialog", { name: "技术信息" })).getByRole("button", { name: "关闭技术信息" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(view.router.state.location).toBe(address);
    await user.click(trigger);
    const reader = await screen.findByRole("dialog", { name: "技术信息" });
    const backdrop = reader.parentElement!.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(backdrop).not.toBeNull();
    await user.click(backdrop);
    // Base UI probes preventScroll support before restoring outside-click focus;
    // jsdom does not support that probe. The browser regression checks focus.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "技术信息" })).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog", { name: "记录 order-1" })).toBe(parent);
    expect(parent.querySelector('[data-overlay-detail]')).toBe(body);
    expect(view.router.state.location).toBe(address);
  });

  it.each([false, true])("keeps foreground header actions in the popup without relying on the parent menu, mobile=%s", async mobile => {
    vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ media, matches: mobile, addEventListener() {}, removeEventListener() {} })));
    mount();
    await userEvent.click(screen.getByRole("link", { name: "打开记录" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(dialog).toHaveAttribute("data-overlay-record", "true");
    const refresh = within(dialog).getByRole("button", { name: "详情刷新" });
    expect(refresh.closest("[data-slot=dialog-header]")).not.toBeNull();
    expect(screen.getByTestId("parent-actions")).not.toHaveTextContent("详情刷新");
    expect(dialog.querySelector("[data-overlay-detail]")).not.toHaveTextContent("详情刷新");
  });

  it("retains the parent component and cursor trail while detail pagination uses its own search and state", async () => {
    const state = { pagination: { cursor: { scope: "/orders?payment=PAID:cursor", firstPage: 1, cursors: [null, "previous-cursor", "list-cursor"] } } };
    const view = mount([{ pathname: "/orders", search: "?payment=PAID&cursor=list-cursor&page=3", state }]);
    const user = userEvent.setup();
    const trigger = screen.getByRole("link", { name: "打开记录" });
    expect(trigger).toHaveAttribute("href", "/orders?payment=PAID&cursor=list-cursor&page=3&overlay=%2Forders%2Forder-1");
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(view.router.state.location.pathname).toBe("/orders");
    expect(screen.getByTestId("parent-page")).toHaveTextContent("3");
    expect(within(dialog).getByTestId("detail-page")).toHaveTextContent("1");
    await user.click(within(dialog).getByRole("button", { name: "详情下一页" }));
    await waitFor(() => expect(within(dialog).getByTestId("detail-page")).toHaveTextContent("2"));
    expect(new URLSearchParams(view.router.state.location.search).get("cursor")).toBe("list-cursor");
    expect(new URLSearchParams(readOverlayTarget(view.router.state.location.search)!.search).get("cursor")).toBe("detail-cursor");
    expect(screen.getByTestId("parent-page")).toHaveTextContent("3");
    expect(within(dialog).getByRole("button", { name: "完成查看" }).closest("[data-overlay-footer]")).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mounts).toBe(1);
    expect(view.router.state.location.search).toBe("?payment=PAID&cursor=list-cursor&page=3");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "父上一页" }));
    expect(new URLSearchParams(view.router.state.location.search).get("cursor")).toBe("previous-cursor");
  });

  it("uses one surface across associated objects and supports browser back, forward and closing to the root list", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(screen.getByRole("link", { name: "关联通知" })).toHaveAttribute("href", "/orders?overlay=%2Fnotifications%2Fdelivery-1");
    await user.click(screen.getByRole("link", { name: "关联通知" }));
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    expect(document.querySelectorAll("[data-overlay-content]")).toHaveLength(1);
    await act(async () => { await view.router.navigate(-1); });
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await act(async () => { await view.router.navigate(1); });
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe("/orders");
    expect(mounts).toBe(1);
  });

  it("reconstructs an old deep link and a reloaded address without closing into the prior external page", async () => {
    const view = mount(["/outside", "/orders/order-1?section=events"], 1);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(screen.getByTestId("detail-section")).toHaveTextContent("events");
    const address = view.router.state.location.pathname + view.router.state.location.search;
    view.unmount();
    const fresh = mount([address]);
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fresh.router.state.location.pathname + fresh.router.state.location.search).toBe("/orders");
  });

  it("keeps the exact parent address in native links and reconstructs it in a new tab", async () => {
    const address = "/orders?q=a%20b&cursor=page%2B2&page=2";
    const view = mount([address]);
    const link = screen.getByRole("link", { name: "新标签查看记录" });
    const href = link.getAttribute("href")!;
    expect(href).toBe(address + "&overlay=%2Forders%2Forder-1");
    let prevented = true;
    window.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
    fireEvent.click(screen.getByRole("link", { name: "打开记录" }), { ctrlKey: true });
    expect(prevented).toBe(false);
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(address);
    view.unmount();
    const fresh = mount([href]);
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(screen.getByRole("link", { name: "关联通知" })).toHaveAttribute("href", address + "&overlay=%2Fnotifications%2Fdelivery-1");
    await userEvent.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fresh.router.state.location.pathname + fresh.router.state.location.search).toBe(address);
  });

  it("keeps native pathless links and imperative query/anchor navigation inside the foreground record", async () => {
    const parent = "/orders?q=a%20b&cursor=page%2B2&page=2";
    const state = { listReturn: { to: parent, label: "订单列表" }, pagination: { cursor: "detail-cursor" }, marker: "preserve-anchor-state" };
    const view = mount([{ pathname: "/orders", search: "?q=a%20b&cursor=page%2B2&page=2&overlay=" + encodeURIComponent("/orders/order-1?section=events"),
      state: { perpayOverlay: { version: 1, rootKey: "direct", rootUrl: parent, depth: 1, rootState: null, detailState: state, scrollY: 0 } } }]);
    const user = userEvent.setup();
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const anchorLink = within(detail).getByRole("link", { name: "核对这份记录" });
    expect(anchorLink).toHaveAttribute("href", parent + "&overlay=" + encodeURIComponent("/orders/order-1#source-record"));
    expect(within(detail).getByRole("link", { name: "查看记录事件" })).toHaveAttribute("href", parent + "&overlay=" + encodeURIComponent("/orders/order-1?section=events"));
    await user.click(anchorLink);
    expect(readOverlayTarget(view.router.state.location.search)).toEqual({ pathname: "/orders/order-1", search: "", hash: "#source-record" });
    expect(view.router.state.location.state.perpayOverlay.detailState).toEqual(state);
    await waitFor(() => expect(within(detail).getByText("查账记录锚点")).toHaveFocus());
    await user.click(within(detail).getByRole("button", { name: "切换内部查询" }));
    expect(readOverlayTarget(view.router.state.location.search)).toEqual({ pathname: "/orders/order-1", search: "?section=events", hash: "" });
    await user.click(within(detail).getByRole("button", { name: "定位内部记录" }));
    expect(readOverlayTarget(view.router.state.location.search)?.hash).toBe("#source-record");
    expect(view.router.state.location.state.perpayOverlay.detailState).toEqual(state);
    await waitFor(() => expect(within(detail).getByText("查账记录锚点")).toHaveFocus());
    expect(view.router.state.location.search.split("&overlay=")[0]).toBe("?q=a%20b&cursor=page%2B2&page=2");
    expect(mounts).toBe(1);
  });

  it.each(["/orders/order-1", "/orders?overlay=%2Forders%2Forder-1"])("returns through known foreground history after opening %s directly", async entry => {
    const view = mount(["/outside", entry], 1);
    const user = userEvent.setup();
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(screen.queryByRole("button", { name: "返回上一步" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "关联通知" }));
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    await user.click(screen.getByRole("button", { name: "返回上一步" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe("/orders");
  });

  it("closes a replaced initial detail safely without navigating to the preceding page", async () => {
    const view = mount(["/outside", "/orders"], 1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "替换打开记录" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe("/orders");
  });

  it("restores the current root trigger when browser Back closes a later overlay", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const trigger = screen.getByRole("link", { name: "打开另一条记录" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "记录 order-2" });
    await act(async () => { await view.router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps detail recovery in the active popup and clears its notices when the target changes", async () => {
    mount(["/orders?parent_notice=1&overlay=%2Forders%2Ffailure"]);
    const user = userEvent.setup();
    const dialog = await screen.findByRole("dialog", { name: "记录 failure" });
    const foreground = await within(dialog).findByRole("alert", { name: "服务连接提示" });
    expect(foreground).toHaveTextContent("当前记录读取失败");
    const parent = screen.getByTestId("parent-banner");
    expect(parent).toHaveTextContent("父页面读取失败");
    expect(parent).not.toHaveTextContent("当前记录读取失败");
    await user.click(within(foreground).getByRole("button", { name: "重试" }));
    expect(retryDetail).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole("link", { name: "关联通知" }));
    const next = await screen.findByRole("dialog", { name: "记录 delivery-1" });
    expect(within(next).queryByRole("alert", { name: "服务连接提示" })).not.toBeInTheDocument();
    expect(parent).toHaveTextContent("父页面读取失败");
  });

  it("also presents a failed foreground workspace read inside the overlay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("连接中断"); }));
    mount();
    await userEvent.click(screen.getByRole("link", { name: "查看本站记录" }));
    const dialog = await screen.findByRole("dialog", { name: "订单详情" });
    await within(dialog).findByRole("alert", { name: "服务连接提示" });
    expect(screen.getByTestId("parent-banner")).toBeEmptyDOMElement();
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeEnabled();
  });

  it("uses the single existing blocker to keep a pending detail on browser Back and related navigation", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.click(within(dialog).getByRole("button", { name: "开始提交" }));
    await act(async () => { await view.router.navigate(-1); });
    await waitFor(() => expect(view.router.state.blockers.values().next().value?.state).toBe("unblocked"));
    expect(view.router.state.blockers.size).toBe(1);
    expect(readOverlayTarget(view.router.state.location.search)?.pathname).toBe("/orders/order-1");
    await user.click(within(dialog).getByRole("link", { name: "关联通知" }));
    expect(readOverlayTarget(view.router.state.location.search)?.pathname).toBe("/orders/order-1");
    await user.click(within(dialog).getByRole("button", { name: "切换详情页签" }));
    expect(screen.getByTestId("detail-section")).toHaveTextContent("events");
    await user.click(within(dialog).getByRole("button", { name: "完成查看" }));
    expect(screen.getByRole("dialog", { name: "记录 order-1" })).toBe(dialog);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "提交完成" }));
    await act(async () => { await view.router.navigate(-1); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps a detail draft across tab changes and cancelled dismissal while using the existing single blocker", async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    await user.type(screen.getByLabelText("详情草稿"), "保留内容");
    await user.click(screen.getByRole("button", { name: "切换详情页签" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    expect(view.router.state.blockers.size).toBe(1);
    await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.getByLabelText("详情草稿")).toHaveValue("保留内容"));
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await user.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not discard or unnecessarily block a retained background draft", async () => {
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("父页面草稿"), "父页面内容");
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("父页面草稿")).toHaveValue("父页面内容");
    await user.click(screen.getByRole("link", { name: "其他列表" }));
    await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
  });

  it("moves business dialogs into the same container and retains their form under a short confirmation", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const trigger = within(detail).getByRole("button", { name: "编辑内部步骤" });
    await user.click(trigger);
    const step = await screen.findByRole("dialog", { name: "编辑内部步骤" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(detail).toHaveAttribute("role", "presentation");
    expect(step.closest("[data-overlay-content]")).toBe(detail);
    expect(document.querySelectorAll("[data-slot=dialog-overlay]")).toHaveLength(1);
    expect(detail.querySelector("[data-overlay-primary]")).not.toBeVisible();
    await user.type(within(step).getByLabelText("内部步骤理由"), "固定理由");
    await user.click(within(step).getByRole("button", { name: "打开高风险确认" }));
    const confirm = await screen.findByRole("alertdialog", { name: "确认这次操作？" });
    await user.click(within(confirm).getByRole("button", { name: "取消确认" }));
    await waitFor(() => expect(within(step).getByLabelText("内部步骤理由")).toHaveValue("固定理由"));
    const save = within(step).getByRole("button", { name: "保存步骤" }) as HTMLButtonElement;
    const input = within(step).getByLabelText("内部步骤理由") as HTMLInputElement;
    expect(save.form).toBe(input.form);
    expect(save.closest("[data-overlay-step-scroll]")).not.toBeNull();
    await user.click(save);
    expect(within(step).getByLabelText("已保存理由")).toHaveTextContent("固定理由");
    await user.click(within(step).getByRole("button", { name: "关闭对话框" }));
    await waitFor(() => expect(detail.querySelector("[data-overlay-primary]")).toBeVisible());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps a keyboard reading entry around the complete step form and restores its default footer trigger", async () => {
    let availableHeight = 120;
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-overlay-step-scroll") ? availableHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-overlay-step-scroll") ? 400 : 0;
    });
    const measures = new Set<() => void>();
    vi.stubGlobal("ResizeObserver", class {
      constructor(private measure: () => void) { measures.add(measure); }
      observe() { this.measure(); }
      unobserve() {}
      disconnect() { measures.delete(this.measure); }
    });
    mount(["/orders?overlay=" + encodeURIComponent("/orders/order-1?default_step_focus=1")]);
    const user = userEvent.setup();
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const trigger = within(detail).getByRole("button", { name: "编辑内部步骤" });
    await user.click(trigger);
    const step = await screen.findByRole("dialog", { name: "编辑内部步骤" });
    const scroll = step.querySelector<HTMLElement>("[data-overlay-step-scroll]")!;
    expect(scroll).toHaveAttribute("data-overlay-step-scroll");
    expect(scroll).toHaveAttribute("data-scrollable", "true");
    expect(scroll).toHaveAttribute("tabindex", "0");
    await waitFor(() => expect(scroll).toHaveFocus());
    expect(within(step).getByRole("button", { name: "保存步骤" }).closest("form"))
      .toBe(within(step).getByLabelText("内部步骤理由").closest("form"));
    availableHeight = 800;
    act(() => { for (const measure of measures) measure(); });
    expect(scroll).toHaveAttribute("data-scrollable", "false");
    expect(scroll).toHaveAttribute("tabindex", "-1");
    expect(scroll).toHaveFocus();
    availableHeight = 120;
    act(() => { for (const measure of measures) measure(); });
    expect(scroll).toHaveAttribute("data-scrollable", "true");
    expect(scroll).toHaveAttribute("tabindex", "0");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(detail.querySelector("[data-overlay-primary]")).toBeVisible());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses toast feedback while preserving the active step and its draft", async () => {
    const manager = createToastManager();
    mount(undefined, undefined, manager);
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const trigger = within(detail).getByRole("button", { name: "编辑内部步骤" });
    await user.click(trigger);
    const step = await screen.findByRole("dialog", { name: "编辑内部步骤" });
    await user.type(within(step).getByLabelText("内部步骤理由"), "保留步骤草稿");
    act(() => { manager.add({ title: "步骤内操作反馈", timeout: 0 }); });
    await user.keyboard("{F6}");
    await waitFor(() => expect(screen.getByRole("region", { name: "提示" })).toHaveFocus());
    expect(step).toBeVisible();
    await user.hover(await screen.findByText("步骤内操作反馈"));
    await user.click(await screen.findByRole("button", { name: "关闭提示" }));
    await waitFor(() => expect(screen.queryByText("步骤内操作反馈")).not.toBeInTheDocument());
    expect(step).toBeVisible();
    expect(within(step).getByLabelText("内部步骤理由")).toHaveValue("保留步骤草稿");
    await user.click(within(step).getByLabelText("内部步骤理由"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(step).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "编辑内部步骤" });
    await user.click(detail.parentElement!.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!);
    await waitFor(() => expect(reopened).not.toBeInTheDocument());
    expect(detail).toBeVisible();
  });

  it("gives a cross-scope detail its actual params and resource provider while leaving the parent global", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { client_id: "shop", deleted_at: null } })));
    const view = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "查看本站记录" }));
    await waitFor(() => expect(screen.getByTestId("detail-identity")).toHaveTextContent("order-1:shop:shop"));
    expect(view.router.state.location.pathname).toBe("/orders");
    await user.click(screen.getByRole("link", { name: "全局记录" }));
    await waitFor(() => expect(screen.getByTestId("detail-identity")).toHaveTextContent("order-1:global:global"));
    expect(mounts).toBe(1);
  });
});
