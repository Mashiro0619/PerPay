import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { onlineManager } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryClient } from "../src/api/client";
import { presentSystemStatus } from "../src/lib/system-status";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";
import { apiError, json } from "./fixtures";
function ready() {
  const data = systemStatus();
  data.ledger.conflicts = {
    provider_account_key: "test",
    open: 0,
    resolved: 0,
    ignored: 0,
    total: 0,
    by_type: [],
  };
  data.reconciliation.exceptions = {
    provider_account_key: "test",
    open: 0,
    resolved: 0,
    total: 0,
  };
  return data;
}
describe("shared runtime presentation", () => {
  it("keeps the current snapshot during a navigation refresh and removes it if that refresh fails", async () => {
    let defer = false;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const view = mountOnboarding({
      stage: 4,
      path: "/system",
      status: () => ready(),
      handle: request => defer && request.url.endsWith("/system/status") ? pending : undefined,
    });
    const table = await screen.findByRole("table", { name: "运行环节" });
    const reads = () => view.fetchMock.mock.calls.filter(([request]) => request.url.endsWith("/system/status")).length;
    expect(reads()).toBe(1);

    defer = true;
    await act(async () => { await view.router.navigate("/system?inspection=1"); });
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.getByRole("table", { name: "运行环节" })).toBe(table);
    expect(screen.queryByText("正在读取运行状态…")).not.toBeInTheDocument();
    await act(async () => { finish(apiError("unavailable", "状态读取失败", 503)); });
    expect(await screen.findByText("暂时无法确认运行状态")).toBeVisible();
    expect(screen.queryByRole("table", { name: "运行环节" })).not.toBeInTheDocument();
  });

  it("keeps the global snapshot and its DOM through selection-only navigation, hash changes and history", async () => {
    const view = mountOnboarding({
      stage: 4,
      path: "/system?selected_site=a#health",
      status: () => ready(),
      handle: request => {
        const match = /\/sites\/([ab])$/.exec(new URL(request.url).pathname);
        return match ? json({ data: { client_id: match[1], configuration: { name: "网站 " + match[1] }, deleted_at: null } }) : undefined;
      },
    });
    const table = await screen.findByRole("table", { name: "运行环节" });
    const reads = () => view.fetchMock.mock.calls.filter(([request]) => request.url.endsWith("/system/status")).length;
    expect(reads()).toBe(1);
    for (const destination of ["/system?selected_site=b#health", "/system?selected_site=b#backup", -1, -1, "/system#health"] as const) {
      await act(async () => {
        if (typeof destination === "number") await view.router.navigate(destination);
        else await view.router.navigate(destination);
      });
      expect(screen.getByRole("table", { name: "运行环节" })).toBe(table);
      expect(reads()).toBe(1);
    }
  });

  it.each(["visibility", "network"] as const)("requires a fresh snapshot after a %s epoch and ignores the previous epoch's late response", async kind => {
    const available = kind === "visibility"
      ? vi.spyOn(document, "hidden", "get").mockReturnValue(false)
      : vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const changeAvailability = (value: boolean) => {
      available.mockReturnValue(kind === "visibility" ? !value : value);
      if (kind === "visibility") fireEvent(document, new Event("visibilitychange"));
      else fireEvent(window, new Event(value ? "online" : "offline"));
    };
    let defer = false;
    const pending: Array<(response: Response) => void> = [];
    const view = mountOnboarding({
      stage: 4,
      path: "/system",
      status: () => ready(),
      handle: request => defer && request.url.endsWith("/system/status")
        ? new Promise<Response>(resolve => pending.push(resolve))
        : undefined,
    });
    try {
      await screen.findByRole("table", { name: "运行环节" });
      defer = true;
      await act(async () => { await view.router.navigate("/system?inspection=1"); });
      await waitFor(() => expect(pending).toHaveLength(1));
      act(() => changeAvailability(false));
      expect(screen.queryByRole("table", { name: "运行环节" })).not.toBeInTheDocument();
      expect(await screen.findByText("暂时无法确认运行状态")).toBeVisible();
      await act(async () => { await view.router.navigate("/system?inspection=2"); });
      expect(pending).toHaveLength(1);

      act(() => changeAvailability(true));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(screen.queryByRole("table", { name: "运行环节" })).not.toBeInTheDocument();
      await act(async () => { pending[0]!(json({ data: ready() })); });
      expect(screen.queryByRole("table", { name: "运行环节" })).not.toBeInTheDocument();
      expect(screen.getByText("正在读取运行状态…")).toBeInTheDocument();
      await act(async () => { pending[1]!(json({ data: ready() })); });
      expect(await screen.findByRole("table", { name: "运行环节" })).toBeVisible();
    } finally {
      available.mockRestore();
      onlineManager.setOnline(true);
    }
  });

  it("treats incomplete successful status responses as unavailable without crashing protected forms", async () => {
    mountOnboarding({stage:4,path:"/settings/collection-policy",handle:r=>r.url.endsWith("/system/status") ? json({data:{status:"ready",configured:true,database:{ok:true}}}) : undefined});
    expect(await screen.findByLabelText("查账有效时限（秒）")).toBeVisible();
    expect(await screen.findByText("状态未知")).toBeVisible();
    expect(screen.queryByText("页面加载失败")).not.toBeInTheDocument();
  });
  it.each([
    undefined,
    { total: 0, financial_exceptions: 0, ledger_conflicts: 0 },
    { total: -1, financial_exceptions: 0, ledger_conflicts: -1, notification_failures: 0 },
    { total: 0, financial_exceptions: 1, ledger_conflicts: 0, notification_failures: 0 },
  ])("does not treat an incomplete or invalid reminder summary as zero (%j)", async workItems => {
    mountOnboarding({ stage: 4, path: "/system", handle: request => request.url.endsWith("/system/status")
      ? json({ data: { ...ready(), work_items: workItems } }) : undefined });
    expect(await screen.findByText("暂时无法确认运行状态")).toBeVisible();
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("状态未知");
    expect(screen.queryByRole("table", { name: "运行环节" })).not.toBeInTheDocument();
  });

  it("does not label business backlog as a failed collection or confirmation worker", () => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 5;
    data.reconciliation.exceptions!.open = 3;
    data.webhook.dead_letters = 2;
    data.work_items = { total: 10, financial_exceptions: 3, ledger_conflicts: 5, notification_failures: 2 };
    expect(presentSystemStatus(data)).toMatchObject({
      canReceive: true,
      runtimeWarning: false,
      businessPending: true,
      ledgerHealthy: true,
      reconciliationHealthy: true,
      webhookHealthy: true,
      notice: "有待处理提醒",
    });
  });
  it.each(["ledger", "reconciliation", "webhook"] as const)(
    "keeps real %s failures distinct even alongside backlog",
    (kind) => {
      const data = ready();
      data.status = "degraded";
      data.ledger.conflicts!.open = 4;
      data.work_items = { total: 4, financial_exceptions: 0, ledger_conflicts: 4, notification_failures: 0 };
      data[kind].last_error_code = "failure";
      data[kind].consecutive_failures = 1;
      expect(presentSystemStatus(data)).toMatchObject({
        canReceive: true,
        runtimeWarning: true,
        businessPending: true,
        notice: "有运行告警",
      });
    },
  );
  it("does not turn ignored diagnostic totals into either pending notices or a generic runtime warning", () => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 2;
    data.reconciliation.exceptions!.open = 1;
    data.webhook.dead_letters = 3;
    expect(presentSystemStatus(data)).toMatchObject({
      canReceive: true,
      businessPending: false,
      runtimeWarning: false,
      notice: null,
    });
  });
  it("includes actionable retry and older-account reminders even when current raw totals are zero", () => {
    const data = ready();
    data.work_items = { total: 2, financial_exceptions: 1, ledger_conflicts: 0, notification_failures: 1 };
    expect(presentSystemStatus(data)).toMatchObject({ businessPending: true, runtimeWarning: false, notice: "有待处理提醒" });
  });
  it.each(["ledger", "reconciliation", "webhook"] as const)("does not hide an actual %s failure after all reminders are ignored", kind => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 2;
    data[kind].enabled = true;
    data[kind].state = "degraded";
    data[kind].last_error_code = "transport_timeout";
    data[kind].consecutive_failures = 1;
    expect(presentSystemStatus(data)).toMatchObject({ businessPending: false, runtimeWarning: true, notice: "有运行告警" });
  });
  it("reports unavailable reminder counts instead of claiming there are none", async () => {
    const data = ready();
    data.work_items = null;
    data.status = "degraded";
    data.ledger.conflicts!.open = 2;
    mountOnboarding({ stage: 4, path: "/system", status: () => data });
    await screen.findByRole("table", { name: "运行环节" });
    expect(screen.getByText(/提醒统计暂不可用/)).toBeVisible();
    expect(screen.queryByText(/暂无待处理提醒|业务待处理已处理完毕/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("需关注");
    expect(screen.queryByText("有业务提醒待处理")).not.toBeInTheDocument();
  });

  it("keeps unknown degraded causes and backup recovery visible, but adds no normal decoration", () => {
    expect(presentSystemStatus(ready()).notice).toBeNull();
    const data = ready();
    data.status = "degraded";
    expect(presentSystemStatus(data).notice).toBe("有运行告警");
    data.status = "ready";
    data.backup.enabled = false;
    data.backup.recovery_required = true;
    expect(presentSystemStatus(data).runtimeWarning).toBe(true);
  });
  it.each([
    ["recovery_required", /实例需要恢复/],
    ["configuration_mismatch", /备份配置与运行状态不一致/],
    ["clock_moved_backwards", /系统时钟发生回退/],
  ] as const)("shows %s directly even when scheduled backups are disabled", async (flag, message) => {
    const data = ready();
    data.backup.enabled = false;
    data.backup.ok = false;
    data.backup[flag] = true;
    expect(presentSystemStatus(data)).toMatchObject({ canReceive: true, runtimeWarning: true });
    mountOnboarding({ stage: 4, path: "/system", status: () => data });
    const runtime = within(await screen.findByRole("table", { name: "运行环节" }));
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("需关注");
    expect(screen.queryByText("已暂停接收新订单")).not.toBeInTheDocument();
    const backup = within(runtime.getByRole("rowheader", { name: "自动备份" }).closest("tr")!);
    expect(runtime.getByText(message)).toBeVisible();
    expect(backup.getByRole("link", { name: "备份设置" })).toHaveAttribute("href", "/settings/backup");
  });
  it("keeps the readiness gate regardless of whether workers have recent errors", () => {
    for (const field of ["database", "ledger", "reconciliation"]) {
      const data = ready();
      if (field === "database") data.database.ok = false;
      else if (field === "ledger") data.ledger.collection_ready = false;
      else data.reconciliation.confirmation_ready = false;
      expect(presentSystemStatus(data)).toMatchObject({
        canReceive: false,
        notice: "已暂停接收新订单",
      });
    }
  });
  it("shows the missing configuration and its recovery entry in a compact pause alert", async () => {
    const data = ready();
    data.status = "not_ready";
    data.configured = false;
    mountOnboarding({ stage: 4, path: "/system", status: () => data });
    await screen.findByRole("table", { name: "运行环节" });
    const alert = within(screen.getByRole("alert"));
    expect(alert.getByText("已暂停接收新订单")).toBeVisible();
    expect(alert.getByText(/收款配置.*未完成/)).toBeVisible();
    expect(alert.getByRole("link", { name: "继续配置" })).toHaveAttribute("href", "/settings/onboarding");
  });
  it("shows an actual confirmation failure directly without adding a payment pause", async () => {
    const data = ready();
    data.status = "degraded";
    data.reconciliation.last_error_code = "reconciliation_storage_error";
    data.reconciliation.consecutive_failures = 2;
    mountOnboarding({ stage: 4, path: "/system", status: () => data });
    const runtime = within(await screen.findByRole("table", { name: "运行环节" }));
    const reconciliation = within(runtime.getByRole("rowheader", { name: "自动确认收款" }).closest("tr")!);
    expect(reconciliation.getByRole("cell", { name: "需关注" })).toBeVisible();
    expect(runtime.getByText(/自动确认收款记录暂时无法读取或保存/)).toBeVisible();
    expect(runtime.queryByText(/reconciliation_storage_error/)).not.toBeInTheDocument();
    expect(runtime.getByText(/连续失败 2 次/)).toBeVisible();
    const diagnosis = reconciliation.getByRole("button", { name: "自动确认收款运行诊断" });
    await userEvent.setup().click(diagnosis);
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText(/reconciliation_storage_error/)).toBeVisible();
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(diagnosis).toHaveFocus());
    expect(reconciliation.queryByRole("button", { name: "查看自动确认收款详情" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("需关注");
    expect(screen.queryByText("已暂停接收新订单")).not.toBeInTheDocument();
  });
  it("shows non-blocking backlog only in navigation without adding a homepage banner", async () => {
    const data = ready();
    data.status = "degraded";
    data.ledger.conflicts!.open = 2;
    data.work_items = { total: 2, financial_exceptions: 0, ledger_conflicts: 2, notification_failures: 0 };
    const view = mountOnboarding({ stage: 4, path: "/", status: () => data });
    expect(
      await screen.findByText("待处理", { selector: "[data-runtime-notice] [data-slot=badge]" }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }),
    ).toHaveAccessibleDescription("待处理");
    expect(screen.queryByText("可以收款，有运行告警")).not.toBeInTheDocument();
    expect(screen.queryByText("已暂停接收新订单")).not.toBeInTheDocument();
    const reads = () =>
      view.fetchMock.mock.calls.filter(([r]) =>
        r.url.endsWith("/system/status"),
      ).length;
    expect(reads()).toBe(1);
    await userEvent
      .setup()
      .click(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }));
    await screen.findByRole("table", { name: "运行环节" });
    expect(reads()).toBe(2);
    await userEvent
      .setup()
      .click(screen.getByRole("link", { name: "总览" }));
    await screen.findByRole("heading", { name: "收款趋势" });
    await waitFor(() => expect(reads()).toBe(3));
  });
  it("clears and restores the navigation notice without changing runtime health or raw evidence", async () => {
    let ignored = false;
    const item = {
      type: "FINANCIAL_EXCEPTION", status: "OPEN", exception_type: "UNMATCHED_CREDIT",
      resource_id: "00000000-0000-4000-8000-000000000021", provider_account_key: "test",
      order_id: null, ledger_entry_id: null, candidate_id: null,
      created_at: "2026-09-06T12:00:00Z", actionable_at: "2026-09-06T12:00:00Z",
      ignored_at: null, ignored_by: null, ended: false,
      detail_url: "/api/admin/v1/reconciliation/exceptions/00000000-0000-4000-8000-000000000021",
    };
    const data = ready();
    data.status = "degraded";
    data.reconciliation.exceptions!.open = 1;
    data.reconciliation.exceptions!.total = 1;
    const view = mountOnboarding({
      stage: 4, path: "/work-items",
      status: () => ({ ...data, work_items: { total: ignored ? 0 : 1, financial_exceptions: ignored ? 0 : 1, ledger_conflicts: 0, notification_failures: 0 } }),
      handle: request => {
        const path = new URL(request.url).pathname;
        if (path === "/api/admin/v1/work-items" && request.method === "GET") {
          const showIgnored = new URL(request.url).searchParams.get("visibility") === "IGNORED";
          return json({ data: showIgnored === ignored ? [{ ...item, ignored_at: ignored ? "2026-09-07T12:00:00Z" : null, ignored_by: ignored ? "admin" : null }] : [], page: { next_cursor: null } });
        }
        if (path.endsWith("/work-items/actions/ignore-all")) {
          return request.json().then(body => {
            ignored = true;
            return json({ data: { ...body, ignored_count: 1 } });
          });
        }
        if (path.endsWith("/actions/restore")) {
          return request.json().then(body => {
            ignored = false;
            return json({ data: { ...body, type: item.type, resource_id: item.resource_id, restored: true } });
          });
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "收入尚未匹配订单" });
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("待处理"));
    await user.click(screen.getByRole("button", { name: "忽略全部筛选结果（跨页）" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认忽略" }));
    await screen.findByText("暂无待处理提醒");
    await waitFor(() => expect(document.querySelector("[data-runtime-notice]")).toBeNull());
    await user.click(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }));
    const runtime = within(await screen.findByRole("table", { name: "运行环节" }));
    expect(screen.queryByText("有业务提醒待处理")).not.toBeInTheDocument();
    expect(screen.queryByText("有运行告警")).not.toBeInTheDocument();
    const reconciliation = within(runtime.getByRole("rowheader", { name: "自动确认收款" }).closest("tr")!);
    expect(reconciliation.getByRole("cell", { name: "正常" })).toBeVisible();
    expect(reconciliation.queryByText("待核对订单 0")).not.toBeInTheDocument();
    expect(reconciliation.queryByRole("button", { name: "查看自动确认收款详情" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "待处理" }));
    await user.click(screen.getByRole("button", { name: "已忽略" }));
    await screen.findByRole("link", { name: "收入尚未匹配订单" });
    await user.click(screen.getByRole("button", { name: "恢复提醒" }));
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("待处理"));
    await user.click(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }));
    const restoredRuntime = within(await screen.findByRole("table", { name: "运行环节" }));
    expect(within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" })).toHaveAccessibleDescription("待处理");
    const restoredReconciliation = within(restoredRuntime.getByRole("rowheader", { name: "自动确认收款" }).closest("tr")!);
    expect(restoredReconciliation.getByRole("cell", { name: "正常" })).toBeVisible();
    expect(screen.queryByText("有业务提醒待处理")).not.toBeInTheDocument();
    expect(screen.queryByText("有运行告警")).not.toBeInTheDocument();
    expect(data.reconciliation.exceptions!.open).toBe(1);
    expect(view.writes()).toHaveLength(2);
  });

  it("removes a previously normal system panel after a failed refresh rather than presenting it as current", async () => {
    let failed = false;
    mountOnboarding({
      stage: 4,
      path: "/system",
      status: () => ready(),
      handle: (r) =>
        failed && r.url.endsWith("/system/status")
          ? apiError("unavailable", "状态读取失败", 503)
          : undefined,
    });
    await screen.findByRole("table", { name: "运行环节" });
    expect(document.querySelector("[data-runtime-notice]")).toBeNull();
    failed = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["status", "shared"] });
    });
    expect(await screen.findByText("暂时无法确认运行状态")).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "运行环节" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "全局管理" })).getByRole("link", { name: "运行状态" }),
    ).toHaveAccessibleDescription("状态未知");
  });
});
