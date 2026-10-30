import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient, type SystemAnalytics } from "../src/api/client";
import { apiError, json } from "./fixtures";
import { mountOnboarding, systemStatus } from "./onboarding-fixture";

function analytics(lastDay: 30 | 31): SystemAnalytics {
  return {
    range_days: 7,
    from: new Date(Date.UTC(2026, 9, lastDay - 6, -8)).toISOString(),
    to: new Date(Date.UTC(2026, 9, lastDay, 16)).toISOString(),
    orders: { created: 6, unpaid: 3, confirmed: 3, disputed: 0, closed: 0, expired: 0 },
    confirmations: { count: 3, amount_cents: 15401 },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: lastDay === 30 ? 3 : 0, exceptions: 0, conflicts: 0, notifications: 0 },
    daily: Array.from({ length: 7 }, (_, index) => {
      const day = lastDay - 6 + index;
      return {
        date: new Date(Date.UTC(2026, 9, day)).toISOString().slice(0, 10),
        orders_created: day === 30 ? 6 : 0,
        confirmations: day === 30 ? 2 : day === 28 ? 1 : 0,
        confirmed_amount_cents: day === 30 ? 12901 : day === 28 ? 2500 : 0,
        notifications_acknowledged: 0,
        notifications_failed: 0,
      };
    }),
  };
}

function mount() {
  // Change the Beijing calendar day without freezing query or UI timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T15:59:30.000Z"));
  let failed = false;
  let data = analytics(30);
  let responseGate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;
  const read = vi.fn(async () => {
    await responseGate;
    return failed ? apiError("internal_error", "统计刷新失败", 503) : json({ data });
  });
  mountOnboarding({
    stage: 4,
    path: "/?range=7",
    status: settings => ({
      ...systemStatus(settings),
      work_items: { total: 7, financial_exceptions: 7, ledger_conflicts: 0, notification_failures: 0 },
    }),
    handle: request => new URL(request.url).pathname === "/api/admin/v1/system/analytics" ? read() : undefined,
  });
  return {
    read,
    fail: () => { failed = true; },
    recover: () => { failed = false; data = analytics(31); },
    hold: () => { responseGate = new Promise<void>(resolve => { releaseGate = resolve; }); },
    release: () => { responseGate = undefined; releaseGate?.(); releaseGate = undefined; },
  };
}

function expectCurrent(amount: string, confirmations: string, pendingOrders: string) {
  const kpis = within(screen.getByText("今日确认金额", { exact: true }).closest("[data-overview-kpis]") as HTMLElement);
  for (const [title, value] of [
    ["今日确认金额", amount],
    ["今日收款确认笔数", confirmations],
    ["当前待付款", pendingOrders],
  ] as const) {
    const card = kpis.getByText(title, { exact: true }).closest('[data-slot="card"]') as HTMLElement;
    expect(within(card).getByText(value, { exact: true })).toBeVisible();
  }
  // This independent status read remains valid even if analytics are unavailable.
  const work = kpis.getByText("待处理", { exact: true }).closest('[data-slot="card"]') as HTMLElement;
  expect(within(work).getByRole("link")).toHaveTextContent(/^7$/);
}

function expectTrend(dates: string) {
  const card = screen.getByRole("heading", { name: "收款趋势" }).closest('[data-slot="card"]') as HTMLElement;
  const trend = within(card);
  expect(trend.getByText(dates, { exact: true })).toBeVisible();
  expect(within(trend.getByLabelText("确认金额汇总")).getByText("¥154.01", { exact: true })).toBeVisible();
}

afterEach(() => onlineManager.setOnline(true));

describe("dashboard analytics recovery", () => {
  it("clears current KPIs after a failed midnight refresh while retaining dated history, then recovers real zero values", async () => {
    const view = mount();
    await waitFor(() => expectCurrent("¥129.01", "2", "3"));
    expectTrend("2026-10-24 — 2026-10-30");

    vi.setSystemTime(new Date("2026-10-30T16:00:30.000Z"));
    view.fail();
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["analytics"] }); });
    expect(await screen.findByText("统计刷新失败", { exact: true })).toBeVisible();
    expectCurrent("—", "—", "—");
    expectTrend("2026-10-24 — 2026-10-30");
    expect(screen.getByText("更新未完成，以下保留上次成功读取的内容。", { exact: true })).toBeVisible();

    view.recover();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expectCurrent("¥0.00", "0", "0"));
    expectTrend("2026-10-25 — 2026-10-31");
    expect(screen.queryByText("统计刷新失败", { exact: true })).not.toBeInTheDocument();
    expect(view.read).toHaveBeenCalledTimes(3);
  });

  it("does not present cached KPIs as current while a refresh is paused offline, and resumes on reconnect", async () => {
    const view = mount();
    try {
      await waitFor(() => expectCurrent("¥129.01", "2", "3"));
      // A healthy background refresh must retain current values while awaiting its response.
      view.hold();
      let refreshed!: Promise<void>;
      act(() => { refreshed = queryClient.invalidateQueries({ queryKey: ["analytics"] }); });
      await waitFor(() => expect(view.read).toHaveBeenCalledTimes(2));
      expectCurrent("¥129.01", "2", "3");
      expectTrend("2026-10-24 — 2026-10-30");
      await act(async () => { view.release(); await refreshed; });

      vi.setSystemTime(new Date("2026-10-30T16:00:30.000Z"));
      act(() => {
        onlineManager.setOnline(false);
        void queryClient.invalidateQueries({ queryKey: ["analytics"] });
      });
      expect(await screen.findByText("等待网络恢复", { exact: true })).toBeVisible();
      expectCurrent("—", "—", "—");
      expectTrend("2026-10-24 — 2026-10-30");
      expect(view.read).toHaveBeenCalledTimes(2);

      view.recover();
      view.hold();
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(view.read).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByText("等待网络恢复", { exact: true })).not.toBeInTheDocument());
      // The resumed request has started, but the only available snapshot is still stale.
      expectCurrent("—", "—", "—");
      expectTrend("2026-10-24 — 2026-10-30");
      act(() => view.release());
      await waitFor(() => expectCurrent("¥0.00", "0", "0"));
      expectTrend("2026-10-25 — 2026-10-31");
      expect(view.read).toHaveBeenCalledTimes(3);
    } finally { view.release(); }
  });
});
