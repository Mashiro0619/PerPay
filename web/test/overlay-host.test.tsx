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
import { OverlayRecordList } from "../src/components/overlay-record-list";
import { OverlayActions, OverlaySummary } from "../src/components/overlay-actions";
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
    <OverlayRecordList items={["/orders/order-1", "/orders/order-2", "/orders/order-3"]}>
      <div role="list">
        <Link id="open-record" data-row-link to="/orders/order-1">打开记录</Link>
        <Link id="open-second-record" data-row-link to="/orders/order-2">打开另一条记录</Link>
        <Link id="open-third-record" data-row-link to="/orders/order-3">打开第三条记录</Link>
      </div>
    </OverlayRecordList>
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
    <PageHeading title={"记录 " + (orderId ?? deliveryId)} eyebrow="示例网站" />
    <OverlaySummary><p>固定摘要 {orderId ?? deliveryId}</p></OverlaySummary>
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
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
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

  it("marks the link whose record is open and keeps a trace of it after closing", async () => {
    const view = mount();
    const user = userEvent.setup();
    const first = () => screen.getByRole("link", { name: "打开记录", hidden: true });
    const second = () => screen.getByRole("link", { name: "打开另一条记录", hidden: true });
    expect(first()).not.toHaveAttribute("data-record-state");
    await user.click(first());
    await screen.findByRole("dialog", { name: "记录 order-1" });
    expect(first()).toHaveAttribute("data-record-state", "open");
    expect(second()).not.toHaveAttribute("data-record-state");
    // A related record read in the same overlay leaves the mark on the row that was opened.
    await user.click(screen.getByRole("link", { name: "关联通知" }));
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    expect(first()).toHaveAttribute("data-record-state", "open");
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(first()).toHaveAttribute("data-record-state", "recent");
    await user.click(second());
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(second()).toHaveAttribute("data-record-state", "open");
    expect(first()).not.toHaveAttribute("data-record-state");
    await user.click(screen.getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Another page starts without a trace.
    await act(async () => { await view.router.navigate("/notifications"); });
    for (const link of screen.getAllByRole("link")) expect(link).not.toHaveAttribute("data-record-state");
  });

  it("names the record type above the title and keeps the summary outside the scrolling content", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    // The eyebrow is not part of the dialog's name.
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const eyebrow = detail.querySelector("[data-overlay-eyebrow-text]")!;
    expect(eyebrow).toHaveTextContent("订单详情 · 示例网站");
    expect(eyebrow).not.toHaveAttribute("aria-hidden");
    const summary = detail.querySelector("[data-overlay-summary]")!;
    expect(summary).toHaveTextContent("固定摘要 order-1");
    // The summary and the detail share one box below the header, which a short drawer scrolls as a whole.
    expect(summary.parentElement).toHaveAttribute("data-overlay-body");
    expect(summary.parentElement!.previousElementSibling).toHaveAttribute("data-slot", "dialog-header");
    expect(summary.nextElementSibling).toHaveAttribute("data-overlay-detail");
    expect(summary.parentElement!.nextElementSibling).toHaveAttribute("data-overlay-footer");
    expect(detail.querySelector("[data-overlay-detail]")).not.toHaveTextContent("固定摘要");
  });

  it("moves business dialogs into the same container and retains their form under a short confirmation", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const detail = await screen.findByRole("dialog", { name: "记录 order-1" });
    const trigger = within(detail).getByRole("button", { name: "编辑内部步骤" });
    expect(detail).toHaveAttribute("data-overlay-presentation", "drawer");
    expect(detail).toHaveAttribute("data-overlay-size", "lg");
    expect(document.querySelector("[data-slot=dialog-overlay]")).toHaveClass("overlay-drawer-backdrop");
    await user.click(trigger);
    const step = await screen.findByRole("dialog", { name: "编辑内部步骤" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(detail).toHaveAttribute("role", "presentation");
    // The step asks for the narrower default size; a record drawer keeps its own width.
    expect(detail).toHaveAttribute("data-overlay-size", "lg");
    expect(step.closest("[data-overlay-content]")).toBe(detail);
    expect(step.querySelector("[data-overlay-step-bar] [data-overlay-eyebrow-text]")).toHaveTextContent("订单详情");
    const stepClose = within(step).getByRole("button", { name: "关闭对话框" });
    expect(stepClose.closest("[data-overlay-step-bar]")).not.toBeNull();
    expect(stepClose.closest("[data-overlay-step-scroll]")).toBeNull();
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

  it("steps through sibling list rows in the drawer header, hides on nested records, and restores focus to the last viewed row", async () => {
    const view = mount();
    const user = userEvent.setup();
    const first = () => screen.getByRole("link", { name: "打开记录", hidden: true });
    const second = () => screen.getByRole("link", { name: "打开另一条记录", hidden: true });
    const third = () => screen.getByRole("link", { name: "打开第三条记录", hidden: true });
    await user.click(first());
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    const prev = () => within(dialog).getByRole("button", { name: "上一条" });
    const next = () => within(dialog).getByRole("button", { name: "下一条" });
    await waitFor(() => expect(prev()).toBeDisabled());
    expect(next()).toBeEnabled();

    await user.click(next());
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(second()).toHaveAttribute("data-record-state", "open");
    expect(first()).not.toHaveAttribute("data-record-state");
    expect(prev()).toBeEnabled();
    expect(next()).toBeEnabled();
    expect(next()).toHaveFocus();

    // Stepping to the last row disables "下一条" and moves focus safely to the title.
    await user.click(next());
    await screen.findByRole("dialog", { name: "记录 order-3" });
    expect(third()).toHaveAttribute("data-record-state", "open");
    await waitFor(() => expect(next()).toBeDisabled());
    expect(prev()).toBeEnabled();
    expect(dialog.querySelector("[data-overlay-heading]")).toHaveFocus();

    // Opening a related record hides sibling stepping until returning to the row.
    await user.click(within(dialog).getByRole("link", { name: "关联通知" }));
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    expect(within(dialog).queryByRole("button", { name: "上一条" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "下一条" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "返回上一步" }));
    await screen.findByRole("dialog", { name: "记录 order-3" });
    await waitFor(() => expect(prev()).toBeEnabled());

    await user.click(prev());
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(second()).toHaveAttribute("data-record-state", "open");

    // Closing after multiple steps exits in one hop, restores focus to the last viewed row,
    // and scrolls that row into view instead of pulling back to the original scrollY.
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    scrollTo.mockClear();
    const scrolled: Array<{ target: HTMLElement; arg: unknown }> = [];
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement, arg?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ target: this, arg });
    });
    try {
      await user.click(within(dialog).getByRole("button", { name: "完成查看" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(view.router.state.location.pathname).toBe("/orders");
      expect(second()).toHaveAttribute("data-record-state", "recent");
      await waitFor(() => expect(second()).toHaveFocus());
      await waitFor(() => expect(scrolled).toContainEqual({ target: second(), arg: { block: "nearest" } }));
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("keeps the current record when stepping is blocked by a close guard or a dirty draft", async () => {
    mount();
    const user = userEvent.setup();
    const first = () => screen.getByRole("link", { name: "打开记录", hidden: true });
    const second = () => screen.getByRole("link", { name: "打开另一条记录", hidden: true });
    await user.click(first());
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "下一条" })).toBeEnabled());

    await user.click(within(dialog).getByRole("button", { name: "开始提交" }));
    await user.click(within(dialog).getByRole("button", { name: "下一条" }));
    expect(screen.getByRole("dialog", { name: "记录 order-1" })).toBeVisible();
    expect(first()).toHaveAttribute("data-record-state", "open");
    await user.click(within(dialog).getByRole("button", { name: "提交完成" }));

    await user.type(within(dialog).getByLabelText("详情草稿"), "未保存内容");
    await user.click(within(dialog).getByRole("button", { name: "下一条" }));
    const confirm = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(confirm).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "记录 order-1" })).toBeVisible();
    expect(first()).toHaveAttribute("data-record-state", "open");
    expect(second()).not.toHaveAttribute("data-record-state");

    await user.click(within(dialog).getByRole("button", { name: "下一条" }));
    const discard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(discard).getByRole("button", { name: "放弃修改并继续" }));
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(second()).toHaveAttribute("data-record-state", "open");
    expect(first()).not.toHaveAttribute("data-record-state");
  });

  it("reads a different record from its top and keeps the place within the same record", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "打开记录" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-1" });
    // Which box scrolls depends on the drawer's height, so none may keep the last record's offset.
    const boxes = ["[data-overlay-primary]", "[data-overlay-body]", "[data-overlay-detail]"].map(selector => dialog.querySelector<HTMLElement>(selector)!);
    const scrollDown = () => { for (const box of boxes) box.scrollTop = 220; };
    const offsets = () => boxes.map(box => box.scrollTop);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "下一条" })).toBeEnabled());

    scrollDown();
    await user.click(within(dialog).getByRole("button", { name: "下一条" }));
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(offsets()).toEqual([0, 0, 0]);

    // Another query of the same record leaves the reader where they are.
    scrollDown();
    await user.click(within(dialog).getByRole("button", { name: "切换内部查询" }));
    await waitFor(() => expect(within(dialog).getByTestId("detail-section")).toHaveTextContent("events"));
    expect(offsets()).toEqual([220, 220, 220]);

    // A related record starts at its top, and so does the record returned to.
    await user.click(within(dialog).getByRole("link", { name: "关联通知" }));
    await screen.findByRole("dialog", { name: "记录 delivery-1" });
    expect(offsets()).toEqual([0, 0, 0]);
    scrollDown();
    await user.click(within(dialog).getByRole("button", { name: "返回上一步" }));
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(offsets()).toEqual([0, 0, 0]);
  });

  it("steps across paginated list pages, preserves pagination on close, and guards drafts before turning the page", async () => {
    const pages: Record<string, { items: string[]; next: string | null }> = {
      "": { items: ["order-1", "order-2"], next: "c2" },
      c2: { items: ["order-3"], next: null },
    };
    let holdNextPage: (() => void) | null = null;
    let shouldHold = false;
    function PagedOrders() {
      const pagination = useCursor();
      const cursor = pagination.cursor ?? "";
      const [loadedCursor, setLoadedCursor] = useState(cursor);
      const pending = loadedCursor !== cursor;
      useEffect(() => {
        if (!pending) return;
        if (shouldHold) {
          holdNextPage = () => { holdNextPage = null; setLoadedCursor(cursor); };
          return;
        }
        setLoadedCursor(cursor);
      }, [cursor, pending]);
      const data = pending ? undefined : pages[loadedCursor];
      const items = data?.items ?? [];
      return <main id="main-content" tabIndex={-1}>
        <output data-testid="paged-page">{pagination.page}</output>
        <output data-testid="paged-prev-label">{pagination.previousLabel}</output>
        <button type="button" disabled={pagination.page <= 1} onClick={pagination.previous}>列表上一页</button>
        <OverlayRecordList
          items={items.map(id => "/orders/" + id)}
          hasPrevious={pagination.canStepPrevious}
          hasNext={!!data?.next}
          pending={pending}
          pageKey={pagination.pageKey}
          onPreviousPage={pagination.replacePrevious}
          onNextPage={() => pagination.replaceNext(data?.next)}
        >
          {pending ? <div role="status">加载中…</div> : <div role="list">
            {items.map(id => <Link key={id} id={"row-" + id} data-row-link to={"/orders/" + id}>{"订单 " + id}</Link>)}
          </div>}
        </OverlayRecordList>
      </main>;
    }
    const router = createMemoryRouter([{ element: <RequestNoticeProvider><PageHeaderActionsProvider><DraftProvider><OverlayProvider><Outlet /><OverlayHost routes={detailRoutes} /></OverlayProvider></DraftProvider></PageHeaderActionsProvider></RequestNoticeProvider>, children: [
      { path: "/orders", element: <PagedOrders /> },
    ] }], { initialEntries: ["/orders"] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup();

    await user.click(screen.getByRole("link", { name: "订单 order-2" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-2" });
    const prev = () => within(dialog).getByRole("button", { name: "上一条" });
    const next = () => within(dialog).getByRole("button", { name: "下一条" });
    expect(prev()).toBeEnabled();
    expect(next()).toBeEnabled();

    // A dirty draft cancels cross-page stepping before the background page turns.
    await user.type(within(dialog).getByLabelText("详情草稿"), "草稿");
    await user.click(next());
    const confirm = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(confirm).getByRole("button", { name: "继续编辑" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("paged-page")).toHaveTextContent("1");
    expect(screen.getByRole("dialog", { name: "记录 order-2" })).toBeVisible();

    // Proceeding turns the page once without prompting a second time, waits while page 2 loads,
    // then lands on page 2's only item with "上一条" enabled and "下一条" disabled.
    shouldHold = true;
    await user.click(next());
    const discard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(discard).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(screen.getByTestId("paged-page")).toHaveTextContent("2"));
    expect(prev()).toBeDisabled();
    expect(next()).toBeDisabled();
    expect(holdNextPage).not.toBeNull();
    act(() => { holdNextPage?.(); });
    shouldHold = false;
    await screen.findByRole("dialog", { name: "记录 order-3" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "订单 order-3", hidden: true })).toHaveAttribute("data-record-state", "open");
    await waitFor(() => expect(next()).toBeDisabled());
    expect(prev()).toBeEnabled();
    expect(dialog.querySelector("[data-overlay-heading]")).toHaveFocus();

    // Stepping back crosses from page 2's first item to page 1's last item.
    await user.click(prev());
    await screen.findByRole("dialog", { name: "记录 order-2" });
    expect(screen.getByTestId("paged-page")).toHaveTextContent("1");
    expect(screen.getByRole("link", { name: "订单 order-2", hidden: true })).toHaveAttribute("data-record-state", "open");
    expect(prev()).toHaveFocus();

    // Cross forward to page 2 again and close: stays on page 2, focuses landed row, and preserves "上一页".
    await user.click(next());
    await screen.findByRole("dialog", { name: "记录 order-3" });
    await user.click(within(dialog).getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("paged-page")).toHaveTextContent("2");
    expect(screen.getByTestId("paged-prev-label")).toHaveTextContent("上一页");
    const row3 = screen.getByRole("link", { name: "订单 order-3" });
    expect(row3).toHaveAttribute("data-record-state", "recent");
    await waitFor(() => expect(row3).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "列表上一页" }));
    expect(screen.getByTestId("paged-page")).toHaveTextContent("1");
  });

  it("recovers cleanly when the next page fails to load and respects which list opened a shared record", async () => {
    function DualAndFailingPage() {
      const pagination = useCursor();
      const failed = pagination.cursor === "bad";
      const items = failed ? [] : ["order-1", "order-shared"];
      return <main id="main-content" tabIndex={-1}>
        <OverlayRecordList
          items={items.map(id => "/orders/" + id)}
          hasNext={!failed}
          failed={failed}
          pageKey={pagination.pageKey}
          onNextPage={() => pagination.replaceNext("bad")}
        >
          <section aria-label="列表一">
            {items.map(id => <Link key={"a-" + id} data-row-link to={"/orders/" + id}>{"列表一 " + id}</Link>)}
          </section>
        </OverlayRecordList>
        <OverlayRecordList items={["/orders/order-shared", "/orders/order-9"]}>
          <section aria-label="列表二">
            <Link data-row-link to="/orders/order-shared">列表二 order-shared</Link>
            <Link data-row-link to="/orders/order-9">列表二 order-9</Link>
          </section>
        </OverlayRecordList>
      </main>;
    }
    const router = createMemoryRouter([{ element: <RequestNoticeProvider><PageHeaderActionsProvider><DraftProvider><OverlayProvider><Outlet /><OverlayHost routes={detailRoutes} /></OverlayProvider></DraftProvider></PageHeaderActionsProvider></RequestNoticeProvider>, children: [
      { path: "/orders", element: <DualAndFailingPage /> },
    ] }], { initialEntries: ["/orders"] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup();

    // Opening the shared record from list 2 steps through list 2 (to order-9), not list 1.
    await user.click(screen.getByRole("link", { name: "列表二 order-shared" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-shared" });
    expect(within(dialog).getByRole("button", { name: "上一条" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "下一条" }));
    await screen.findByRole("dialog", { name: "记录 order-9" });
    await user.click(within(dialog).getByRole("button", { name: "完成查看" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Opening the shared record from list 1 and stepping into a failed next page cancels pending state cleanly,
    // restores keyboard focus to the drawer heading, and keeps draft protection intact on the still-open record.
    await user.click(screen.getByRole("link", { name: "列表一 order-shared" }));
    const dialog2 = await screen.findByRole("dialog", { name: "记录 order-shared" });
    await user.type(within(dialog2).getByLabelText("详情草稿"), "仍在编辑");
    const nextButton = within(dialog2).getByRole("button", { name: "下一条" });
    nextButton.focus();
    await user.keyboard("{Enter}");
    const discard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(discard).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(within(dialog2).queryByRole("button", { name: "下一条" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "记录 order-shared" })).toBeVisible();
    await waitFor(() => expect(dialog2.querySelector("[data-overlay-heading]")).toHaveFocus());
    // Draft was never left because page 2 failed, so closing must still ask for confirmation.
    await user.click(within(dialog2).getByRole("button", { name: "完成查看" }));
    const guard = await screen.findByRole("alertdialog", { name: "放弃未保存的修改？" });
    await user.click(within(guard).getByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("releases the pager and restores focus when an infinite-append list loads an empty page", async () => {
    let finishLoad: (() => void) | null = null;
    function InfiniteOrders() {
      const [items] = useState(["order-1", "order-2"]);
      const [hasNext, setHasNext] = useState(true);
      const [pending, setPending] = useState(false);
      return <main id="main-content" tabIndex={-1}>
        <OverlayRecordList
          items={items.map(id => "/orders/" + id)}
          hasNext={hasNext}
          pending={pending}
          pageKey={String(items.length)}
          onNextPage={() => {
            setPending(true);
            finishLoad = () => {
              finishLoad = null;
              setHasNext(false);
              setPending(false);
            };
          }}
        >
          <div role="list">
            {items.map(id => <Link key={id} data-row-link to={"/orders/" + id}>{"追加订单 " + id}</Link>)}
          </div>
        </OverlayRecordList>
      </main>;
    }
    const router = createMemoryRouter([{ element: <RequestNoticeProvider><PageHeaderActionsProvider><DraftProvider><OverlayProvider><Outlet /><OverlayHost routes={detailRoutes} /></OverlayProvider></DraftProvider></PageHeaderActionsProvider></RequestNoticeProvider>, children: [
      { path: "/orders", element: <InfiniteOrders /> },
    ] }], { initialEntries: ["/orders"] });
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup();

    await user.click(screen.getByRole("link", { name: "追加订单 order-2" }));
    const dialog = await screen.findByRole("dialog", { name: "记录 order-2" });
    const prev = () => within(dialog).getByRole("button", { name: "上一条" });
    const next = () => within(dialog).getByRole("button", { name: "下一条" });
    expect(prev()).toBeEnabled();
    expect(next()).toBeEnabled();

    next().focus();
    await user.keyboard("{Enter}");
    expect(prev()).toBeDisabled();
    expect(next()).toBeDisabled();
    expect(finishLoad).not.toBeNull();
    act(() => { finishLoad?.(); });

    await waitFor(() => expect(prev()).toBeEnabled());
    expect(next()).toBeDisabled();
    expect(dialog.querySelector("[data-overlay-heading]")).toHaveFocus();
  });
});
