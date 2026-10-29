import { MemoryRouter } from "react-router";
import {
  act,
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
import { SectionCards as SummaryCards } from "../src/components/section-cards";
function SectionCards(props: Parameters<typeof SummaryCards>[0]) {
  return (
    <MemoryRouter>
      <SummaryCards {...props} />
    </MemoryRouter>
  );
}
function analytics(days: 7 | 30 | 90 = 7): SystemAnalytics {
  return {
    range_days: days,
    from: new Date(Date.UTC(2026, 5, 1, -8)).toISOString(),
    to: new Date(Date.UTC(2026, 5, days + 1, -8)).toISOString(),
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
  it("shows only the selected period total with compact metric switches", async () => {
    const data = analytics();
    data.confirmations.amount_cents = 4270937;
    data.orders.created = 1105;
    const { container } = render(
      <ChartAreaInteractive
        analytics={data}
        range={7}
        onRangeChange={vi.fn()}
        pending={false}
      />,
    );
    const values = container.querySelectorAll("[data-metric-value]");
    expect(values).toHaveLength(1);
    expect(values[0]).toHaveTextContent("¥42,709.37");
    expect(screen.getByText("区间累计")).toBeVisible();
    expect(container.querySelector("[data-slot=card-footer]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "新建订单" }));
    expect(values[0]).toHaveTextContent("1,105");
    for (const value of values) {
      expect(value).not.toHaveClass("overflow-x-auto", "leading-none");
      expect(value).toHaveClass(
        "whitespace-normal",
        "wrap-anywhere",
        "leading-tight",
      );
    }
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });
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
      // jsdom's ResizeObserver fixture supplies a synthetic height, so guard
      // the definite parent height as well; real-browser checks verify the SVG.
      expect(container.querySelector("[data-slot=chart]")).toHaveClass("trend-plot", "aspect-auto");
      expect(container.querySelector("[data-slot=chart]")).toHaveAttribute("role", "group");
      expect(container.querySelector("[data-slot=chart]")).not.toHaveClass("flex-1");
      expect(
        container.querySelector('svg[role="application"]'),
      ).toHaveAttribute("tabindex", "0");
      expect(container.querySelector("[data-slot=chart] style")).toBeNull();
      const metrics = screen.getByRole("group", { name: "趋势指标" });
      expect(metrics.closest('[role="tabpanel"]')).not.toBeNull();
      expect(
        within(metrics).getByRole("button", { name: "确认金额" }),
      ).toHaveAccessibleDescription("¥100.01");
      expect(
        within(metrics).getByRole("button", { name: "新建订单" }),
      ).toHaveAccessibleDescription("28");
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    },
  );
  it.each(["AREA", "BAR", "LINE"] as const)(
    "keeps the %s series, active mark and tooltip on the same semantic color",
    async (chartType) => {
      const data = analytics();
      data.daily = data.daily.map((day) => ({
        ...day,
        confirmed_amount_cents: 132443,
        orders_created: 40,
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
      const user = userEvent.setup();
      for (const [label, token, value] of [
        ["确认金额", "chart-1", "¥1,324.43"],
        ["新建订单", "chart-2", "40"],
      ] as const) {
        await user.click(screen.getByRole("button", { name: label }));
        const color = "var(--" + token + ")";
        const chart = container.querySelector<SVGElement>(
          'svg[role="application"]',
        )!;
        fireEvent.focus(chart);
        fireEvent.keyDown(chart, { key: "ArrowRight" });
        await waitFor(() =>
          expect(
            container.querySelector(".recharts-tooltip-wrapper"),
          ).toHaveTextContent(value),
        );
        const tooltip = container.querySelector<HTMLElement>(
          ".recharts-tooltip-wrapper",
        )!;
        expect(within(tooltip).getByText(label, { exact: true })).toBeVisible();
        expect(tooltip.querySelector(".bg-" + token)).not.toBeNull();
        if (chartType === "BAR") {
          await waitFor(() =>
            expect(
              container.querySelector(
                ".recharts-active-bar .recharts-rectangle",
              ),
            ).toHaveAttribute("fill", color),
          );
          const active = container.querySelector(
            ".recharts-active-bar .recharts-rectangle",
          );
          const inactive = container.querySelector(
            ".recharts-inactive-bar .recharts-rectangle",
          );
          expect(active).toHaveAttribute("fill", color);
          expect(active).toHaveAttribute("fill-opacity", "1");
          expect(inactive).toHaveAttribute("fill", color);
          expect(inactive).toHaveAttribute("fill-opacity", "0.85");
        } else {
          const curve = container.querySelector(
            chartType === "AREA"
              ? ".recharts-area-curve"
              : ".recharts-line-curve",
          );
          expect(curve).toHaveAttribute("stroke", color);
          expect(curve).toHaveAttribute("stroke-width", "2");
          expect(
            container.querySelector(".recharts-active-dot circle"),
          ).toHaveAttribute("fill", color);
          if (chartType === "AREA") {
            expect(
              container.querySelector(".recharts-area-area"),
            ).toHaveAttribute("fill-opacity", "1");
            const stops = container.querySelectorAll("linearGradient stop");
            expect(stops).toHaveLength(2);
            expect(stops[0]).toHaveAttribute("stop-color", color);
            expect(stops[0]).toHaveAttribute("stop-opacity", "0.18");
            expect(stops[1]).toHaveAttribute("stop-color", color);
            expect(stops[1]).toHaveAttribute("stop-opacity", "0.02");
          }
        }
        expect(container.querySelector("[data-slot=chart] style")).toBeNull();
      }
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
      ).toHaveClass("tabular-nums");
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
    expect(inactive).toHaveAttribute("fill-opacity", "0.85");
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

function dailyDates(region = screen.getByRole("region", { name: "每日数据" })) {
  return Array.from(region.querySelectorAll<HTMLTimeElement>(".daily-date time[datetime]"))
    .map((time) => time.dateTime);
}

describe("paginated daily analytics report", () => {
  it.each([
    [7, 1],
    [30, 3],
    [90, 9],
  ] as const)(
    "shows every one of %i days newest-first across %i pages with one table header",
    async (range, pageCount) => {
      const data = analytics(range);
      const original = structuredClone(data);
      render(<DailyAnalytics analytics={data} range={range} pending={false} />);
      const report = screen.getByRole("region", { name: "每日数据" });
      const dates: string[] = [];
      for (let page = 1; page <= pageCount; page += 1) {
        const tables = within(report).getAllByRole("table", { name: "每日收款数据" });
        expect(tables).toHaveLength(1);
        const table = tables[0]!;
        const headings = within(table).getAllByRole("columnheader");
        expect(headings.map((heading) => heading.textContent))
          .toEqual(["日期", "确认金额", "确认笔数", "新建订单"]);
        const rows = within(table).getAllByRole("row").slice(1);
        expect(rows).toHaveLength(Math.min(10, range - (page - 1) * 10));
        for (const row of rows) {
          expect(within(row).getAllByRole("cell")).toHaveLength(4);
        }
        dates.push(...dailyDates(report));
        expect(within(report).getAllByRole("status")).toHaveLength(1);
        expect(within(report).getByRole("status")).toHaveTextContent(
          pageCount === 1 ? "共 7 天" : `第 ${page}/${pageCount} 页 · 共 ${range} 天`,
        );
        const pagination = within(report).queryByRole("navigation", { name: "每日数据分页" });
        if (pageCount === 1) {
          expect(pagination).not.toBeInTheDocument();
        } else {
          expect(pagination).toBeVisible();
          const previous = within(pagination!).getByRole("button", { name: "上一页" });
          const next = within(pagination!).getByRole("button", { name: "下一页" });
          expect(previous).toHaveProperty("disabled", page === 1);
          expect(next).toHaveProperty("disabled", page === pageCount);
          if (page < pageCount) await userEvent.click(next);
        }
      }
      expect(dates).toEqual(original.daily.map((day) => day.date).reverse());
      expect(new Set(dates).size).toBe(range);
      const pennyRow = report.querySelector('.daily-date time[datetime="2026-06-03"]')!.closest("tr")!;
      expect(within(pennyRow).getByText("¥0.01", { exact: true })).toBeVisible();
      expect(within(report).queryByRole("button", { name: "全部展开" })).not.toBeInTheDocument();
      expect(within(report).queryByRole("button", { name: "全部收起" })).not.toBeInTheDocument();
      expect(data).toEqual(original);
    },
  );

  it("turns pages with the keyboard and announces the current page without moving focus", async () => {
    render(<DailyAnalytics analytics={analytics(30)} range={30} pending={false} />);
    const nav = screen.getByRole("navigation", { name: "每日数据分页" });
    const next = within(nav).getByRole("button", { name: "下一页" });
    next.focus();
    await userEvent.keyboard("{Enter}");
    expect(next).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(dailyDates()[0]).toBe("2026-06-20");
    const previous = within(nav).getByRole("button", { name: "上一页" });
    previous.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("第 1/3 页 · 共 30 天");
    expect(dailyDates()[0]).toBe("2026-06-30");
  });

  it("uses the authoritative total and includes completed zero days in average and latest peak tie", () => {
    const data = analytics();
    data.confirmations.amount_cents = 123456;
    data.daily = data.daily.map((day, index) => ({
      ...day,
      confirmed_amount_cents: [0, 101, 202, 202, 0, 0, 999][index]!,
    }));
    const { container } = render(<DailyAnalytics analytics={data} range={7} pending={false} />);
    expect(screen.getByLabelText("每日数据汇总")).toBeVisible();
    expect(container.querySelector('[data-daily-summary="total"]'))
      .toHaveTextContent("¥1,234.56");
    expect(container.querySelector('[data-daily-summary="average"]'))
      .toHaveTextContent("¥0.84");
    expect(container.querySelector('[data-daily-summary="peak"]'))
      .toHaveTextContent("¥2.02");
    expect(container.querySelector('[data-daily-summary="peak"]'))
      .toHaveTextContent("06-04");
    expect(screen.queryByText("区间金额含今日；日均与最高不含今日。"))
      .not.toBeInTheDocument();
    const today = container.querySelector('time[datetime="2026-06-07"]')?.closest("tr");
    expect(today).toHaveTextContent("今日");
    expect(today).toHaveTextContent("周日");
  });

  it("shows no completed-day average or peak when the response only contains today", () => {
    const data = analytics();
    data.from = "2026-06-06T16:00:00.000Z";
    data.daily = data.daily.slice(-1);
    const { container } = render(<DailyAnalytics analytics={data} range={7} pending={false} />);
    for (const metric of ["average", "peak"]) {
      expect(container.querySelector('[data-daily-summary="' + metric + '"]'))
        .toHaveTextContent("—");
    }
    expect(container.querySelector('[data-daily-summary="total"]'))
      .toHaveTextContent("¥100.01");
    expect(screen.getByRole("status")).toHaveTextContent("共 1 天");
  });

  it("keeps the year visible across New Year and preserves large exact currency values", () => {
    const data = analytics();
    data.from = "2025-12-30T16:00:00.000Z";
    data.to = "2026-01-02T16:00:00.000Z";
    data.daily = data.daily.slice(0, 3).map((day, index) => ({
      ...day,
      date: ["2025-12-31", "2026-01-01", "2026-01-02"][index]!,
      confirmed_amount_cents: index === 0 ? 1234567890123 : 0,
    }));
    render(<DailyAnalytics analytics={data} range={7} pending={false} />);
    const table = screen.getByRole("table", { name: "每日收款数据" });
    expect(dailyDates()).toEqual(["2026-01-02", "2026-01-01", "2025-12-31"]);
    for (const time of table.querySelectorAll<HTMLTimeElement>("time[datetime]")) {
      expect(time).toHaveTextContent(time.dateTime);
    }
    const row = table.querySelector('time[datetime="2025-12-31"]')!.closest("tr")!;
    expect(within(row).getByText("¥12,345,678,901.23", { exact: true })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("共 3 天");
  });

  it("keeps summaries and CSP-compatible amount bars on one interval scale across pages, including zero", async () => {
    const data = analytics(30);
    data.daily = data.daily.map((day, index) => ({
      ...day,
      confirmed_amount_cents: index === 0 ? 20000 : index === 29 ? 10000 : 0,
    }));
    const { container } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    const summaries = container.querySelector('[aria-label="每日数据汇总"]')!.textContent;
    const width = (date: string) => container.querySelector(
      'svg[data-date="' + date + '"] rect[data-daily-bar-fill]',
    )?.getAttribute("width");
    expect(width("2026-06-30")).toBe("50");
    expect(width("2026-06-29")).toBe("0");
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(container.querySelector('[aria-label="每日数据汇总"]')).toHaveTextContent(summaries!);
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(container.querySelector('[aria-label="每日数据汇总"]')).toHaveTextContent(summaries!);
    expect(width("2026-06-01")).toBe("100");
    expect(width("2026-06-02")).toBe("0");
    expect(container.querySelector('svg[data-date] [style]')).toBeNull();
  });

  it("preserves the page through same-period refresh and responsive layout changes", async () => {
    const data = analytics(30);
    const { rerender } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    const dates = dailyDates();
    rerender(<DailyAnalytics analytics={data} range={30} pending />);
    const refreshed = structuredClone(data);
    refreshed.confirmations.amount_cents = 222222;
    refreshed.daily[29]!.confirmed_amount_cents = 11111;
    rerender(<DailyAnalytics analytics={refreshed} range={30} pending={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
    expect(dailyDates()).toEqual(dates);
    vi.stubGlobal("innerWidth", 390);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.queryByRole("table", { name: "每日收款数据" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "每日收款数据" })).getAllByRole("listitem"))
      .toHaveLength(10);
    expect(dailyDates()).toEqual(dates);
    expect(screen.getByRole("region", { name: "每日数据" }).querySelector('svg[data-date]')).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
    vi.stubGlobal("innerWidth", 1440);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(screen.getByRole("table", { name: "每日收款数据" })).toBeVisible();
    expect(dailyDates()).toEqual(dates);
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
  });

  it("resets to the first page for a different website or selected range", async () => {
    const data = analytics(30);
    const { rerender } = render(
      <DailyAnalytics analytics={data} range={30} pending={false} scopeKey="site-a" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    rerender(<DailyAnalytics analytics={undefined} range={30} pending scopeKey="site-b" />);
    rerender(<DailyAnalytics analytics={data} range={30} pending={false} scopeKey="site-b" />);
    expect(screen.getByRole("status")).toHaveTextContent("第 1/3 页 · 共 30 天");
    expect(dailyDates()[0]).toBe("2026-06-30");
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    rerender(<DailyAnalytics analytics={analytics(90)} range={90} pending={false} scopeKey="site-b" />);
    expect(screen.getByRole("status")).toHaveTextContent("第 1/9 页 · 共 90 天");
    expect(dailyDates()[0]).toBe("2026-08-29");
  });

  it.each(["from", "to"] as const)("resets the page when the response's %s boundary advances in Beijing", async (boundary) => {
    const data = analytics(30);
    const { rerender } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    const nextDay = (timestamp: string) => new Date(Date.parse(timestamp) + 86400000).toISOString();
    const moved = { ...data, [boundary]: nextDay(data[boundary]) };
    rerender(<DailyAnalytics analytics={moved} range={30} pending={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("第 1/3 页 · 共 30 天");
    expect(dailyDates()[0]).toBe("2026-06-30");
  });

  it("hides stale summaries and rows while another period loads and disables report controls", () => {
    const { rerender, container } = render(
      <DailyAnalytics analytics={analytics(90)} range={90} pending={false} />,
    );
    rerender(<DailyAnalytics analytics={analytics(90)} range={30} pending />);
    const report = screen.getByRole("region", { name: "每日数据" });
    expect(report).toHaveAttribute("aria-busy", "true");
    expect(within(report).getByRole("status")).toHaveTextContent("正在读取每日数据");
    expect(within(report).queryByText("¥100.00")).not.toBeInTheDocument();
    expect(within(report).queryByRole("table", { name: "每日收款数据" })).not.toBeInTheDocument();
    expect(dailyDates(report)).toHaveLength(0);
    expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull();
    for (const button of within(report).queryAllByRole("button")) expect(button).toBeDisabled();
    rerender(<DailyAnalytics analytics={analytics(30)} range={30} pending={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("第 1/3 页 · 共 30 天");
    expect(dailyDates()).toHaveLength(10);
  });

  it("keeps empty data, a failed read and valid zero amounts distinct", () => {
    const data = { ...analytics(), daily: [] };
    const { rerender, container } = render(
      <DailyAnalytics analytics={data} range={7} pending={false} />,
    );
    expect(screen.getByText("暂无每日数据")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("共 0 天");
    expect(screen.queryByText("¥0.00")).not.toBeInTheDocument();
    rerender(<DailyAnalytics analytics={undefined} range={7} pending={false} />);
    expect(screen.getByText("统计数据暂不可用")).toBeVisible();
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    const zeros = analytics();
    zeros.confirmations = { count: 0, amount_cents: 0 };
    zeros.daily = zeros.daily.map((day) => ({ ...day, confirmed_amount_cents: 0, confirmations: 0 }));
    rerender(<DailyAnalytics analytics={zeros} range={7} pending={false} />);
    expect(screen.queryByText("暂无每日数据")).not.toBeInTheDocument();
    expect(screen.queryByText("统计数据暂不可用")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "每日收款数据" })).toBeVisible();
    expect(container.querySelector('[data-daily-summary="average"]')).toHaveTextContent("¥0.00");
    expect(container.querySelector('[data-daily-summary="peak"]')).toHaveTextContent("06-06");
  });

  it("distinguishes loading summary cards from unavailable statistics", () => {
    const { container, rerender } = render(
      <SectionCards analytics={undefined} pending />,
    );
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(4);
    rerender(<SectionCards analytics={undefined} pending={false} />);
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(0);
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("leaves only confirmation count and current unpaid orders in the summary cards", () => {
    const { container } = render(<SectionCards analytics={analytics()} />);
    expect(container.querySelectorAll("[data-slot=card]")).toHaveLength(4);
    expect(screen.getByText("今日收款确认笔数")).toBeVisible();
    expect(screen.getByText("今日确认金额")).toBeVisible();
    expect(screen.getByText("待处理")).toBeVisible();
    expect(screen.getByText("当前待付款")).toBeVisible();
    expect(screen.queryByText("付款确认金额")).not.toBeInTheDocument();
    expect(screen.queryByText("新建订单")).not.toBeInTheDocument();
  });
});

describe("shared trend and daily views", () => {
  it("keeps daily data in the trend card, retains pagination across views and resets it on period changes", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const { container, rerender } = render(
      <ChartAreaInteractive
        analytics={analytics(30)}
        range={30}
        pending={false}
        onRangeChange={change}
      />,
    );
    const trend = screen.getByRole("heading", { name: "收款趋势" });
    const chartTab = screen.getByRole("tab", { name: "图表" });
    const dailyTab = screen.getByRole("tab", { name: "每日数据" });
    expect(
      screen.queryByRole("table", { name: "每日收款数据" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建订单" }));
    await user.click(dailyTab);
    const table = screen.getAllByRole("table", { name: "每日收款数据" })[0]!;
    expect(table.closest('[data-slot="card"]')).toBe(
      trend.closest('[data-slot="card"]'),
    );
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(
      screen.queryByRole("group", { name: "趋势指标" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("2026-06-01 — 2026-06-30")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
    const dates = dailyDates();
    await user.click(chartTab);
    expect(
      screen.queryByRole("table", { name: "每日收款数据" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建订单" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(dailyTab);
    expect(screen.getByRole("status")).toHaveTextContent("第 2/3 页 · 共 30 天");
    expect(dailyDates()).toEqual(dates);
    await user.click(screen.getByRole("button", { name: "近 7 天" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("7");
    rerender(
      <ChartAreaInteractive
        analytics={undefined}
        range={7}
        pending
        onRangeChange={change}
      />,
    );
    expect(dailyTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "每日数据" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(dailyDates()).toHaveLength(0);
    rerender(
      <ChartAreaInteractive
        analytics={analytics(7)}
        range={7}
        pending={false}
        onRangeChange={change}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("共 7 天");
    expect(dailyDates()).toHaveLength(7);
    dailyTab.focus();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(chartTab).toHaveFocus();
    expect(chartTab).toHaveAttribute("aria-selected", "true");
  });

  it("resets the daily page when the website changes while the chart view is active", async () => {
    const data = analytics(30);
    const onRangeChange = vi.fn();
    const { rerender } = render(
      <ChartAreaInteractive analytics={data} range={30} pending={false} onRangeChange={onRangeChange} scopeKey="site-a" />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "每日数据" }));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await userEvent.click(screen.getByRole("tab", { name: "图表" }));
    rerender(
      <ChartAreaInteractive analytics={data} range={30} pending={false} onRangeChange={onRangeChange} scopeKey="site-b" />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.getByRole("status")).toHaveTextContent("第 1/3 页 · 共 30 天");
    expect(dailyDates()[0]).toBe("2026-06-30");
    expect(onRangeChange).not.toHaveBeenCalled();
  });
});
