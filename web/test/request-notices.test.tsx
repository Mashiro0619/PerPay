import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, queryClient, type ListSiteOverviewResponse } from "../src/api/client";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../src/components/admin-dialog";
import { RequestNoticeBanner } from "../src/components/request-notice-banner";
import { QueryView } from "../src/components/request-state";
import { RequestNoticeProvider } from "../src/lib/request-notices";
import { apiError, json, order } from "./fixtures";
import { configuredThrough, mountOnboarding, systemStatus } from "./onboarding-fixture";

const reads = [
  ["session", "/api/admin/v1/session", "会话"],
  ["settings", "/api/admin/v1/settings", "设置"],
  ["status", "/api/admin/v1/system/status", "运行状态"],
  ["analytics", "/api/admin/v1/system/analytics", "统计"],
  ["orders", "/api/admin/v1/orders", "订单"],
  ["work-items", "/api/admin/v1/work-items", "待处理"],
  ["sites", "/api/admin/v1/sites", "网站"],
  ["site-overview", "/api/admin/v1/sites/overview", "网站概览"],
] as const;
type ReadKey = typeof reads[number][0];
type Handle = (request: Request) => Response | Promise<Response> | undefined;

function mountReads(path = "/", handle?: Handle) {
  const failed = new Set<ReadKey>();
  const counts = new Map<ReadKey, number>();
  const held = new Map<ReadKey, Promise<Response>>();
  const view = mountOnboarding({
    stage: 4,
    path,
    handle: request => {
      const endpoint = new URL(request.url).pathname;
      const read = request.method === "GET" && reads.find(([, path]) => path === endpoint);
      if (read) counts.set(read[0], (counts.get(read[0]) ?? 0) + 1);
      const override = handle?.(request);
      if (override !== undefined) return override;
      if (read) {
        if (held.has(read[0])) return held.get(read[0]);
        if (failed.has(read[0])) return json({ error: {
          code: "synthetic_backend_failure",
          message: read[2] + "读取暂不可用",
          // Distinct requests must share one notice even when their messages and IDs differ.
          request_id: `${read[0]}-${counts.get(read[0])}`,
        } }, 503);
      }
      if (endpoint === "/api/admin/v1/system/update")
        return apiError("update_check_unavailable", "官方更新源暂不可用", 503);
      if (endpoint === "/api/admin/v1/orders")
        return json({ data: [order], page: { next_cursor: null } });
      return undefined;
    },
  });
  return {
    ...view,
    failed,
    count: (key: ReadKey) => counts.get(key) ?? 0,
    hold(key: ReadKey) {
      let finish!: (response: Response) => void;
      held.set(key, new Promise(resolve => { finish = resolve; }));
      return (response: Response) => { held.delete(key); finish(response); };
    },
  };
}

async function refresh(...keys: ReadKey[]) {
  await act(async () => {
    await queryClient.refetchQueries({
      type: "active",
      predicate: query => keys.includes(query.queryKey[0] as ReadKey),
    });
  });
}

async function settled() {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
}

function runtimeLink() {
  return within(screen.getByRole("navigation", { name: "全局管理" }))
    .getByRole("link", { name: "运行状态" });
}

function currentAmount() {
  return within(screen.getByText("今日确认金额", { exact: true }).closest('[data-slot="card"]') as HTMLElement);
}

function NoticeRead({ read }: { read: () => Promise<string> }) {
  const query = useQuery({
    queryKey: ["notice-boundary-read"], queryFn: read,
    retry: false, retryOnMount: false, refetchOnMount: false, gcTime: Infinity,
  });
  return <QueryView query={query}>{value => <p>{value}</p>}</QueryView>;
}

function noticeShell(children: ReactNode, providerKey = "initial") {
  return <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <RequestNoticeProvider key={providerKey}>
        <RequestNoticeBanner />
        {children}
      </RequestNoticeProvider>
    </MemoryRouter>
  </QueryClientProvider>;
}

afterEach(() => onlineManager.setOnline(true));

describe("shared page request notices", () => {
  it("shows one warning for concurrent shell and page failures, retains unknown data, and retries each read once", async () => {
    const view = mountReads();
    await screen.findByRole("heading", { name: "收款趋势" });
    await settled();
    expect(currentAmount().getByText("¥0.00", { exact: true })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    for (const [key] of reads) view.failed.add(key);
    await refresh(...reads.map(([key]) => key));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(currentAmount().getByText("—", { exact: true })).toBeVisible();
    expect(runtimeLink()).toHaveAccessibleDescription("状态未知");
    const before = new Map(reads.map(([key]) => [key, view.count(key)]));
    for (const [key] of reads) expect(before.get(key)).toBeGreaterThan(1);

    view.failed.clear();
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await settled();
    expect(currentAmount().getByText("¥0.00", { exact: true })).toBeVisible();
    expect(runtimeLink()).not.toHaveAccessibleDescription("状态未知");
    for (const [key] of reads) expect(view.count(key), key).toBe(before.get(key)! + 1);
    expect(view.writes()).toHaveLength(0);
  });

  it("keeps the warning until every affected read recovers, including a later failed retry", async () => {
    const view = mountReads("/settings/display");
    await screen.findByRole("link", { name: "编辑界面显示" });
    await settled();
    view.failed.add("settings");
    view.failed.add("status");
    await refresh("settings", "status");
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));

    view.failed.delete("status");
    const finish = view.hold("settings");
    const statusReads = view.count("status");
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(view.count("status")).toBe(statusReads + 1));
    await waitFor(() => expect(runtimeLink()).not.toHaveAccessibleDescription("状态未知"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await act(async () => { finish(apiError("synthetic_backend_failure", "设置仍然无法读取", 503)); });
    expect(await screen.findByRole("alert")).toHaveTextContent("设置仍然无法读取");

    view.failed.clear();
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("removes an unmounted page's notice without letting its cached error clear another failure or return later", async () => {
    const view = mountReads("/orders");
    await screen.findByRole("searchbox", { name: "订单关键词搜索" });
    await settled();
    view.failed.add("orders");
    await refresh("orders");
    await screen.findByRole("alert");

    await act(async () => { await view.router.navigate("/settings/display"); });
    await screen.findByRole("link", { name: "编辑界面显示" });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["orders"] })
      .some(query => query.state.status === "error" && !query.isActive())).toBe(true);

    view.failed.add("status");
    await refresh("status");
    expect(await screen.findByRole("alert")).toHaveTextContent("运行状态读取暂不可用");
    act(() => { queryClient.removeQueries({ queryKey: ["orders"] }); });
    expect(screen.getByRole("alert")).toHaveTextContent("运行状态读取暂不可用");
    view.failed.clear();
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await act(async () => { await view.router.navigate("/orders"); });
    await screen.findByRole("searchbox", { name: "订单关键词搜索" });
    await settled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("combines offline page reads into one notice and keeps runtime data unknown until reconnection finishes", async () => {
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const view = mountReads();
    await screen.findByRole("heading", { name: "收款趋势" });
    await settled();
    view.failed.add("analytics");
    await refresh("analytics");
    await screen.findByRole("alert", { name: "服务连接提示" });
    const before = new Map(reads.map(([key]) => [key, view.count(key)]));
    act(() => {
      online = false;
      onlineManager.setOnline(false);
      fireEvent(window, new Event("offline"));
      void queryClient.invalidateQueries({ predicate: query => reads.some(([key]) => query.queryKey[0] === key) });
    });
    expect(await screen.findByText("等待网络恢复", { exact: true })).toBeVisible();
    expect(screen.getAllByText("等待网络恢复", { exact: true })).toHaveLength(1);
    expect(screen.getAllByRole("status", { name: "服务连接提示" })).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(currentAmount().getByText("—", { exact: true })).toBeVisible();
    expect(runtimeLink()).toHaveAccessibleDescription("状态未知");
    for (const [key] of reads) expect(view.count(key), key).toBe(before.get(key));

    view.failed.clear();
    const finish = view.hold("status");
    act(() => {
      online = true;
      onlineManager.setOnline(true);
      fireEvent(window, new Event("online"));
    });
    await waitFor(() => expect(view.count("status")).toBeGreaterThan(before.get("status")!));
    expect(runtimeLink()).toHaveAccessibleDescription("正在检查状态");
    await act(async () => { finish(json({ data: systemStatus(configuredThrough(4)) })); });
    await settled();
    await waitFor(() => expect(screen.queryByText("等待网络恢复", { exact: true })).not.toBeInTheDocument());
    expect(runtimeLink()).not.toHaveAccessibleDescription("状态未知");
    expect(currentAmount().getByText("¥0.00", { exact: true })).toBeVisible();
  });

  it.each([422, 503])("retains a local %s save failure and its draft when the shared read warning is retried", async status => {
    const view = mountReads("/settings/display/edit", request => request.method === "PUT"
      ? json({ error: {
        code: status === 422 ? "validation_failed" : "synthetic_save_failure",
        message: "设置保存未完成",
        ...(status === 422 ? { fields: { system_name: "名称不符合要求" } } : {}),
      } }, status)
      : undefined);
    const name = await screen.findByRole("textbox", { name: "支付系统名称" });
    const form = name.closest("form")!;
    fireEvent.change(name, { target: { value: "需要保留的设置草稿" } });
    fireEvent.submit(form);
    const local = await within(status === 422 ? form : screen.getByRole("dialog").querySelector<HTMLElement>("[data-overlay-footer]")!).findByRole("alert");
    if (status === 422) {
      expect(name).toHaveAttribute("aria-invalid", "true");
      expect(name).toHaveAccessibleDescription("名称不符合要求");
    } else expect(local).toHaveTextContent("设置保存未完成");

    view.failed.add("settings");
    await refresh("settings");
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const shared = screen.getAllByRole("alert").find(alert => alert !== local)!;
    view.failed.clear();
    await userEvent.click(within(shared).getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    expect(local).toBeVisible();
    expect(name).toHaveValue("需要保留的设置草稿");
    expect(view.writes()).toHaveLength(1);
    if (status === 422) expect(name).toHaveAccessibleDescription("名称不符合要求");
  });

  it("retries a failed next page with its original cursor while retaining the already loaded websites", async () => {
    let failed = true;
    const cursors: Array<string | null> = [];
    mountReads("/", request => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/admin/v1/sites/overview") return undefined;
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor && failed) return apiError("synthetic_backend_failure", "下一页网站读取失败", 503);
      return json({
        period: { from: "2026-10-01", to: "2026-10-30" },
        max_confirmed_amount_cents: 100,
        data: [{ client_id: cursor ? "second" : "first", name: cursor ? "第二页网站" : "第一页网站",
          accepting_orders: true, notifications_enabled: false, confirmed_count: 1,
          confirmed_amount_cents: 100, pending_orders: 0, work_items: 0 }],
        page: { next_cursor: cursor ? null : "second-page" },
      } satisfies ListSiteOverviewResponse);
    });
    await userEvent.click(await screen.findByRole("button", { name: "加载更多网站汇总" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("下一页网站读取失败");
    expect(screen.getByRole("link", { name: "第一页网站，查看网站总览" })).toBeVisible();
    failed = false;
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("link", { name: "第二页网站，查看网站总览" })).toBeVisible();
    expect(screen.getByRole("link", { name: "第一页网站，查看网站总览" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(cursors).toEqual([null, "second-page", "second-page"]);
  });

  it("keeps Retry-After anchored to the failed read across rerenders and remounts before allowing one retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
    const error = new ApiError(new Response(null, { status: 503, headers: { "Retry-After": "5" } }), {
      error: { code: "synthetic_backend_failure", message: "读取暂不可用" },
    });
    let failed = true;
    const read = vi.fn(async () => {
      if (failed) throw error;
      return "读取已恢复";
    });
    const view = render(noticeShell(<NoticeRead read={read} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    let notice = screen.getByRole("alert", { name: "服务连接提示" });
    expect(notice).toHaveTextContent("5 秒后可重试。");
    expect(within(notice).getByRole("button", { name: "重试" })).toBeDisabled();
    fireEvent.click(within(notice).getByRole("button", { name: "重试" }));
    expect(read).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(990); });
    view.rerender(noticeShell(<NoticeRead read={read} />));
    expect(screen.getByRole("alert", { name: "服务连接提示" })).toHaveTextContent("4 秒后可重试。");
    view.rerender(noticeShell(null, "unmounted"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    view.rerender(noticeShell(<NoticeRead read={read} />, "remounted"));
    notice = screen.getByRole("alert", { name: "服务连接提示" });
    expect(notice).toHaveTextContent("2 秒后可重试。");
    const retry = within(notice).getByRole("button", { name: "重试" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(read).toHaveBeenCalledOnce();

    failed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(retry).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(retry).toBeEnabled();
    await act(async () => {
      fireEvent.click(retry);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText("读取已恢复")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it("keeps a dialog's page-scoped query failure and its recovery inside the active modal", async () => {
    const error = new ApiError(new Response(null, { status: 503 }), {
      error: { code: "synthetic_backend_failure", message: "凭据读取暂不可用" },
    });
    let failed = true;
    const read = vi.fn(async () => {
      if (failed) throw error;
      return "凭据已恢复";
    });
    render(noticeShell(<Dialog open>
      <DialogContent>
        <DialogHeader><DialogTitle>查看凭据</DialogTitle></DialogHeader>
        <DialogBody><NoticeRead read={read} /></DialogBody>
      </DialogContent>
    </Dialog>));
    const dialog = await screen.findByRole("dialog", { name: "查看凭据" });
    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent("凭据读取暂不可用");
    expect(notice).toBeVisible();
    expect(screen.getAllByRole("alert", { hidden: true })).toHaveLength(1);
    const retry = within(notice).getByRole("button", { name: "重试" });
    expect(retry).toBeVisible();
    failed = false;
    await userEvent.click(retry);
    expect(await within(dialog).findByText("凭据已恢复")).toBeVisible();
    expect(screen.queryByRole("alert", { hidden: true })).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
