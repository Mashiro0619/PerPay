import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DashboardChartType, SystemAnalytics } from "../src/api/client";
import { ChartAreaInteractive } from "../src/components/chart-area-interactive";

function analytics(days: 7 | 30 | 90 = 7, amount = 12345): SystemAnalytics {
  return {
    range_days: days,
    from: new Date(Date.UTC(2026, 9, 30 - days, -8)).toISOString(),
    to: "2026-10-29T16:00:00.000Z",
    orders: {
      created: 28,
      confirmed: 1,
      unpaid: 27,
      disputed: 0,
      closed: 0,
      expired: 0,
    },
    confirmations: { count: 1, amount_cents: amount },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 27, exceptions: 0, conflicts: 0, notifications: 0 },
    daily: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 30 - days + index))
        .toISOString()
        .slice(0, 10),
      orders_created: index === 2 ? 28 : 0,
      confirmed_amount_cents: index === 2 ? amount : 0,
      confirmations: index === 2 ? 1 : 0,
      notifications_acknowledged: 0,
      notifications_failed: 0,
    })),
  };
}

const typeLabels = { AREA: "面积图", BAR: "柱状图", LINE: "折线图" } as const;

function expectSelectedType(
  type: DashboardChartType,
  container: HTMLElement,
  hasPlot = true,
) {
  const group = screen.getByRole("group", { name: "图表类型" });
  for (const [value, label] of Object.entries(typeLabels)) {
    expect(within(group).getByRole("button", { name: label })).toHaveAttribute(
      "aria-pressed",
      String(value === type),
    );
  }
  const plot = container.querySelector('[data-slot="chart"]');
  if (hasPlot) expect(plot).toHaveAttribute("data-chart-type", type);
  else expect(plot).toBeNull();
}

describe("trend chart visit preferences", () => {
  it("adopts a saved chart default that arrives after the initial loading render", () => {
    const onRangeChange = vi.fn();
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={undefined}
        range={7}
        pending
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("AREA", container, false);

    rerender(
      <ChartAreaInteractive
        analytics={analytics()}
        chartType="BAR"
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("BAR", container);

    rerender(
      <ChartAreaInteractive
        analytics={analytics()}
        chartType="LINE"
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container);
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it("retains a manual chart choice through data refreshes, period loads and saved-setting changes", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={analytics()}
        chartType="AREA"
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "折线图" }));
    expectSelectedType("LINE", container);

    rerender(
      <ChartAreaInteractive
        analytics={analytics(7, 67890)}
        chartType="AREA"
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container);
    expect(container.querySelector("[data-metric-value]")).toHaveTextContent(
      "¥678.90",
    );

    await user.click(screen.getByRole("button", { name: "近 30 天" }));
    expect(onRangeChange).toHaveBeenCalledExactlyOnceWith("30");
    rerender(
      <ChartAreaInteractive
        analytics={undefined}
        chartType="BAR"
        range={30}
        pending
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container, false);

    rerender(
      <ChartAreaInteractive
        analytics={analytics(30)}
        chartType="BAR"
        range={30}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container);
    rerender(
      <ChartAreaInteractive
        analytics={analytics(30)}
        chartType="AREA"
        range={30}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container);
  });

  it("keeps a choice made while the saved default is still loading", async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={undefined}
        range={7}
        pending
        onRangeChange={onRangeChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "折线图" }));
    rerender(
      <ChartAreaInteractive
        analytics={analytics()}
        chartType="BAR"
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expectSelectedType("LINE", container);
  });

  it("preserves the chart and metric choices when visiting the daily data and its second page", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChartAreaInteractive
        analytics={analytics(30)}
        chartType="BAR"
        range={30}
        pending={false}
        onRangeChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "折线图" }));
    await user.click(screen.getByRole("button", { name: "新建订单" }));
    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(
      screen.queryByRole("group", { name: "图表类型" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "第 2/3 页 · 共 30 天",
    );

    await user.click(screen.getByRole("tab", { name: "图表" }));
    expectSelectedType("LINE", container);
    expect(screen.getByRole("button", { name: "新建订单" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(container.querySelector("[data-metric-value]")).toHaveTextContent(
      "28",
    );
    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "第 2/3 页 · 共 30 天",
    );
  });

  it("never clears the single chart selection when its selected button is clicked again", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChartAreaInteractive
        analytics={analytics()}
        range={7}
        pending={false}
        onRangeChange={vi.fn()}
      />,
    );
    for (const type of ["AREA", "BAR", "LINE"] as const) {
      const button = screen.getByRole("button", { name: typeLabels[type] });
      await user.click(button);
      await user.click(button);
      expectSelectedType(type, container);
    }
  });

  it("hides stale chart and statistics during loading in both views", async () => {
    const user = userEvent.setup();
    const data = analytics();
    const onRangeChange = vi.fn();
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={data}
        range={7}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expect(container.querySelector("[data-metric-value]")).toHaveTextContent(
      "¥123.45",
    );
    expect(container.querySelector('[data-slot="chart"]')).not.toBeNull();

    rerender(
      <ChartAreaInteractive
        analytics={data}
        range={30}
        pending
        onRangeChange={onRangeChange}
      />,
    );
    expect(container.querySelector('[data-slot="chart"]')).toBeNull();
    expect(
      container.querySelector('[data-chart-state="loading"]'),
    ).not.toBeNull();
    expect(container.querySelector(".trend-summary")).not.toHaveTextContent(
      /¥|123\.45|20\.58/,
    );
    expect(container.querySelector("[data-metric-value]")?.textContent).toBe(
      "",
    );
    expect(screen.getByText("正在读取近 30 天…")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("region", { name: "每日数据" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      screen.queryByRole("table", { name: "每日收款数据" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("¥123.45")).not.toBeInTheDocument();

    rerender(
      <ChartAreaInteractive
        analytics={analytics(30, 67890)}
        range={30}
        pending={false}
        onRangeChange={onRangeChange}
      />,
    );
    expect(screen.getByRole("region", { name: "每日数据" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "第 1/3 页 · 共 30 天",
    );
    await user.click(screen.getByRole("tab", { name: "图表" }));
    expect(container.querySelector("[data-metric-value]")).toHaveTextContent(
      "¥678.90",
    );
    expect(container.querySelector('[data-slot="chart"]')).not.toBeNull();
  });
});
