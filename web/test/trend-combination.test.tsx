import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import { ChartAreaInteractive } from "../src/components/chart-area-interactive";
import { CHART_TYPE_STORAGE_KEY } from "../src/hooks/use-chart-type";

beforeEach(() => localStorage.removeItem(CHART_TYPE_STORAGE_KEY));

function analytics(days: 7 | 30 | 90 = 7): SystemAnalytics {
  return {
    range_days: days,
    from: "2026-05-31T16:00:00.000Z",
    to: new Date(Date.UTC(2026, 5, days + 1, -8)).toISOString(),
    orders: { created: 4321, confirmed: 1, unpaid: 4320, disputed: 0, closed: 0, expired: 0 },
    confirmations: { count: 1, amount_cents: 9876543 },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 4320, exceptions: 0, conflicts: 0, notifications: 0 },
    daily: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
      orders_created: index === 1 ? 1 : index === 2 ? 2 : 0,
      confirmed_amount_cents: index === 1 || index === 2 ? 10001 : 0,
      confirmations: index === 1 || index === 2 ? 1 : 0,
      notifications_acknowledged: 0,
      notifications_failed: 0,
    })),
  };
}

function plot(container: HTMLElement) {
  const chart = container.querySelector<HTMLElement>('[data-slot="chart"]');
  expect(chart).not.toBeNull();
  return chart!;
}

function value(summary: HTMLElement, metric: "amount" | "orders") {
  const total = summary.querySelector(`[data-metric-value][data-trend-metric="${metric}"]`);
  expect(total).not.toBeNull();
  return total!;
}

function application(container: HTMLElement) {
  const chart = container.querySelector<SVGElement>('svg[role="application"]');
  expect(chart).not.toBeNull();
  return chart!;
}

function waitForCombinedChart(container: HTMLElement) {
  return waitFor(() => {
    expect(container.querySelector('[data-chart-type="COMBINED"] svg[role="application"]')).not.toBeNull();
  });
}

async function expectTooltip(container: HTMLElement, date: string, amount: string, orders: string) {
  await waitFor(() => {
    const tooltip = container.querySelector<HTMLElement>(".recharts-tooltip-wrapper");
    expect(tooltip).toHaveTextContent(date.replaceAll("-", "/"));
    const amountRow = within(tooltip!).getByText("确认金额", { exact: true }).closest(".trend-tooltip-value")!;
    const ordersRow = within(tooltip!).getByText("新建订单", { exact: true }).closest(".trend-tooltip-value")!;
    expect(within(amountRow as HTMLElement).getByText(amount, { exact: true })).toBeVisible();
    expect(within(ordersRow as HTMLElement).getByText(new RegExp(`^${orders}(?: 笔)?$`))).toBeVisible();
    expect(ordersRow).not.toHaveTextContent("¥");
  });
}

describe("amount and order combination view", () => {
  it("keeps authoritative totals and the two plotted units independent", async () => {
    const { container } = render(<ChartAreaInteractive analytics={analytics()} range={7} pending={false} onRangeChange={vi.fn()} />);
    await screen.findByRole("application");
    await userEvent.setup().click(screen.getByRole("button", { name: "金额与订单" }));
    const summary = screen.getByLabelText("金额与订单汇总");
    expect(value(summary, "amount")).toHaveTextContent("¥98,765.43");
    expect(value(summary, "orders")).toHaveTextContent("4,321 笔");
    expect(summary.querySelectorAll("[data-metric-value]")).toHaveLength(2);
    expect(within(summary).getByText("确认金额", { exact: true })).toBeVisible();
    expect(within(summary).getByText("新建订单", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认金额" })).toHaveAccessibleDescription("¥98,765.43");
    expect(screen.getByRole("button", { name: "新建订单" })).toHaveAccessibleDescription("4,321 笔");
    expect(screen.getByRole("button", { name: "金额与订单" })).toHaveAccessibleDescription(/确认金额 ¥98,765\.43.*新建订单 4,321 笔/);
    expect(screen.queryByRole("group", { name: "图表类型" })).not.toBeInTheDocument();
    await waitForCombinedChart(container);
    const chart = plot(container);
    expect(chart.querySelectorAll(".recharts-bar")).toHaveLength(1);
    expect(chart.querySelectorAll(".recharts-line")).toHaveLength(1);
    expect(chart.querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    const amountTicks = [...chart.querySelectorAll("text.trend-combined-amount-tick")].map(tick => tick.textContent ?? "");
    const orderTicks = [...chart.querySelectorAll("text.trend-combined-orders-tick")].map(tick => tick.textContent ?? "");
    expect(amountTicks.length).toBeGreaterThan(1);
    expect(orderTicks.length).toBeGreaterThan(1);
    expect(amountTicks.every(label => label.startsWith("¥"))).toBe(true);
    expect(orderTicks.every(label => label.endsWith("笔") && !label.includes("¥"))).toBe(true);
    const amountMaximum = Math.max(...amountTicks.map(label => Number(label.slice(1).replaceAll(",", ""))));
    expect(amountMaximum).toBeGreaterThan(50);
    expect(amountMaximum).toBeLessThan(200);
    expect(Math.max(...orderTicks.map(label => Number(label.slice(0, -1))))).toBe(2);
    const barHeights = [...chart.querySelectorAll(".recharts-bar-rectangle .recharts-rectangle")]
      .map(rect => Number(rect.getAttribute("height")));
    const orderYs = [...chart.querySelectorAll(".recharts-line-dots circle")]
      .map(dot => Number(dot.getAttribute("cy")));
    expect(Math.max(...barHeights)).toBeGreaterThan(0);
    // Counts 0..2 must use their own scale even beside amounts exceeding 10,000 cents.
    expect(Math.max(...orderYs) - Math.min(...orderYs)).toBeGreaterThan(Math.max(...barHeights) / 4);
  });

  it("reads both values from the selected date, including separate sparse and zero days", async () => {
    const data = analytics();
    data.daily = data.daily.map((day, index) => ({ ...day,
      confirmed_amount_cents: index === 0 ? 1 : 0,
      orders_created: index === 1 ? 1234 : 0,
    }));
    const { container } = render(<ChartAreaInteractive analytics={data} range={7} pending={false} onRangeChange={vi.fn()} />);
    await screen.findByRole("application");
    await userEvent.setup().click(screen.getByRole("button", { name: "金额与订单" }));
    await waitForCombinedChart(container);
    const chart = application(container);
    fireEvent.focus(chart);
    await expectTooltip(container, "2026-06-01", "¥0.01", "0");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await expectTooltip(container, "2026-06-02", "¥0.00", "1,234");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await expectTooltip(container, "2026-06-03", "¥0.00", "0");
  });

  it("presents a real zero series without manufacturing amounts or an empty state", async () => {
    const data = analytics();
    data.confirmations = { count: 0, amount_cents: 0 };
    data.orders = { ...data.orders, created: 0, confirmed: 0, unpaid: 0 };
    data.daily = data.daily.map(day => ({ ...day, orders_created: 0, confirmed_amount_cents: 0, confirmations: 0 }));
    const { container } = render(<ChartAreaInteractive analytics={data} range={7} pending={false} onRangeChange={vi.fn()} />);
    await screen.findByRole("application");
    await userEvent.setup().click(screen.getByRole("button", { name: "金额与订单" }));
    const summary = screen.getByLabelText("金额与订单汇总");
    expect(value(summary, "amount")).toHaveTextContent("¥0.00");
    expect(value(summary, "orders")).toHaveTextContent("0 笔");
    expect(screen.queryByText("暂无每日数据")).not.toBeInTheDocument();
    await waitForCombinedChart(container);
    expect(plot(container).querySelectorAll(".recharts-yAxis")).toHaveLength(2);
    for (const bar of container.querySelectorAll(".recharts-bar-rectangle .recharts-rectangle")) {
      expect(Number(bar.getAttribute("height"))).toBe(0);
    }
    const chart = application(container);
    fireEvent.focus(chart);
    await expectTooltip(container, "2026-06-01", "¥0.00", "0");
  });

  it("keeps the keyboard choice, complete daily data and saved single-series type without writes", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const onRangeChange = vi.fn();
    const { container } = render(<ChartAreaInteractive analytics={analytics(30)} range={30} pending={false} onRangeChange={onRangeChange} />);
    await screen.findByRole("application");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "折线图" }));
    expect(localStorage.getItem(CHART_TYPE_STORAGE_KEY)).toBe("LINE");
    screen.getByRole("button", { name: "新建订单" }).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    const combined = screen.getByRole("button", { name: "金额与订单" });
    expect(combined).toHaveFocus();
    expect(combined).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Enter}");
    expect(combined).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "图表类型" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    const report = screen.getByRole("region", { name: "每日数据" });
    const dates = Array.from(report.querySelectorAll<HTMLTimeElement>(".daily-date time[datetime]"))
      .map(time => time.dateTime);
    expect(dates).toHaveLength(30);
    await user.click(screen.getByRole("tab", { name: "图表" }));
    expect(screen.getByRole("button", { name: "金额与订单" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(Array.from(report.querySelectorAll<HTMLTimeElement>(".daily-date time[datetime]"))
      .map(time => time.dateTime)).toEqual(dates);
    await user.click(screen.getByRole("tab", { name: "图表" }));
    await user.click(screen.getByRole("button", { name: "确认金额" }));
    expect(screen.getByRole("button", { name: "折线图" })).toHaveAttribute("aria-pressed", "true");
    expect(plot(container)).toHaveAttribute("data-chart-type", "LINE");
    expect(localStorage.getItem(CHART_TYPE_STORAGE_KEY)).toBe("LINE");
    expect(onRangeChange).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("retains the combination choice while another period loads and distinguishes unavailable totals", async () => {
    const onRangeChange = vi.fn();
    const { container, rerender } = render(<ChartAreaInteractive analytics={analytics()} range={7} pending={false} onRangeChange={onRangeChange} />);
    await screen.findByRole("application");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "金额与订单" }));
    await user.click(screen.getByRole("combobox", { name: "统计周期" }));
    await user.click(await screen.findByRole("option", { name: "近 30 天" }));
    expect(onRangeChange).toHaveBeenCalledExactlyOnceWith("30");
    rerender(<ChartAreaInteractive analytics={analytics()} range={30} pending onRangeChange={onRangeChange} />);
    expect(screen.getByRole("button", { name: "金额与订单" })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-slot="chart"]')).toBeNull();
    for (const total of screen.getByLabelText("金额与订单汇总").querySelectorAll("[data-metric-value]")) {
      expect(total.textContent).toBe("");
    }
    const refreshed = analytics(30);
    refreshed.confirmations.amount_cents = 123;
    refreshed.orders.created = 9;
    rerender(<ChartAreaInteractive analytics={refreshed} range={30} pending={false} onRangeChange={onRangeChange} />);
    expect(value(screen.getByLabelText("金额与订单汇总"), "amount")).toHaveTextContent("¥1.23");
    expect(value(screen.getByLabelText("金额与订单汇总"), "orders")).toHaveTextContent("9 笔");
    await waitForCombinedChart(container);
    expect(plot(container)).toBeInTheDocument();
    rerender(<ChartAreaInteractive analytics={undefined} range={30} pending={false} onRangeChange={onRangeChange} />);
    expect(screen.getByText("统计数据暂不可用")).toBeVisible();
    expect(value(screen.getByLabelText("金额与订单汇总"), "amount")).toHaveTextContent("—");
    expect(value(screen.getByLabelText("金额与订单汇总"), "orders")).toHaveTextContent("—");
    expect(screen.getByRole("button", { name: "金额与订单" })).toHaveAttribute("aria-pressed", "true");
  });
});
