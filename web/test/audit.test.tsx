import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, parsePath, useLocation, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { auditActionLabel } from "../src/lib/audit";
import { switchWorkspaceHref } from "../src/lib/navigation-selection";
import Audit from "../src/pages/Audit";
import AuditDetail from "../src/pages/AuditDetail";
import AuditStatus from "../src/pages/AuditStatus";
import { auditEvent, aggregateEvent, auditDetail, auditMetadata, auditPage } from "./audit-fixtures";
import { json } from "./fixtures";
import { mobileMedia } from "./mobile-media";
import type { AuditEventDetail, AuditEventItem, AuditMetadata } from "../../src/shared/audit";

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output aria-label="审计地址">{location.pathname + location.search}</output>
    <output aria-label="分页状态">{JSON.stringify(location.state?.pagination)}</output>
    <button onClick={() => {
      const to = switchWorkspaceHref(location, "site_b");
      if (to) void navigate(to, { state: location.state });
    }}>选择网站 B</button>
  </>;
}
function mount(path = "/audit", state?: unknown) {
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[{ ...parsePath(path), state }]}>
    <Routes><Route path="/audit" element={<Audit />} /><Route path="/audit/status" element={<AuditStatus />} /><Route path="/audit/:source/:eventId" element={<AuditDetail />} /></Routes>
    <Location />
  </MemoryRouter></QueryClientProvider>);
}
function backend(options: {
  list?: (request: Request) => Response | Promise<Response>;
  detail?: AuditEventDetail;
  metadata?: AuditMetadata;
} = {}) {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/audit-events/meta")) return json({ data: options.metadata ?? auditMetadata });
    if (/\/audit-events\/(?:core|activity)\//.test(path)) return json({ data: options.detail ?? auditDetail() });
    if (path.endsWith("/audit-events")) return options.list ? options.list(request) : json(auditPage());
    return json({ error: { code: "not_found", message: "未找到接口" } }, 404);
  }));
  return calls;
}
function listCalls(calls: Request[]) { return calls.filter(request => new URL(request.url).pathname.endsWith("/audit-events")); }

describe("audit log browsing", () => {
  it("keeps navigation selection separate from explicit website filters and uses the fixed server order", async () => {
    const calls = backend();
    mount("/audit?selected_site=site_a&site_id=site_b&category=configuration&outcome=SUCCESS&actor_type=ADMIN&source=core&action=settings.display_updated&source_address=192.0.2.25&created_from=2026-11-01&created_to=2026-11-01&q=配置&cursor=older&page=3");
    expect(await screen.findByRole("link", { name: "更新显示设置" })).toBeVisible();
    const query = new URL(listCalls(calls)[0]!.url).searchParams;
    expect(Object.fromEntries(query)).toEqual({ site_id: "site_b", category: "configuration", outcome: "SUCCESS", actor_type: "ADMIN", source: "core", action: "settings.display_updated", source_address: "192.0.2.25", created_from: "2026-11-01", created_to: "2026-11-01", q: "配置", limit: "20", cursor: "older" });
    expect(query.has("selected_site")).toBe(false);
    expect(query.has("sort_order")).toBe(false);
    expect(screen.queryByText(/核心审计持续保留/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "采集正常，查看采集状态" })).toBeVisible();
    expect(screen.queryByText("2026/11/01 10:03:59")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "关联网站" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "高级筛选" }));
    expect(screen.getByRole("combobox", { name: "关联网站" })).toHaveTextContent("历史网站（已删除）");
  });

  it("opens capture and export information without changing the saved list snapshot or filters", async () => {
    const calls = backend();
    mount("/audit?view=all&outcome=SUCCESS&cursor=older&page=3&selected_site=site_a");
    await screen.findByRole("link", { name: "更新显示设置" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "采集正常，查看采集状态" }));
    expect(await screen.findByRole("heading", { name: "审计采集状态" })).toBeVisible();
    expect(screen.getByText("2026/11/01 10:03:59")).toBeVisible();
    expect(screen.getByText("2026/11/01 10:04:00")).toBeVisible();
    expect(screen.getByText(/核心审计持续保留/)).toBeVisible();
    expect(screen.getByText(/最多 10,000 行/)).toBeVisible();
    expect(listCalls(calls)).toHaveLength(1);
    await user.click(screen.getByRole("link", { name: "审计日志" }));
    await screen.findByRole("link", { name: "更新显示设置" });
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("/audit?view=all&outcome=SUCCESS&cursor=older&page=3&selected_site=site_a");
    expect(listCalls(calls)).toHaveLength(1);
    expect(listCalls(calls).every(request => !new URL(request.url).searchParams.has("snapshot_at"))).toBe(true);
  });

  it("defaults to core audit and switches all five views without sending the view marker to the API", async () => {
    const calls = backend();
    mount("/audit?selected_site=site_a");
    await screen.findByRole("link", { name: "更新显示设置" });
    expect(new URL(listCalls(calls)[0]!.url).searchParams.get("source")).toBe("core");
    expect(screen.getByRole("tab", { name: "操作审计" })).toHaveAttribute("aria-selected", "true");
    const user = userEvent.setup();
    for (const [label, source, category] of [
      ["接口访问", "activity", "requests"], ["后台任务", "activity", "background"],
      ["维护活动", null, "maintenance"], ["全部记录", null, null],
    ] as const) {
      const previous = listCalls(calls).length;
      await user.click(screen.getByRole("tab", { name: label }));
      await waitFor(() => expect(listCalls(calls)).toHaveLength(previous + 1));
      const query = new URL(listCalls(calls).at(-1)!.url).searchParams;
      expect(query.get("source")).toBe(source);
      expect(query.get("category")).toBe(category);
      expect(query.has("view")).toBe(false);
      expect(screen.getByLabelText("审计地址")).toHaveTextContent("selected_site=site_a");
    }
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("view=all");
  });

  it("starts with eight columns and exposes optional technical fields through one display menu", async () => {
    const calls = backend();
    mount();
    await screen.findByRole("link", { name: "更新显示设置" });
    const table = screen.getByRole("table", { name: "审计日志列表" });
    expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["时间", "事件", "执行者", "网站", "IP", "客户端", "结果", "详情"]);
    expect(screen.getByRole("combobox", { name: "发生日期范围" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "操作结果" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "操作类别" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示列" })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "列表显示" }));
    const display = await screen.findByRole("dialog", { name: "列表显示" });
    await user.click(within(display).getByRole("checkbox", { name: "方法" }));
    await user.keyboard("{Escape}");
    expect(within(table).getByRole("columnheader", { name: "方法" })).toBeVisible();
    expect(within(table).getByText("PUT")).toBeVisible();
    expect(listCalls(calls)).toHaveLength(1);
  });

  it("restores the filtered cursor after detail navigation and refreshes back to the newest first page", async () => {
    let firstPageReads = 0;
    const calls = backend({ list: request => {
      if (new URL(request.url).searchParams.has("cursor")) return json(auditPage([auditEvent]));
      firstPageReads++;
      return json(auditPage([aggregateEvent], "older"));
    } });
    mount("/audit?outcome=SUCCESS&selected_site=site_a");
    await screen.findByRole("link", { name: "接口查询" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(await screen.findByRole("link", { name: "更新显示设置" }));
    expect(await screen.findByRole("heading", { name: "审计日志详情" })).toBeVisible();
    await user.click(screen.getByRole("link", { name: "审计日志" }));
    await screen.findByRole("link", { name: "更新显示设置" });
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("cursor=older");
    expect(listCalls(calls)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("link", { name: "接口查询" });
    await waitFor(() => expect(firstPageReads).toBe(2));
    expect(screen.getByLabelText("审计地址")).not.toHaveTextContent("cursor=");
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("outcome=SUCCESS");
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("selected_site=site_a");
  });

  it("stages mobile filters together without inventing sort controls", async () => {
    mobileMedia();
    const calls = backend({ list: () => json(auditPage([aggregateEvent])) });
    mount("/audit?selected_site=site_a&cursor=older&page=3");
    await screen.findByRole("link", { name: "接口查询" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "筛选" }));
    const panel = await screen.findByRole("dialog", { name: "筛选" });
    expect(within(panel).queryByRole("combobox", { name: "排序字段" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("group", { name: "排序方向" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("combobox", { name: "操作类别" }));
    await user.click(await screen.findByRole("option", { name: "配置变更" }));
    await user.type(within(panel).getByRole("textbox", { name: "来源 IP" }), "2001:db8::25");
    expect(listCalls(calls)).toHaveLength(1);
    await user.click(within(panel).getByRole("button", { name: "应用" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    const query = new URL(listCalls(calls).at(-1)!.url).searchParams;
    expect(query.get("category")).toBe("configuration");
    expect(query.get("source_address")).toBe("2001:db8::25");
    expect(query.has("cursor")).toBe(false);
    expect(query.has("sort_by")).toBe(false);
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("selected_site=site_a");
  });

  it("keeps the current sidebar site when returning to an independently filtered audit page", async () => {
    const calls = backend();
    const pagination = { cursor: { scope: "/audit?q=a+b&site_id=site_a:cursor", firstPage: 2, cursors: ["newer", "older"] } };
    mount("/audit?site_id=site_a&selected_site=site_a&cursor=older&page=3&q=a%20b", { pagination });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "更新显示设置" }));
    await screen.findByRole("heading", { name: "审计日志详情" });
    await user.click(screen.getByRole("button", { name: "选择网站 B" }));
    await user.click(screen.getByRole("link", { name: "审计日志" }));
    await screen.findByRole("link", { name: "更新显示设置" });
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("/audit?site_id=site_a&cursor=older&page=3&q=a%20b&selected_site=site_b");
    expect(screen.getByLabelText("分页状态")).toHaveTextContent(JSON.stringify(pagination));
    expect(listCalls(calls)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "上一页" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(new URL(listCalls(calls)[1]!.url).searchParams.get("cursor")).toBe("newer");
    expect(screen.getByLabelText("审计地址")).toHaveTextContent("selected_site=site_b");
  });

  it("shows each source/category label once and retains unknown action identifiers", async () => {
    backend({ list: () => json(auditPage([{ ...aggregateEvent, action: "future.action" }])) });
    mount();
    expect(await screen.findByRole("link", { name: "future.action" })).toBeVisible();
    expect(screen.getAllByText("接口访问", { exact: true })).toHaveLength(1);
  });

  it("does not replace a newer filter result with a late response", async () => {
    let finish!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { finish = resolve; });
    backend({ list: request => new URL(request.url).searchParams.get("q") ? json(auditPage([aggregateEvent])) : delayed });
    mount();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("searchbox", { name: "审计日志关键词搜索" }), "新筛选");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    expect(await screen.findByRole("link", { name: "接口查询" })).toBeVisible();
    await act(async () => finish(json(auditPage([auditEvent]))));
    expect(screen.queryByRole("link", { name: "更新显示设置" })).not.toBeInTheDocument();
  });

  it("creates a fresh snapshot when applying a previously viewed filter again", async () => {
    let unfilteredReads = 0;
    backend({ list: request => {
      if (new URL(request.url).searchParams.has("q")) return json(auditPage([aggregateEvent]));
      unfilteredReads++;
      return json(auditPage([auditEvent]));
    } });
    mount();
    await screen.findByRole("link", { name: "更新显示设置" });
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "审计日志关键词搜索" }), "查询");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByRole("link", { name: "接口查询" });
    await user.click(screen.getByRole("button", { name: "清除搜索和筛选" }));
    await screen.findByRole("link", { name: "更新显示设置" });
    await waitFor(() => expect(unfilteredReads).toBe(2));
  });

  it("shows a failed read as an error rather than an empty audit history", async () => {
    backend({ list: () => json({ error: { code: "audit_unavailable", message: "审计记录暂时无法读取" } }, 503) });
    mount();
    expect(await screen.findByText("审计记录暂时无法读取")).toBeVisible();
    expect(screen.queryByText("暂无符合条件的日志")).not.toBeInTheDocument();
  });

  it("retains capture gap evidence alongside readable saved events", async () => {
    backend({ metadata: { ...auditMetadata, capture: { ...auditMetadata.capture, state: "degraded", dropped_events: 4, write_failures: 2, spool_gap_count: 1 } } });
    mount();
    expect(await screen.findByText("部分活动日志未完整记录")).toBeVisible();
    expect(screen.getByText("未记录活动：4 条")).toBeVisible();
    expect(await screen.findByRole("link", { name: "更新显示设置" })).toBeVisible();
  });

  it("does not claim a successful write before the first healthy capture flush", async () => {
    backend({ metadata: { ...auditMetadata, capture: { ...auditMetadata.capture, last_flush_at: null, buffered_events: 2 } } });
    mount();
    await userEvent.click(await screen.findByRole("link", { name: "采集正常，查看采集状态" }));
    expect(await screen.findByText("等待首次成功写入")).toBeVisible();
    expect(screen.getByText("等待写入").parentElement).toHaveTextContent("2 条");
    expect(screen.getByText("最近成功写入").parentElement).toHaveTextContent("等待首次成功写入");
    expect(screen.queryByText("2026/11/01 10:03:59")).not.toBeInTheDocument();
  });
});

describe("audit event details", () => {
  it("keeps core identifiers and absent timings inside a technical dialog that returns focus on Escape", async () => {
    const subjectId = "session-private-identifier";
    backend({ detail: { ...auditDetail(), action: "admin.login", category: "identity", subject_type: "admin_session", subject_id: subjectId, duration_ms: null, http_method: null, route: null, http_status: null } });
    mount(`/audit/core/${auditEvent.event_id}`);
    const summary = await screen.findByRole("group", { name: "日志概况" });
    expect(within(summary).getByText("登录会话")).toBeVisible();
    expect(screen.queryByText(subjectId, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("HTTP 方法")).not.toBeInTheDocument();
    expect(screen.queryByText("耗时")).not.toBeInTheDocument();
    expect(screen.queryByText(/客户端名称根据 User-Agent/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "审计日志技术信息" });
    await user.click(trigger);
    const technical = await screen.findByRole("dialog", { name: "审计日志技术信息" });
    const data = within(technical).getByLabelText("审计日志技术信息", { selector: "pre" });
    expect(data).toHaveTextContent(subjectId);
    expect(data).toHaveTextContent('"duration_ms": null');
    expect(data).toHaveTextContent('"http_method": null');
    expect(within(technical).getByText(/客户端名称根据 User-Agent/)).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "审计日志技术信息" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("group", { name: "日志概况" })).toBe(summary);
  });
  it.each([
    { source_type: "HTTP", http_status: 202, outcome: "SUCCESS", is_aggregate: false, label: "已接受" },
    { source_type: "BACKGROUND", http_status: null, outcome: "SUCCESS", is_aggregate: false, label: "本轮完成" },
    { source_type: "BACKGROUND", http_status: null, outcome: "SUCCESS", is_aggregate: true, label: "运行成功" },
    { source_type: "MAINTENANCE", http_status: null, outcome: "SUCCESS", is_aggregate: false, label: "已完成" },
    { source_type: "HTTP", http_status: 202, outcome: "FAILURE", is_aggregate: false, label: "失败" },
    { source_type: "CORE", http_status: 200, outcome: "SUCCESS", is_aggregate: false, action: "audit.export_generated", label: "文件已生成" },
    { source_type: "CORE", http_status: 200, outcome: "SUCCESS", is_aggregate: false, action: "orders.export_generated", label: "文件已生成" },
  ] satisfies (Pick<AuditEventItem, "source_type" | "http_status" | "outcome" | "is_aggregate"> & { label: string; action?: string })[])("keeps the $source_type result '$label' consistent between list and detail", async ({ label, ...result }) => {
    const event: AuditEventItem = { ...aggregateEvent, ...result };
    backend({ list: () => json(auditPage([event])), detail: auditDetail(event) });
    mount();
    const link = await screen.findByRole("link", { name: auditActionLabel(event.action) });
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    await userEvent.click(link);
    const summary = await screen.findByRole("group", { name: "日志概况" });
    expect(within(summary).getByText(label, { exact: true })).toBeVisible();
  });

  it("shows safe configuration changes and keeps suppressed values out of the technical view", async () => {
    const detail = { ...auditDetail(), changes: [
      { field: "display.system_name", kind: "value" as const, before: "旧名称", after: "新名称" },
      { field: "private_key", kind: "redacted_change" as const, configured_before: true, configured_after: true, before: "suppressed-before", after: "suppressed-after" },
    ], related_activity_available: false };
    backend({ detail });
    mount(`/audit/core/${auditEvent.event_id}`);
    expect(await screen.findByText("旧名称")).toBeVisible();
    expect(screen.getByText("新名称")).toBeVisible();
    expect(screen.getByText("已更换（值不记录）")).toBeVisible();
    const changes = screen.getByRole("group", { name: "配置变更" });
    expect(within(changes).getAllByRole("listitem")).toHaveLength(2);
    expect(within(changes).queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getByText(/关联活动当前不可用/)).toBeVisible();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "审计日志技术信息" });
    await user.click(trigger);
    const technical = await screen.findByRole("dialog", { name: "审计日志技术信息" });
    expect(within(technical).getByLabelText("审计日志技术信息", { selector: "pre" })).toBeVisible();
    expect(screen.queryByText(/suppressed-before|suppressed-after/)).not.toBeInTheDocument();
    await user.click(within(technical).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "审计日志技术信息" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("group", { name: "配置变更" })).toBe(changes);
  });

  it("keeps historical request context absent and omits an empty change section", async () => {
    backend({ detail: { ...auditDetail(), source_address: null, user_agent: null, context_recorded: false } });
    mount(`/audit/core/${auditEvent.event_id}`);
    await screen.findByRole("group", { name: "来源与请求" });
    expect(screen.getAllByText("当时未记录").length).toBeGreaterThan(0);
    expect(screen.queryByRole("group", { name: "配置变更" })).not.toBeInTheDocument();
    expect(screen.queryByText("c".repeat(64))).not.toBeInTheDocument();
  });

  it("shows the stored account check failure and links directly to the checked account", async () => {
    const detail = { ...auditDetail(), action: "alipay_account.checked", outcome: "FAILURE" as const,
      subject_type: "alipay_account", subject_id: "account-checked", details: { reason: "支付宝查询权限不足，请检查应用授权。" } };
    backend({ detail });
    mount(`/audit/core/${auditEvent.event_id}`);
    expect(await screen.findByText(detail.details.reason)).toBeVisible();
    expect(screen.getByRole("link", { name: "查看收款账号" })).toHaveAttribute("href", "/settings/accounts/account-checked");
    expect(screen.queryByRole("group", { name: "配置变更" })).not.toBeInTheDocument();
  });

  it("identifies activity aggregates and calculates the average from the total duration", async () => {
    backend({ detail: auditDetail({ ...aggregateEvent, first_occurred_at: "2026-11-01T02:03:01.000Z" }) });
    mount(`/audit/activity/${aggregateEvent.event_id}`);
    const group = await screen.findByRole("group", { name: "活动汇总" });
    expect(within(group).getByRole("heading", { name: "活动汇总 · 5 次" })).toBeVisible();
    expect(within(group).getByText("100 ms")).toBeVisible();
    expect(within(group).getByText("20 ms")).toBeVisible();
    expect(screen.getByText("curl 客户端")).toBeVisible();
    expect(screen.getByRole("link", { name: "示例网站" })).toHaveAttribute("href", "/sites/site_a/summary");
    expect(within(group).getByText("2026/11/01 10:03:01")).toBeVisible();
    expect(within(group).getByText("2026/11/01 10:03:54")).toBeVisible();
    const summary = screen.getByRole("group", { name: "日志概况" });
    expect(within(summary).getByText("排序时间")).toBeVisible();
    expect(within(summary).getByText("2026/11/01 10:03:05")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "审计日志技术信息" }));
    const technical = await screen.findByRole("dialog", { name: "审计日志技术信息" });
    expect(within(technical).getByText(/活动汇总，不对应单次请求/)).toBeVisible();
    expect(within(technical).getByText("汇总组编号")).toBeVisible();
    expect(within(technical).getByText("aggregate-group-identifier")).toBeVisible();
  });

  it("keeps the actual request source when an HTTP read triggers a system operation", async () => {
    backend({ detail: { ...auditDetail(), actor_type: "SYSTEM", action: "orders.checkout_expired", category: "orders", http_method: "GET" } });
    mount(`/audit/core/${auditEvent.event_id}`);
    const source = await screen.findByRole("group", { name: "来源与请求" });
    expect(within(source).getByText("192.0.2.25")).toBeVisible();
    expect(within(source).getByText("Chrome · Windows")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "审计日志技术信息" }));
    const technical = await screen.findByRole("dialog", { name: "审计日志技术信息" });
    expect(within(technical).getByLabelText("审计日志技术信息", { selector: "pre" })).toHaveTextContent(auditEvent.user_agent!);
  });

  it.each([
    { source_type: "CORE", context_recorded: false, http_method: null, route: null, request_id: null, label: "当时未记录" },
    { source_type: "CORE", context_recorded: true, http_method: "GET", route: "/api/v1/orders/{orderId}", request_id: "http-request", label: "未记录" },
    { source_type: "CORE", context_recorded: true, http_method: null, route: null, request_id: "http-request", label: "未记录" },
    { source_type: "BACKGROUND", context_recorded: false, http_method: null, route: null, request_id: null, label: "不适用" },
  ] satisfies (Pick<AuditEventItem, "source_type" | "context_recorded" | "http_method" | "route" | "request_id"> & { label: string })[])("shows missing SYSTEM context as '$label' for $source_type with method $http_method", async ({ label, ...context }) => {
    backend({ detail: { ...auditDetail(), ...context, actor_type: "SYSTEM", source_address: null, user_agent: null, http_status: null } });
    mount(`/audit/core/${auditEvent.event_id}`);
    const source = await screen.findByRole("group", { name: "来源与请求" });
    const field = within(source).getByText("来源 IP").parentElement!;
    expect(within(field).getByText(label, { exact: true })).toBeVisible();
    const client = within(source).getByText("设备 / 客户端").parentElement!;
    expect(within(client).getByText(label, { exact: true })).toBeVisible();
  });
});
