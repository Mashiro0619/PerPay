import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  queryClient,
  type RuntimeSettings,
  type SystemStatus,
} from "../src/api/client";
import { ReadinessCheck } from "../src/pages/Onboarding";
import { TestPaymentProvider } from "../src/components/test-payment-provider";
import { apiError, json } from "./fixtures";
import {
  configuredThrough,
  instanceId,
  systemStatus,
} from "./onboarding-fixture";

function mount(
  read: () => Response | Promise<Response> = () =>
    json({ data: systemStatus() }),
  settings: RuntimeSettings = configuredThrough(4),
) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const fetchMock = vi.fn(read);
  vi.stubGlobal("fetch", fetchMock);
  const onReload = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestPaymentProvider>
          <ReadinessCheck
            settings={settings}
            instanceId={instanceId}
            onReload={onReload}
          />
        </TestPaymentProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, fetchMock, onReload };
}

function completeStatus() {
  const status = systemStatus();
  status.ledger.conflicts = {
    provider_account_key: "synthetic-provider",
    open: 0,
    resolved: 0,
    ignored: 0,
    total: 0,
    by_type: [],
  };
  status.reconciliation.exceptions = {
    provider_account_key: "synthetic-provider",
    open: 0,
    resolved: 0,
    total: 0,
  };
  return status;
}

describe("onboarding payment readiness", () => {
  it.each([
    "configured",
    "database",
    "collection",
    "confirmation",
    "not_ready",
  ])("does not report success when %s is not ready", async (missing) => {
    const status = systemStatus();
    if (missing === "configured") status.configured = false;
    if (missing === "database") status.database.ok = false;
    if (missing === "collection") status.ledger.collection_ready = false;
    if (missing === "confirmation")
      status.reconciliation.confirmation_ready = false;
    if (missing === "not_ready") status.status = "not_ready";
    const { fetchMock } = mount(() => json({ data: status }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("收款配置已完成，可以收款。"),
    ).not.toBeInTheDocument();
  });
  it("separates completed setup from an unexplained degraded runtime status", async () => {
    const status = { ...completeStatus(), status: "degraded" as const };
    const { fetchMock } = mount(() => json({ data: status }));
    expect(await screen.findByText("收款配置已完成，可以收款。")).toBeVisible();
    expect(screen.getByText("运行提醒（不是配置缺项）")).toBeVisible();
    expect(
      screen.getByText(/系统返回了运行告警，但未提供可定位的原因/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "查看运行状态" })).toHaveAttribute(
      "href",
      "/system",
    );
    expect(
      screen.queryByText("可以收款，仍有事项待处理。"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入控制台" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "小额真实测试" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("treats disabled optional notifications and backups as a completed setup", async () => {
    const settings = configuredThrough(4);
    settings.notifications.enabled = false;
    const status = completeStatus();
    status.webhook.enabled = false;
    status.backup.enabled = false;
    status.backup.ok = false;
    mount(() => json({ data: status }), settings);
    const title = await screen.findByText("收款配置已完成，可以收款。");
    expect(title.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByText("已通过")).toHaveLength(4);
    expect(
      screen.queryByText("运行提醒（不是配置缺项）"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/业务通知未启用（可选），不影响收款/),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "进入控制台" })).toBeVisible();
  });
  it("does not recreate ignored business reminders from a legacy degraded status", async () => {
    const status = completeStatus();
    status.status = "degraded";
    status.ledger.conflicts!.open = 4;
    status.reconciliation.exceptions!.open = 3;
    status.webhook.dead_letters = 2;
    mount(() => json({ data: status }));
    await screen.findByText("收款配置已完成，可以收款。");
    expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("运行提醒（不是配置缺项）"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "查看运行状态" }),
    ).not.toBeInTheDocument();
  });
  it.each(["ready", "degraded"] as const)(
    "shows actionable business counts independently of %s",
    async (overall) => {
      const status = completeStatus();
      status.status = overall;
      status.work_items = {
        total: 6,
        financial_exceptions: 2,
        ledger_conflicts: 1,
        notification_failures: 3,
      };
      mount(() => json({ data: status }));
      await screen.findByText("收款配置已完成，可以收款。");
      expect(screen.getByText("有 6 项业务待处理")).toBeVisible();
      expect(
        screen.getByText(/这些是业务记录提醒，不代表收款配置未完成/),
      ).toBeVisible();
      for (const [label, type] of [
        ["账务异常 2 项", "FINANCIAL_EXCEPTION"],
        ["账本冲突 1 项", "LEDGER_CONFLICT"],
        ["通知失败 3 项", "NOTIFICATION_FAILURE"],
      ])
        expect(screen.getByRole("link", { name: label })).toHaveAttribute(
          "href",
          "/work-items?type=" + type,
        );
      expect(
        screen.queryByText("运行提醒（不是配置缺项）"),
      ).not.toBeInTheDocument();
    },
  );
  it.each([
    ["ledger", "账本采集"],
    ["reconciliation", "自动确认"],
    ["webhook", "业务通知"],
  ] as const)(
    "keeps a real %s warning visible even after all business reminders are ignored",
    async (key, label) => {
      const status = completeStatus();
      status.status = "degraded";
      status.ledger.conflicts!.open = 2;
      status[key].last_error_code = "transport_timeout";
      status[key].consecutive_failures = 1;
      mount(() => json({ data: status }));
      await screen.findByText("收款配置已完成，可以收款。");
      expect(
        screen.getByText(label + "最近运行异常：transport_timeout。"),
      ).toBeVisible();
      expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "查看运行状态" }),
      ).toHaveAttribute("href", "/system");
    },
  );
  it.each([
    ["catching_up", "账本采集正在补处理历史数据。"],
    ["stopped", "账本采集任务已停止，请检查运行状态。"],
    ["degraded", "账本采集任务尚未恢复正常，请检查运行状态。"],
  ] as const)(
    "names a %s worker state rather than an unspecified outstanding task",
    async (state, message) => {
      const status = completeStatus();
      status.status = "degraded";
      status.ledger.state = state;
      mount(() => json({ data: status }));
      await screen.findByText("收款配置已完成，可以收款。");
      expect(screen.getByText(message)).toBeVisible();
    },
  );
  it("names the enabled backup task when it has not become healthy", async () => {
    const status = completeStatus();
    status.status = "degraded";
    status.backup.ok = false;
    mount(() => json({ data: status }));
    await screen.findByText("收款配置已完成，可以收款。");
    expect(
      screen.getByText("自动备份尚未就绪，请检查备份任务及最近结果。"),
    ).toBeVisible();
    expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
  });
  it.each([
    [
      "recovery_required",
      "备份状态提示实例需要恢复，请先查看运行状态和维护说明。",
    ],
    ["configuration_mismatch", "自动备份配置与运行状态不一致。"],
    ["clock_moved_backwards", "备份检测到服务器时间回拨，请检查系统时间。"],
  ] as const)(
    "keeps %s warnings even when scheduled backups are disabled",
    async (key, message) => {
      const status = completeStatus();
      status.status = "degraded";
      status.backup.enabled = false;
      status.backup[key] = true;
      mount(() => json({ data: status }));
      await screen.findByText("收款配置已完成，可以收款。");
      expect(screen.getByText(message)).toBeVisible();
    },
  );
  it("does not invent a pending count when work-item statistics are unavailable", async () => {
    const status = completeStatus();
    status.status = "degraded";
    status.work_items = null;
    mount(() => json({ data: status }));
    await screen.findByText("收款配置已完成，可以收款。");
    expect(
      screen.getByText("待处理事项统计暂不可用，暂时无法确认业务待办数量。"),
    ).toBeVisible();
    expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
  });
  it("identifies missing diagnostic summaries instead of guessing the warning cause", async () => {
    const status = systemStatus();
    status.status = "degraded";
    mount(() => json({ data: status }));
    await screen.findByText("收款配置已完成，可以收款。");
    expect(
      screen.getByText("部分业务状态统计暂不可用，请在运行状态页核对。"),
    ).toBeVisible();
  });
  it.each(["settings_revision", "payment_revision"] as const)(
    "does not display old warnings or business counts for a mismatched %s",
    async (key) => {
      const status = completeStatus();
      status[key] = 0;
      status.status = "degraded";
      status.backup.ok = false;
      status.work_items = {
        total: 2,
        financial_exceptions: 2,
        ledger_conflicts: 0,
        notification_failures: 0,
      };
      mount(() => json({ data: status }));
      await screen.findByText("配置已变化");
      expect(
        screen.queryByText("收款配置已完成，可以收款。"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("运行提醒（不是配置缺项）"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
    },
  );
  it("removes operational notices during a failed refresh and recovers from fresh status", async () => {
    let fail = false;
    const status = completeStatus();
    status.status = "degraded";
    status.backup.ok = false;
    status.work_items = {
      total: 1,
      financial_exceptions: 1,
      ledger_conflicts: 0,
      notification_failures: 0,
    };
    mount(() =>
      fail
        ? apiError("internal_error", "temporary outage", 503)
        : json({ data: status }),
    );
    await screen.findByText("运行提醒（不是配置缺项）");
    expect(screen.getByText("有 1 项业务待处理")).toBeVisible();
    fail = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByText("运行提醒（不是配置缺项）"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/项业务待处理/)).not.toBeInTheDocument();
    fail = false;
    status.status = "ready";
    status.backup.ok = true;
    status.work_items = {
      total: 0,
      financial_exceptions: 0,
      ledger_conflicts: 0,
      notification_failures: 0,
    };
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByText("收款配置已完成，可以收款。");
    expect(
      screen.queryByText("运行提醒（不是配置缺项）"),
    ).not.toBeInTheDocument();
  });
  it.each(["settings_revision", "payment_revision"] as const)(
    "rejects an outdated %s and offers explicit configuration reload",
    async (version) => {
      const status = systemStatus();
      status[version] = 0;
      const { onReload } = mount(() => json({ data: status }));
      await userEvent
        .setup()
        .click(await screen.findByRole("button", { name: "刷新配置" }));
      expect(onReload).toHaveBeenCalledOnce();
      expect(
        screen.queryByRole("link", { name: "进入控制台" }),
      ).not.toBeInTheDocument();
    },
  );
  it("requires a fresh response instead of trusting a cached green state", async () => {
    let finish: (response: Response) => void = () => {};
    const configured = configuredThrough(4);
    queryClient.setQueryData(
      [
        "onboarding",
        "readiness",
        instanceId,
        configured.revision,
        configured.payment_revision,
        0,
      ],
      { data: systemStatus() },
    );
    const { fetchMock } = mount(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      finish(json({ data: systemStatus() }));
    });
    expect(
      await screen.findByRole("link", { name: "进入控制台" }),
    ).toBeVisible();
  });
  it("removes previous success on a failed refresh and allows recovery", async () => {
    let fail = false;
    mount(() =>
      fail
        ? apiError("internal_error", "temporary outage", 503)
        : json({ data: systemStatus() }),
    );
    await screen.findByRole("link", { name: "进入控制台" });
    fail = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "刷新" }));
    expect(
      await screen.findByRole("link", { name: "进入控制台" }),
    ).toBeVisible();
  });
  it("polls every five seconds, pauses while hidden and refreshes on return", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.useFakeTimers();
    const { fetchMock, unmount } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByRole("link", { name: "进入控制台" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5010);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("invalidates old success immediately when offline", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mount();
    await screen.findByRole("link", { name: "进入控制台" });
    online.mockReturnValue(false);
    fireEvent(window, new Event("offline"));
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeDisabled();
    online.mockReturnValue(true);
    fireEvent(window, new Event("online"));
    expect(
      await screen.findByRole("link", { name: "进入控制台" }),
    ).toBeVisible();
  });
  it("does not show a late success while hidden", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finish: (response: Response) => void = () => {};
    const { fetchMock } = mount(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      finish(json({ data: systemStatus() }));
    });
    expect(
      screen.queryByRole("link", { name: "进入控制台" }),
    ).not.toBeInTheDocument();
  });
  it("exposes actual collection failure details rather than claiming platform access was verified", async () => {
    const status: SystemStatus = systemStatus();
    status.ledger.collection_ready = false;
    status.ledger.last_error_code = "provider_authentication_failed";
    status.status = "not_ready";
    mount(() => json({ data: status }));
    expect(
      await screen.findByText("最近错误：provider_authentication_failed"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "检查支付宝接入" }),
    ).toHaveAttribute("href", "/settings/onboarding/provider");
    expect(
      screen.queryByRole("link", { name: "小额真实测试" }),
    ).not.toBeInTheDocument();
  });
});
