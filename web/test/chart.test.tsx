import { MemoryRouter } from "react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import { ChartAreaInteractive } from "../src/components/chart-area-interactive";
import { DailyAnalytics } from "../src/components/daily-analytics";
import { SectionCards as SummaryCards } from "../src/components/section-cards";
import { CHART_TYPE_STORAGE_KEY } from "../src/hooks/use-chart-type";
import { mobileMedia } from "./mobile-media";

beforeEach(() => localStorage.removeItem(CHART_TYPE_STORAGE_KEY));

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
  it("changes chart type from the compact mobile menu and retains the selection across metrics and desktop controls", async () => {
    const media = mobileMedia(390);
    const { container } = render(<ChartAreaInteractive analytics={analytics()} range={7} onRangeChange={vi.fn()} pending={false} />);
    const user = userEvent.setup();
    expect(screen.queryByRole("group", { name: "图表类型" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "图表类型：面积图" }));
    expect(await screen.findByRole("menuitemradio", { name: "面积图" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "柱状图" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await within(container).findByRole("application");
    expect(container.querySelector("[data-slot=chart]")).toHaveAttribute("data-chart-type", "BAR");
    expect(screen.getByRole("button", { name: "图表类型：柱状图" })).toBeVisible();
    expect(localStorage.getItem(CHART_TYPE_STORAGE_KEY)).toBe("BAR");
    await user.click(screen.getByRole("button", { name: "金额与订单" }));
    expect(screen.queryByRole("button", { name: /^图表类型：/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认金额" }));
    expect(screen.getByRole("button", { name: "图表类型：柱状图" })).toBeVisible();
    media.resize(1440);
    expect(screen.queryByRole("button", { name: /^图表类型：/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "图表类型" })).getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
  });

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
    expect(values[0]).toHaveAttribute("data-value-length", "10");
    expect(screen.getByText("区间累计")).toBeVisible();
    expect(container.querySelector("[data-slot=card-footer]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "新建订单" }));
    expect(values[0]).toHaveTextContent("1,105");
    for (const value of values) {
      expect(value).toHaveClass("trend-value", "leading-tight");
      expect(value).toHaveAttribute("data-value-length", "5");
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
      await within(container).findByRole("application");
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
      expect(screen.getAllByRole("group", { name: "趋势指标" })).toHaveLength(1);
      const trend = screen.getByRole("heading", { name: "收款趋势" }).closest<HTMLElement>('[data-slot="card"]')!;
      expect(within(trend).getByRole("group", { name: "趋势指标" })).toBeVisible();
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
        ["确认金额", "chart-1", chartType === "LINE" ? "¥2,648.86" : "¥1,324.43"],
        ["新建订单", "chart-2", chartType === "LINE" ? "120" : "40"],
      ] as const) {
        await user.click(screen.getByRole("button", { name: label }));
        const color = "var(--" + token + ")";
        const chart = await within(container).findByRole("application");
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
    async (days) => {
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
      await within(container).findByRole("application");
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
      .click(screen.getByRole("combobox", { name: "统计周期" }));
    await userEvent.setup().click(await screen.findByRole("option", { name: "近 30 天" }));
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
    await within(container).findByRole("application");
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
    const application = await within(container).findByRole("application");
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
      const chart = await within(container).findByRole("application");
      fireEvent.focus(chart);
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      const expectedValue = chartType === "LINE" ? "¥2,648.86" : "¥1,324.43";
      await waitFor(() =>
        expect(
          container.querySelector(".recharts-tooltip-wrapper"),
        ).toHaveTextContent(expectedValue),
      );
      const tooltip = container.querySelector<HTMLElement>(
        ".recharts-tooltip-wrapper",
      )!;
      expect(
        within(tooltip).getByText("确认金额", { exact: true }),
      ).toBeVisible();
      expect(
        within(tooltip).getByText(expectedValue, { exact: true }),
      ).toHaveClass("tabular-nums");
      if (chartType === "LINE") {
        expect(tooltip).toHaveTextContent("累计");
      }
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
      const chart = await within(container).findByRole("application");
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
    const chart = await within(container).findByRole("application");
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
    const chart = await within(container).findByRole("application");
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

describe("complete daily analytics report", () => {
  it.each([7, 30, 90] as const)(
    "shows all %i days in a Monday-to-Sunday bill calendar grid without pagination",
    (range) => {
      const data = analytics(range);
      const original = structuredClone(data);
      render(
        <MemoryRouter>
          <DailyAnalytics analytics={data} range={range} pending={false} />
        </MemoryRouter>,
      );
      const report = screen.getByRole("region", { name: "每日数据" });
      const grids = within(report).getAllByRole("grid", { name: "每日收款日历" });
      expect(grids).toHaveLength(1);
      const grid = grids[0]!;
      const headings = within(grid).getAllByRole("columnheader");
      expect(headings.map((heading) => heading.textContent))
        .toEqual(["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
      const dates = dailyDates(report);
      expect(within(report).getAllByRole("status")).toHaveLength(1);
      expect(within(report).getByRole("status")).toHaveTextContent(`共 ${range} 天`);
      expect(within(report).getByRole("status")).toHaveAttribute("aria-live", "polite");
      expect(within(report).getByRole("status")).toHaveAttribute("aria-atomic", "true");
      expect(within(report).queryByRole("navigation", { name: "每日数据分页" })).not.toBeInTheDocument();
      expect(dates).toEqual(original.daily.map((day) => day.date));
      expect(new Set(dates).size).toBe(range);
      const pennyCell = report.querySelector('button[data-cal-date="2026-06-03"]')!;
      expect(pennyCell).toHaveTextContent("¥0.01");
      expect(within(report).queryByRole("button", { name: "全部展开" })).not.toBeInTheDocument();
      expect(within(report).queryByRole("button", { name: "全部收起" })).not.toBeInTheDocument();
      expect(data).toEqual(original);
    },
  );

  it("marks peak and lowest days, places the detail panel above the calendar, and updates on click and arrow keys", async () => {
    const user = userEvent.setup();
    const data = analytics();
    data.confirmations.amount_cents = 123456;
    data.daily = data.daily.map((day, index) => ({
      ...day,
      confirmed_amount_cents: [0, 101, 202, 202, 0, 0, 999][index]!,
      confirmations: [0, 1, 2, 2, 0, 0, 3][index]!,
      notifications_failed: index === 1 ? 2 : 0,
    }));
    const { container } = render(
      <MemoryRouter initialEntries={["/sites/shop-a"]}>
        <DailyAnalytics analytics={data} range={7} pending={false} scopeKey="shop-a" />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-daily-summary]")).toBeNull();
    // Detail panel sits above the calendar grid.
    const detail = container.querySelector('[data-daily-detail="2026-06-04"]')!;
    const surface = container.querySelector('[data-daily-surface="true"]')!;
    expect(detail.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Latest peak tie (2026-06-04) and latest lowest tie (2026-06-06) show icon markers on cells.
    expect(container.querySelector('button[data-cal-date="2026-06-04"][data-daily-peak="true"] .daily-cal-mark-icon')).not.toBeNull();
    expect(container.querySelector('button[data-cal-date="2026-06-04"] .daily-cal-delta')).toHaveTextContent("+140%");
    expect(container.querySelector('button[data-cal-date="2026-06-06"][data-daily-lowest="true"] .daily-cal-mark-icon')).not.toBeNull();
    expect(container.querySelector('button[data-cal-date="2026-06-07"] .daily-cal-delta')).toBeNull();
    expect(container.querySelector(".daily-cal-fail-dot")).toBeNull();

    expect(detail).toHaveTextContent("2026-06-04");
    expect(detail).toHaveTextContent("单日最高");
    expect(detail).toHaveTextContent("¥2.02");
    expect(detail).toHaveTextContent("较日均 +140%");
    expect(within(detail as HTMLElement).getByRole("link", { name: /查看当天订单/ }))
      .toHaveAttribute("href", "/sites/shop-a/orders?created_from=2026-06-04&created_to=2026-06-04");

    // Clicking the lowest day shows the 单日最低 badge in the detail panel.
    await user.click(container.querySelector<HTMLButtonElement>('button[data-cal-date="2026-06-06"]')!);
    expect(container.querySelector('[data-daily-detail="2026-06-06"]')).toHaveTextContent("单日最低");

    // Clicking a day with notification failures exposes the notification troubleshooting link in detail.
    const failCell = container.querySelector<HTMLButtonElement>('button[data-cal-date="2026-06-02"]')!;
    await user.click(failCell);
    const failDetail = container.querySelector('[data-daily-detail="2026-06-02"]')!;
    expect(failDetail).toHaveTextContent("失败 2 次");
    expect(within(failDetail as HTMLElement).getByRole("link", { name: /排查通知/ }))
      .toHaveAttribute("href", "/sites/shop-a/notifications?created_from=2026-06-02&created_to=2026-06-02");

    // ArrowRight moves focus and selection to the next day; End jumps to today.
    await user.keyboard("{ArrowRight}");
    expect(container.querySelector('button[data-cal-date="2026-06-03"]')).toHaveFocus();
    expect(container.querySelector('[data-daily-detail="2026-06-03"]')).not.toBeNull();
    await user.keyboard("{End}");
    const todayCell = container.querySelector<HTMLButtonElement>('button[data-cal-date="2026-06-07"]')!;
    expect(todayCell).toHaveFocus();
    expect(todayCell).toHaveTextContent("今日");
    const todayDetail = container.querySelector('[data-daily-detail="2026-06-07"]')!;
    expect(todayDetail).toHaveTextContent("今日累计中");
    expect(todayDetail).toHaveTextContent("周日");
  });

  it("shows today's detail without peak or vs-average badge when the response only contains today", () => {
    const data = analytics();
    data.from = "2026-06-06T16:00:00.000Z";
    data.daily = data.daily.slice(-1);
    const { container } = render(<DailyAnalytics analytics={data} range={7} pending={false} />);
    const detail = container.querySelector('[data-daily-detail="2026-06-07"]')!;
    expect(detail).toHaveTextContent("今日累计中");
    expect(detail).toHaveTextContent("¥100.00");
    expect(detail).not.toHaveTextContent("单日最高");
    expect(detail).not.toHaveTextContent("较日均");
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
    const { container } = render(
      <MemoryRouter>
        <DailyAnalytics analytics={data} range={7} pending={false} />
      </MemoryRouter>,
    );
    expect(dailyDates()).toEqual(["2025-12-31", "2026-01-01", "2026-01-02"]);
    const detail = container.querySelector('[data-daily-detail="2025-12-31"]')!;
    expect(detail).toHaveTextContent("2025-12-31");
    expect(within(detail as HTMLElement).getByText("¥12,345,678,901.23", { exact: true })).toBeVisible();
    expect(container.querySelector('button[data-cal-date="2025-12-31"]')).toHaveTextContent("¥123亿");
    expect(screen.getByRole("status")).toHaveTextContent("共 3 天");
  });

  it("assigns CSP-compatible heat levels on one interval scale without inline styles", () => {
    const data = analytics(30);
    data.daily = data.daily.map((day, index) => ({
      ...day,
      confirmed_amount_cents: index === 0 ? 20000 : index === 29 ? 10000 : 0,
    }));
    const { container } = render(<DailyAnalytics analytics={data} range={30} pending={false} />);
    expect(dailyDates()).toHaveLength(30);
    const level = (date: string) =>
      container.querySelector(`button[data-cal-date="${date}"]`)?.getAttribute("data-cal-level");
    expect(level("2026-06-01")).toBe("4");
    expect(level("2026-06-30")).toBe("3");
    expect(level("2026-06-29")).toBe("0");
    expect(level("2026-06-02")).toBe("0");
    expect(container.querySelector(".daily-report [style]")).toBeNull();
  });

  it("preserves every date and refreshes amounts cleanly", () => {
    const data = analytics(30);
    const { rerender, container } = render(
      <MemoryRouter>
        <DailyAnalytics analytics={data} range={30} pending={false} />
      </MemoryRouter>,
    );
    const dates = dailyDates();
    rerender(
      <MemoryRouter>
        <DailyAnalytics analytics={data} range={30} pending />
      </MemoryRouter>,
    );
    const refreshed = structuredClone(data);
    refreshed.daily[2]!.confirmed_amount_cents = 11111;
    rerender(
      <MemoryRouter>
        <DailyAnalytics analytics={refreshed} range={30} pending={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(dailyDates()).toEqual(dates);
    expect(dates).toHaveLength(30);
    expect(container.querySelector('[data-daily-detail="2026-06-03"]')).toHaveTextContent("¥111.11");
  });

  it("replaces the complete report when the website or selected range changes", () => {
    const data = analytics(30);
    const { rerender, container } = render(
      <DailyAnalytics analytics={data} range={30} pending={false} scopeKey="site-a" />,
    );
    rerender(<DailyAnalytics analytics={undefined} range={30} pending scopeKey="site-b" />);
    expect(dailyDates()).toHaveLength(0);
    const otherSite = structuredClone(data);
    otherSite.daily[2]!.confirmed_amount_cents = 987654;
    rerender(<DailyAnalytics analytics={otherSite} range={30} pending={false} scopeKey="site-b" />);
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(container.querySelector('[data-detail-metric="amount"]')).toHaveTextContent("¥9,876.54");
    expect(dailyDates()).toEqual(data.daily.map((day) => day.date));
    expect(dailyDates().at(-1)).toBe("2026-06-30");
    rerender(<DailyAnalytics analytics={analytics(90)} range={90} pending={false} scopeKey="site-b" />);
    expect(screen.getByRole("status")).toHaveTextContent("共 90 天");
    expect(dailyDates()).toHaveLength(90);
    expect(dailyDates().at(-1)).toBe("2026-08-29");
  });

  it("hides stale detail panels and calendar cells while another period loads, then shows the complete new range", () => {
    const { rerender, container } = render(
      <DailyAnalytics analytics={analytics(90)} range={90} pending={false} />,
    );
    rerender(<DailyAnalytics analytics={analytics(90)} range={30} pending />);
    const report = screen.getByRole("region", { name: "每日数据" });
    expect(report).toHaveAttribute("aria-busy", "true");
    expect(within(report).getByRole("status")).toHaveTextContent("正在读取每日数据");
    expect(within(report).queryByText("¥100.00")).not.toBeInTheDocument();
    expect(within(report).queryByRole("grid", { name: "每日收款日历" })).not.toBeInTheDocument();
    expect(dailyDates(report)).toHaveLength(0);
    expect(container.querySelector("[data-slot=skeleton]")).not.toBeNull();
    rerender(<DailyAnalytics analytics={analytics(30)} range={30} pending={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(dailyDates()).toHaveLength(30);
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
    expect(screen.getByRole("grid", { name: "每日收款日历" })).toBeVisible();
    expect(container.querySelector('[data-daily-detail="2026-06-07"]')).toHaveTextContent("¥0.00");
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
  it("keeps complete daily data in the trend card and preserves view and metric choices across period changes", async () => {
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
      screen.queryByRole("grid", { name: "每日收款日历" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建订单" }));
    await user.click(dailyTab);
    const grid = screen.getAllByRole("grid", { name: "每日收款日历" })[0]!;
    expect(grid.closest('[data-slot="card"]')).toBe(
      trend.closest('[data-slot="card"]'),
    );
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(
      screen.queryByRole("group", { name: "趋势指标" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "图表类型" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(
      (_, element) => element?.textContent === "2026-06-01 — 2026-06-30",
      { selector: '[aria-live="polite"]' },
    )).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    const dates = dailyDates();
    expect(dates).toHaveLength(30);
    await user.click(chartTab);
    expect(
      screen.queryByRole("grid", { name: "每日收款日历" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建订单" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(dailyTab);
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(dailyDates()).toEqual(dates);
    await user.click(screen.getByRole("combobox", { name: "统计周期" }));
    await user.click(await screen.findByRole("option", { name: "近 7 天" }));
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

  it("shows the new website's complete daily data after returning from the chart view", async () => {
    const data = analytics(30);
    const onRangeChange = vi.fn();
    const { rerender } = render(
      <ChartAreaInteractive analytics={data} range={30} pending={false} onRangeChange={onRangeChange} scopeKey="site-a" />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "每日数据" }));
    await userEvent.click(screen.getByRole("tab", { name: "图表" }));
    const otherSite = structuredClone(data);
    otherSite.daily[2]!.confirmed_amount_cents = 987654;
    rerender(
      <ChartAreaInteractive analytics={otherSite} range={30} pending={false} onRangeChange={onRangeChange} scopeKey="site-b" />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "每日数据" }));
    expect(screen.queryByRole("button", { name: /导出 CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("共 30 天");
    expect(dailyDates()).toHaveLength(30);
    expect(screen.getByRole("region", { name: "每日数据" })).toHaveTextContent("¥9,876.54");
    expect(dailyDates().at(-1)).toBe("2026-06-30");
    expect(onRangeChange).not.toHaveBeenCalled();
  });
});
