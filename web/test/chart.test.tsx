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

function weeklyTriggers(region = screen.getByRole("region", { name: "每日数据" })) {
  return within(region)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("data-slot") === "accordion-trigger");
}

function dailyDates(region = screen.getByRole("region", { name: "每日数据" })) {
  return Array.from(region.querySelectorAll<HTMLTimeElement>("time[datetime]"))
    .map((time) => time.dateTime);
}

describe("weekly daily analytics report", () => {
  it.each([
    [7, 1],
    [30, 5],
    [90, 13],
  ] as const)(
    "shows every one of %i days newest-first across %i weeks without pagination",
    async (range, weekCount) => {
      const data = analytics(range);
      const original = structuredClone(data);
      render(<DailyAnalytics analytics={data} range={range} pending={false} />);
      const report = screen.getByRole("region", { name: "每日数据" });
      const triggers = weeklyTriggers(report);
      expect(triggers).toHaveLength(weekCount);
      expect(triggers.map((trigger) => trigger.getAttribute("aria-expanded")))
        .toEqual(triggers.map((_, index) => index < 2 ? "true" : "false"));
      expect(within(report).getByRole("status"))
        .toHaveTextContent("共 " + range + " 天 · " + weekCount + " 周");
      expect(screen.queryByRole("navigation", { name: "每日数据分页" }))
        .not.toBeInTheDocument();
      const expand = within(report).getByRole("button", { name: "全部展开" });
      if (weekCount > 2) await userEvent.click(expand);
      expect(expand).toBeDisabled();
      const tables = within(report).getAllByRole("table", { name: "每日收款数据" });
      expect(tables).toHaveLength(weekCount);
      const dates = dailyDates(report);
      expect(dates).toEqual(original.daily.map((day) => day.date).reverse());
      expect(new Set(dates).size).toBe(range);
      for (const table of tables) {
        const headings = within(table).getAllByRole("columnheader");
        expect(headings.map((heading) => heading.textContent))
          .toEqual(["日期", "确认金额", "确认次数", "新建订单"]);
        for (const row of within(table).getAllByRole("row").slice(1)) {
          expect(within(row).getAllByRole("cell")).toHaveLength(4);
        }
      }
      expect(within(tables[0]!).getByText("¥100.00")).toBeVisible();
      const pennyRow = report.querySelector('time[datetime="2026-06-03"]')!.closest("tr")!;
      expect(within(pennyRow).getByText("¥0.01", { exact: true })).toBeVisible();
      expect(data).toEqual(original);
    },
  );

  it("announces actual partial-week coverage and keyboard-accessible totals", async () => {
    render(<DailyAnalytics analytics={analytics(30)} range={30} pending={false} />);
    const triggers = weeklyTriggers();
    expect(triggers[0]).toHaveAccessibleName(/2026-06-29.*2026-06-30/);
    expect(triggers[0]).toHaveAccessibleName(/区间内 2 天/);
    expect(triggers[0]).toHaveAccessibleName(/¥100\.00/);
    expect(triggers[0]).toHaveAccessibleName(/确认.*1/);
    expect(triggers[0]).toHaveAccessibleName(/新建.*57/);
    expect(triggers[0]).toHaveAccessibleName(/进行中/);
    expect(triggers[1]).toHaveAccessibleName(/2026-06-22.*2026-06-28/);
    expect(triggers[1]).toHaveAccessibleName(/7 天/);
    triggers[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(triggers[1]).toHaveAttribute("aria-expanded", "false");
    expect(triggers[1]).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(triggers.every((trigger) => trigger.getAttribute("aria-expanded") === "false"))
      .toBe(true);
    expect(screen.getByRole("button", { name: "全部收起" })).toBeDisabled();
    expect(screen.queryByRole("table", { name: "每日收款数据" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(triggers.every((trigger) => trigger.getAttribute("aria-expanded") === "true"))
      .toBe(true);
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
    expect(container.querySelector('[data-daily-summary="average"]'))
      .toHaveTextContent("不含今日");
    expect(container.querySelector('[data-daily-summary="peak"]'))
      .toHaveTextContent("¥2.02");
    expect(container.querySelector('[data-daily-summary="peak"]'))
      .toHaveTextContent("06-04");
    expect(container.querySelector('[data-daily-summary="peak"]'))
      .toHaveTextContent("不含今日");
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
    expect(screen.getByRole("status")).toHaveTextContent("共 1 天 · 1 周");
  });

  it("compares amounts on one interval scale using CSP-compatible SVG attributes, including zero", async () => {
    const data = analytics(30);
    data.daily = data.daily.map((day, index) => ({
      ...day,
      confirmed_amount_cents: index === 0 ? 20000 : index === 29 ? 10000 : 0,
    }));
    const { container } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    await userEvent.click(screen.getByRole("button", { name: "全部展开" }));
    const width = (date: string) => container.querySelector(
      'svg[data-date="' + date + '"] rect[data-daily-bar-fill]',
    )?.getAttribute("width");
    expect(width("2026-06-01")).toBe("100");
    expect(width("2026-06-30")).toBe("50");
    expect(width("2026-06-02")).toBe("0");
    expect(container.querySelector('svg[data-date] [style]')).toBeNull();
  });

  it("preserves collapsed weeks on same-period refresh and resize, then resets when date boundaries change", async () => {
    const data = analytics(30);
    const { rerender } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    await userEvent.click(screen.getByRole("button", { name: "全部收起" }));
    const snapshot = () => weeklyTriggers().map((trigger) => trigger.getAttribute("aria-expanded"));
    rerender(<DailyAnalytics analytics={data} range={30} pending />);
    const refreshed = structuredClone(data);
    refreshed.confirmations.amount_cents = 222222;
    refreshed.daily[29]!.confirmed_amount_cents = 11111;
    rerender(<DailyAnalytics analytics={refreshed} range={30} pending={false} />);
    expect(snapshot()).toEqual(["false", "false", "false", "false", "false"]);
    vi.stubGlobal("innerWidth", 390);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(snapshot()).toEqual(["false", "false", "false", "false", "false"]);
    await userEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(screen.queryByRole("table", { name: "每日收款数据" })).not.toBeInTheDocument();
    expect(dailyDates()).toEqual(data.daily.map((day) => day.date).reverse());
    vi.stubGlobal("innerWidth", 1440);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(snapshot()).toEqual(["true", "true", "true", "true", "true"]);
    const nextDay = (timestamp: string) => new Date(Date.parse(timestamp) + 86400000).toISOString();
    const moved = {
      ...data,
      from: nextDay(data.from),
      to: nextDay(data.to),
      daily: data.daily.map((day) => ({ ...day, date: nextDay(day.date).slice(0, 10) })),
    };
    rerender(<DailyAnalytics analytics={moved} range={30} pending={false} />);
    expect(snapshot()).toEqual(["true", "true", "false", "false", "false"]);
    await userEvent.click(screen.getByRole("button", { name: "全部收起" }));
    rerender(<DailyAnalytics analytics={analytics(90)} range={90} pending={false} />);
    expect(snapshot().slice(0, 3)).toEqual(["true", "true", "false"]);
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
    for (const label of ["全部展开", "全部收起"]) {
      expect(within(report).getByRole("button", { name: label })).toBeDisabled();
    }
    rerender(<DailyAnalytics analytics={analytics(30)} range={30} pending={false} />);
    expect(weeklyTriggers().map((trigger) => trigger.getAttribute("aria-expanded")))
      .toEqual(["true", "true", "false", "false", "false"]);
  });

  it("keeps empty data, a failed read and valid zero amounts distinct", () => {
    const data = { ...analytics(), daily: [] };
    const { rerender, container } = render(
      <DailyAnalytics analytics={data} range={7} pending={false} />,
    );
    expect(screen.getByText("暂无每日数据")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("共 0 天 · 0 周");
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
  it("keeps daily data in the trend card, retains expanded weeks across views and resets them on period changes", async () => {
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
    await user.click(screen.getByRole("button", { name: "全部收起" }));
    expect(weeklyTriggers().every((trigger) => trigger.getAttribute("aria-expanded") === "false"))
      .toBe(true);
    await user.click(chartTab);
    expect(
      screen.queryByRole("table", { name: "每日收款数据" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建订单" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(dailyTab);
    expect(weeklyTriggers().every((trigger) => trigger.getAttribute("aria-expanded") === "false"))
      .toBe(true);
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
    expect(
      screen.getByRole("button", { name: "全部展开" }),
    ).toBeDisabled();
    rerender(
      <ChartAreaInteractive
        analytics={analytics(7)}
        range={7}
        pending={false}
        onRangeChange={change}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("共 7 天 · 1 周");
    expect(weeklyTriggers()[0]).toHaveAttribute("aria-expanded", "true");
    dailyTab.focus();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(chartTab).toHaveFocus();
    expect(chartTab).toHaveAttribute("aria-selected", "true");
  });
});
