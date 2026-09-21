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
import { DailyAnalytics } from "../src/components/daily-analytics";
import { SectionCards } from "../src/components/section-cards";
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
      const metrics = screen.getByRole("group", { name: "趋势指标" });
      expect(metrics.closest("[data-slot=card-header]")).not.toBeNull();
      expect(
        within(metrics).getByRole("button", { name: "确认金额" }),
      ).toHaveAccessibleDescription("¥100.01");
      expect(
        within(metrics).getByRole("button", { name: "新建订单" }),
      ).toHaveAccessibleDescription("28");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    },
  );
  it.each([7, 30, 90] as const)(
    "renders one financial series and authoritative summary values for %i days",
    (days) => {
      const data = analytics(days);
      const { container } = render(
        <ChartAreaInteractive
          analytics={data}
          range={days}
          onRangeChange={vi.fn()}
          pending={false}
        />,
      );
      expect(screen.getByRole("heading", { name: "收款趋势" })).toBeVisible();
      expect(container.querySelectorAll("[data-slot=chart]")).toHaveLength(1);
      expect(container.querySelector("[data-slot=chart] style")).toBeNull();
      expect(
        screen.getByRole("button", { name: "确认金额" }),
      ).toHaveAccessibleDescription("¥100.01");
      // The aggregate contract, not a browser recomputation of the daily rows, owns the totals.
      expect(
        screen.getByRole("button", { name: "新建订单" }),
      ).toHaveAccessibleDescription("28");
      expect(
        screen.queryByRole("button", { name: "每日数据" }),
      ).not.toBeInTheDocument();
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
  it("renders empty and unavailable states without an endless skeleton or invented values", () => {
    const data = analytics();
    data.daily = [];
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={data}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    expect(screen.getByText("暂无每日数据")).toBeVisible();
    expect(container.querySelector("[data-slot=chart]")).toBeNull();
    rerender(
      <ChartAreaInteractive
        analytics={undefined}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    expect(screen.getByText("统计数据暂不可用")).toBeVisible();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(
      screen.getByRole("button", { name: "确认金额" }),
    ).toHaveAccessibleDescription("—");
  });

  it("switches header metrics with the keyboard without clearing the active metric", async () => {
    render(
      <ChartAreaInteractive
        analytics={analytics()}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    const user = userEvent.setup();
    const amount = screen.getByRole("button", { name: "确认金额" });
    const orders = screen.getByRole("button", { name: "新建订单" });
    amount.focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(orders).toHaveFocus();
    expect(orders).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Enter}");
    expect(orders).toHaveAttribute("aria-pressed", "true");
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
  it.each(["AREA", "LINE"] as const)(
    "reuses the active %s dot and applies reduced-motion-safe coordinate transitions",
    async (chartType) => {
      const data = analytics();
      data.daily = data.daily.map((day, index) => ({
        ...day,
        confirmed_amount_cents: (index + 1) * 1000,
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
          container.querySelector(".recharts-active-dot circle"),
        ).not.toBeNull(),
      );
      const dot = container.querySelector(".recharts-active-dot circle")!;
      const firstX = dot.getAttribute("cx");
      const firstY = dot.getAttribute("cy");
      expect(dot).toHaveClass(
        "motion-safe:transition-[cx,cy]",
        "motion-safe:duration-200",
        "motion-safe:ease-out",
        "motion-reduce:transition-none",
      );
      expect(dot).toHaveAttribute("stroke", "var(--card)");
      expect(dot).not.toHaveAttribute("style");
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      await waitFor(() => expect(dot.getAttribute("cx")).not.toBe(firstX));
      expect(dot.getAttribute("cy")).not.toBe(firstY);
      expect(container.querySelector(".recharts-active-dot circle")).toBe(dot);
      expect(
        container.querySelectorAll(".recharts-active-dot circle"),
      ).toHaveLength(1);
    },
  );

  it("highlights the active bar and moves its date band with keyboard navigation", async () => {
    const data = analytics();
    data.daily = data.daily.map((day) => ({
      ...day,
      confirmed_amount_cents: 12345,
    }));
    const { container } = render(
      <ChartAreaInteractive
        analytics={data}
        chartType="BAR"
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
        container.querySelector(".recharts-active-bar .recharts-rectangle"),
      ).not.toBeNull(),
    );
    const active = container.querySelector(
      ".recharts-active-bar .recharts-rectangle",
    )!;
    const inactive = container.querySelector(
      ".recharts-inactive-bar .recharts-rectangle",
    )!;
    expect(active).toHaveAttribute("fill-opacity", "1");
    expect(inactive).toHaveAttribute("fill-opacity", "0.55");
    const cursor = container.querySelector(".recharts-tooltip-cursor")!;
    expect(cursor).not.toBeNull();
    const firstX = cursor.getAttribute("x");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => {
      const nextCursor = container.querySelector(".recharts-tooltip-cursor");
      expect(nextCursor).not.toBeNull();
      expect(nextCursor?.getAttribute("x")).not.toBe(firstX);
      expect(container.querySelectorAll(".recharts-active-bar")).toHaveLength(
        1,
      );
    });
  });

  it("still marks a zero-value day with a date band without inventing bar height", async () => {
    const data = analytics();
    data.daily = data.daily.map((day) => ({
      ...day,
      confirmed_amount_cents: 0,
    }));
    const { container } = render(
      <ChartAreaInteractive
        analytics={data}
        chartType="BAR"
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
      ).toHaveTextContent("¥0.00"),
    );
    expect(container.querySelector(".recharts-tooltip-cursor")).not.toBeNull();
    expect(
      container.querySelector(".recharts-active-bar .recharts-rectangle"),
    ).toBeNull();
  });
});

describe("always-visible daily analytics", () => {
  it.each([7, 30, 90] as const)(
    "shows %i days newest-first, ten per page, without hiding evidence",
    async (range) => {
      const data = analytics(range);
      const dates = data.daily.map((day) => day.date);
      render(<DailyAnalytics analytics={data} range={range} pending={false} />);
      const table = screen.getByRole("table", { name: "每日收款数据" });
      expect(screen.getByRole("heading", { name: "每日数据" })).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "每日数据" }),
      ).not.toBeInTheDocument();
      expect(within(table).getAllByRole("row")).toHaveLength(
        Math.min(10, range) + 1,
      );
      const first = within(table).getAllByRole("row")[1]!;
      expect(first).toHaveTextContent(dates.at(-1)!);
      expect(within(first).getByText("¥100.00")).toBeVisible();
      expect(within(first).getAllByRole("cell")).toHaveLength(4);
      expect(
        screen.getByRole("button", { name: "每日数据上一页" }),
      ).toBeDisabled();
      const next = screen.getByRole("button", { name: "每日数据下一页" });
      const seen: string[] = [];
      const user = userEvent.setup();
      for (let page = 1; page <= Math.ceil(range / 10); page++) {
        const rows = within(table).getAllByRole("row").slice(1);
        seen.push(
          ...rows.map(
            (row) => within(row).getAllByRole("cell")[0]!.textContent!,
          ),
        );
        expect(screen.getByRole("status")).toHaveTextContent(
          "第 " + page + " / " + Math.ceil(range / 10) + " 页",
        );
        if (page < Math.ceil(range / 10)) await user.click(next);
      }
      expect(next).toBeDisabled();
      expect(seen).toEqual([...dates].reverse());
      expect(data.daily.map((day) => day.date)).toEqual(dates);
      expect(within(table).getByText("¥0.01")).toBeVisible();
    },
  );

  it("resets pagination on period changes, hides stale values while pending and clamps a shortened response", async () => {
    const user = userEvent.setup();
    const { rerender, container } = render(
      <DailyAnalytics analytics={analytics(90)} range={90} pending={false} />,
    );
    await user.click(screen.getByRole("button", { name: "每日数据下一页" }));
    expect(screen.getByRole("status")).toHaveTextContent("第 2 / 9 页");
    rerender(<DailyAnalytics analytics={analytics(90)} range={30} pending />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取每日数据");
    expect(screen.queryByText("¥100.00")).not.toBeInTheDocument();
    expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "每日数据下一页" }),
    ).toBeDisabled();
    rerender(
      <DailyAnalytics analytics={analytics(30)} range={30} pending={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("第 1 / 3 页");
    await user.click(screen.getByRole("button", { name: "每日数据下一页" }));
    rerender(
      <DailyAnalytics
        analytics={{ ...analytics(30), daily: analytics(7).daily }}
        range={30}
        pending={false}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("第 1 / 1 页");
    rerender(
      <DailyAnalytics analytics={analytics(90)} range={90} pending={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("第 1 / 9 页");
  });

  it("keeps zero days distinct from a failed read without inventing money", () => {
    const data = { ...analytics(), daily: [] };
    const { rerender, container } = render(
      <DailyAnalytics analytics={data} range={7} pending={false} />,
    );
    expect(screen.getByText("暂无每日数据")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("共 0 天");
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    rerender(
      <DailyAnalytics analytics={undefined} range={7} pending={false} />,
    );
    expect(screen.getByText("统计数据暂不可用")).toBeVisible();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("distinguishes loading summary cards from unavailable statistics", () => {
    const { container, rerender } = render(
      <SectionCards analytics={undefined} pending />,
    );
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(2);
    rerender(<SectionCards analytics={undefined} pending={false} />);
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(0);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("leaves only confirmation count and current unpaid orders in the summary cards", () => {
    const { container } = render(<SectionCards analytics={analytics()} />);
    expect(container.querySelectorAll("[data-slot=card]")).toHaveLength(2);
    expect(screen.getByText("确认次数")).toBeVisible();
    expect(screen.getByText("当前待付款")).toBeVisible();
    expect(screen.queryByText("付款确认金额")).not.toBeInTheDocument();
    expect(screen.queryByText("新建订单")).not.toBeInTheDocument();
  });
});
