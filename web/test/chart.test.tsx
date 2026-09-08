import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SystemAnalytics } from "../src/api/client";
import { DailyChart } from "../src/components/DailyChart";
import { areaGeometry, chartIndex, chartScale } from "../src/lib/chart";

const bounds = { left: 62, right: 600, top: 38, bottom: 136 };
function analytics(days: 7 | 30 | 90 = 7): SystemAnalytics {
  return {
    range_days: days, from: "2026-06-01", to: "2026-09-01",
    orders: { created: 28, confirmed: 2, unpaid: 26, disputed: 0, closed: 0, expired: 0 },
    confirmations: { count: 2, amount_cents: 10001 }, notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 26, exceptions: 0, conflicts: 0, notifications: 0 },
    daily: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
      orders_created: index === 1 ? 2000 : index,
      confirmed_amount_cents: index === 2 ? 1 : index === days - 1 ? 10000 : 0,
      confirmations: index === 2 || index === days - 1 ? 1 : 0,
      notifications_acknowledged: 0, notifications_failed: 0,
    })),
  };
}

describe("area chart geometry", () => {
  it.each([[], [0], [1], [0, 100, 0], [3, 9, 12, 8], [1_000_000_000]].map((values) => ({ values })))("keeps a finite zero baseline for $values", ({ values }) => {
    const scale = chartScale(values);
    const geometry = areaGeometry(values, bounds, scale.maximum);
    expect(scale.maximum).toBeGreaterThanOrEqual(Math.max(1, ...values));
    expect(geometry.area).not.toMatch(/NaN|Infinity|C|Q/);
    expect(geometry.points.every((point) => point.vertical >= bounds.top && point.vertical <= bounds.bottom)).toBe(true);
    expect(scale.ticks.every(Number.isInteger)).toBe(true);
  });

  it("does not combine the currency and count scales", () => {
    expect(chartScale([1]).maximum).toBe(1);
    expect(chartScale([2000]).maximum).toBeGreaterThanOrEqual(2000);
    expect(areaGeometry([1], bounds, 1).points[0]?.vertical).toBe(bounds.top);
  });

  it("clamps pointer selection and handles empty or singleton series", () => {
    expect(chartIndex(-200, bounds, 7)).toBe(0);
    expect(chartIndex(900, bounds, 7)).toBe(6);
    expect(chartIndex(330, bounds, 7)).toBe(3);
    expect(chartIndex(330, bounds, 0)).toBe(0);
    expect(chartIndex(330, bounds, 1)).toBe(0);
  });
});

describe("linked amount and order charts", () => {
  it.each([7, 30, 90] as const)("renders two truthful area series for %i days", (days) => {
    const { container } = render(<DailyChart analytics={analytics(days)} />);
    expect(container.querySelectorAll("path.chart-area")).toHaveLength(2);
    expect([...container.querySelectorAll("path.chart-line")].map((line) => line.getAttribute("pathLength"))).toEqual(["1", "1"]);
    expect(container.querySelectorAll(".chart-point")).toHaveLength(2);
    expect(container.querySelector("svg")).not.toHaveAttribute("style");
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    expect(container.querySelector(".chart-readout")).toHaveTextContent("¥100.00");
  });

  it("shares the selected day across keyboard, buttons and data table", async () => {
    const user = userEvent.setup();
    const { container } = render(<DailyChart analytics={analytics()} />);
    const graph = screen.getByRole("group", { name: "每日金额与新建订单趋势" });
    graph.focus();
    fireEvent.keyDown(graph, { key: "Home" });
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-01");
    expect(screen.getByRole("button", { name: "前一天" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "后一天" }));
    expect(screen.getByText("2,000 笔")).toBeVisible();
    fireEvent.keyDown(graph, { key: "ArrowRight" });
    expect(container.querySelector(".chart-readout")).toHaveTextContent("¥0.01");
    fireEvent.keyDown(graph, { key: "End" });
    expect(screen.getByRole("button", { name: "后一天" })).toBeDisabled();
    await user.click(screen.getByText("查看每日数据表 · 北京时间"));
    expect(screen.getByRole("region", { name: "每日收款数据" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "日期（北京时间）" })).toBeVisible();
    expect(container.querySelector(".chart-readout time")).toHaveTextContent("北京时间");
    expect(container.querySelector("svg")).toHaveTextContent("06/01");
    expect(screen.getAllByRole("row")).toHaveLength(8);
  });

  it("selects both series on pointer input without blocking scrolling", () => {
    const { container } = render(<DailyChart analytics={analytics()} />);
    const graph = container.querySelector("svg")!;
    vi.spyOn(graph, "getBoundingClientRect").mockReturnValue({ width: 620, left: 0 } as DOMRect);
    fireEvent(graph, new MouseEvent("pointerdown", { bubbles: true, clientX: 62 }));
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-01");
    expect([...container.querySelectorAll(".chart-point")].map((element) => element.parentElement?.getAttribute("transform"))).toEqual(["translate(62 136)", "translate(62 290)"]);
  });



  it("keeps the graph, keyboard focus, selected date and expanded table across periods", async () => {
    const { container, rerender } = render(<DailyChart analytics={analytics(7)} />);
    const graph = screen.getByRole("group", { name: "每日金额与新建订单趋势" });
    await userEvent.setup().click(screen.getByText("查看每日数据表 · 北京时间"));
    graph.focus();
    fireEvent.keyDown(graph, { key: "Home" });
    fireEvent.keyDown(graph, { key: "ArrowRight" });
    const chart = container.querySelector(".daily-chart");
    rerender(<DailyChart analytics={analytics(30)} />);
    expect(container.querySelector(".daily-chart")).toBe(chart);
    expect(graph).toHaveFocus();
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-02");
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getAllByRole("row")).toHaveLength(31);
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("follows the newest date by default and clamps a selected day outside the new period", () => {
    const { container, rerender } = render(<DailyChart analytics={analytics(7)} />);
    const extended = analytics(30);
    rerender(<DailyChart analytics={extended} />);
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-30");
    fireEvent.keyDown(screen.getByRole("group", { name: "每日金额与新建订单趋势" }), { key: "Home" });
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-01");
    rerender(<DailyChart analytics={{ ...extended, range_days: 7, daily: extended.daily.slice(-7) }} />);
    expect(container.querySelector(".chart-readout time")).toHaveAttribute("datetime", "2026-06-30");
    expect(screen.getByRole("button", { name: "后一天" })).toBeDisabled();
  });

  it("shows zero and missing data explicitly instead of fake peaks", () => {
    const data = analytics();
    data.daily = data.daily.map((day) => ({ ...day, orders_created: 0, confirmed_amount_cents: 0, confirmations: 0 }));
    const { rerender } = render(<DailyChart analytics={data} />);
    expect(screen.getByText("暂无付款确认记录")).toBeInTheDocument();
    expect(screen.getByText("暂无新建订单")).toBeInTheDocument();
    rerender(<DailyChart analytics={{ ...data, daily: [] }} />);
    expect(screen.getByRole("heading", { name: "暂无每日统计" })).toBeVisible();
  });
});
