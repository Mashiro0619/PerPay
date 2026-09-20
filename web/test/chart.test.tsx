import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import { ChartAreaInteractive } from "../src/components/chart-area-interactive";
function analytics(days: 7 | 30 | 90 = 7): SystemAnalytics {
  return {
    range_days: days,
    from: "2026-06-01",
    to: "2026-09-01",
    orders: {
      created: 28,
      confirmed: 2,
      unpaid: 26,
      disputed: 0,
      closed: 0,
      expired: 0,
    },
    confirmations: { count: 2, amount_cents: 10001 },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 26, exceptions: 0, conflicts: 0, notifications: 0 },
    daily: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
      orders_created: index === 1 ? 2000 : index,
      confirmed_amount_cents: index === 2 ? 1 : index === days - 1 ? 10000 : 0,
      confirmations: index === 2 || index === days - 1 ? 1 : 0,
      notifications_acknowledged: 0,
      notifications_failed: 0,
    })),
  };
}

describe("official shadcn interactive chart", () => {
  it.each([
    ["AREA", ".recharts-area"],
    ["BAR", ".recharts-bar"],
    ["LINE", ".recharts-line"],
  ] as const)(
    "uses the configured %s chart with the same money and keyboard layer",
    async (chartType, selector) => {
      const { container } = render(
        <ChartAreaInteractive
          analytics={analytics()}
          range={7}
          onRangeChange={vi.fn()}
          pending={false}
          chartType={chartType}
        />,
      );
      expect(container.querySelector("[data-slot=chart]")).toHaveAttribute(
        "data-chart-type",
        chartType,
      );
      expect(container.querySelectorAll(selector)).toHaveLength(1);
      expect(
        container.querySelector('svg[role="application"]'),
      ).toHaveAttribute("tabindex", "0");
      expect(container.querySelector("[data-slot=chart] style")).toBeNull();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "每日数据" }));
      expect(screen.getAllByRole("row")).toHaveLength(8);
      expect(screen.getByText("¥0.01")).toBeVisible();
      expect(screen.getByText("¥100.00")).toBeVisible();
    },
  );
  it.each([7, 30, 90] as const)(
    "renders one financial series and an exact daily table for %i days",
    async (days) => {
      const { container } = render(
        <ChartAreaInteractive
          analytics={analytics(days)}
          range={days}
          onRangeChange={vi.fn()}
          pending={false}
        />,
      );
      expect(screen.getByRole("heading", { name: "收款趋势" })).toBeVisible();
      expect(container.querySelectorAll("[data-slot=chart]")).toHaveLength(1);
      expect(container.querySelector("[data-slot=chart] style")).toBeNull();
      expect(container.querySelector(".chart-line")).toBeNull();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "每日数据" }));
      expect(screen.getAllByRole("row")).toHaveLength(days + 1);
      const last = screen.getAllByRole("row").at(-1)!;
      expect(within(last).getByText("¥100.00")).toBeVisible();
      expect(within(last).getAllByRole("cell")).toHaveLength(4);
      expect(
        screen.getByRole("columnheader", { name: "确认次数" }),
      ).toBeVisible();
    },
  );
  it("switches period through the official toggle group without fetching records itself", async () => {
    const change = vi.fn();
    render(
      <ChartAreaInteractive
        analytics={analytics()}
        range={7}
        onRangeChange={change}
        pending={false}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "近 30 天" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("30");
  });
  it("switches counts and currency instead of stacking incompatible units", async () => {
    const { container } = render(
      <ChartAreaInteractive
        analytics={analytics()}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    const user = userEvent.setup();
    const metrics = screen.getByRole("group", { name: "趋势指标" });
    await user.click(within(metrics).getByRole("button", { name: "新建订单" }));
    expect(
      within(metrics).getByRole("button", { name: "新建订单" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(metrics).getByRole("button", { name: "确认金额" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector("[data-slot=chart]")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("每日新建订单"),
    );
    expect(container.querySelectorAll(".recharts-area")).toHaveLength(1);
  });
  it("does not relabel old data as the requested period", () => {
    const { container } = render(
      <ChartAreaInteractive
        analytics={undefined}
        range={90}
        onRangeChange={vi.fn()}
        pending
      />,
    );
    expect(screen.getByText("正在读取近 90 天…")).toBeVisible();
    expect(container.querySelector("[data-slot=chart]")).toBeNull();
    expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull();
  });
  it("uses the Recharts keyboard accessibility layer and default tooltip", async () => {
    const { container } = render(
      <ChartAreaInteractive
        analytics={analytics()}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    const application = container.querySelector<SVGElement>(
      'svg[role="application"]',
    )!;
    expect(application).not.toBeNull();
    expect(application).toHaveAttribute("tabindex", "0");
    fireEvent.focus(application);
    fireEvent.keyDown(application, { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        container.querySelector(".recharts-tooltip-wrapper"),
      ).not.toBeNull(),
    );
  });
  it("retains an opened daily table while periods change and renders empty data without inventing values", async () => {
    const { rerender } = render(
      <ChartAreaInteractive
        analytics={analytics(7)}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "每日数据" }));
    rerender(
      <ChartAreaInteractive
        analytics={analytics(30)}
        range={30}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(31);
    rerender(
      <ChartAreaInteractive
        analytics={{ ...analytics(), daily: [] }}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    expect(screen.getByText("暂无数据")).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });
  it.each(["AREA", "BAR", "LINE"] as const)(
    "uses only the plotted %s series in a separated currency tooltip",
    async (chartType) => {
      const data = analytics();
      data.daily = data.daily.map((day) => ({
        ...day,
        confirmed_amount_cents: 132443,
      }));
      const { container } = render(
        <ChartAreaInteractive
          analytics={data}
          chartType={chartType}
          range={7}
          onRangeChange={vi.fn()}
          pending={false}
        />,
      );
      const chart = container.querySelector<SVGElement>(
        'svg[role="application"]',
      )!;
      fireEvent.focus(chart);
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      await waitFor(() =>
        expect(
          container.querySelector(".recharts-tooltip-wrapper"),
        ).toHaveTextContent("¥1,324.43"),
      );
      const tooltip = container.querySelector<HTMLElement>(
        ".recharts-tooltip-wrapper",
      )!;
      expect(
        within(tooltip).getByText("确认金额", { exact: true }),
      ).toBeVisible();
      expect(
        within(tooltip).getByText("¥1,324.43", { exact: true }),
      ).toHaveClass("whitespace-nowrap", "tabular-nums");
      expect(within(tooltip).queryByText("确认次数")).not.toBeInTheDocument();
      expect(within(tooltip).queryByText("新建订单")).not.toBeInTheDocument();
    },
  );
});
