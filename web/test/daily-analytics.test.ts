import { describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import {
  buildDailyReport,
  dailyDateLabel,
  dailyWeekday,
  type DailyDay,
} from "../src/lib/daily-analytics";

function day(date: string, amount = 0, confirmations = 0, orders = 0): DailyDay {
  return {
    date,
    confirmed_amount_cents: amount,
    confirmations,
    orders_created: orders,
    notifications_acknowledged: 0,
    notifications_failed: 0,
  };
}

function analytics(daily: DailyDay[], to: string): SystemAnalytics {
  return {
    range_days: 7,
    from: (daily[0]?.date ?? "2026-10-06") + "T00:00:00+08:00",
    to,
    orders: { created: 999, unpaid: 0, confirmed: 0, disputed: 0, closed: 0, expired: 0 },
    confirmations: { count: 999, amount_cents: 999 },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
    daily,
  };
}

describe("daily report calendar and comparisons", () => {
  it("keeps every returned date newest-first without adding grouping rows or missing days", () => {
    const report = buildDailyReport(analytics([
      day("2026-10-06", 100, 1, 2),
      day("2026-10-07", 200, 2, 3),
      day("2026-10-08", 0, 0, 1),
      day("2026-10-09", 300, 3, 4),
      day("2026-10-10", 0, 0, 0),
      day("2026-10-11", 400, 4, 5),
      day("2026-10-12", 500, 5, 6),
    ], "2026-10-12T16:00:00.000Z"));

    expect(report.today).toBe("2026-10-12");
    expect(report.days.map((value) => value.date)).toEqual([
      "2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06",
    ]);
    expect(report.days[0]).toMatchObject({ confirmed_amount_cents: 500, confirmations: 5, orders_created: 6 });
    expect(report.days.at(-1)).toMatchObject({ confirmed_amount_cents: 100, confirmations: 1, orders_created: 2 });
  });

  it.each([
    {
      dates: ["2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03"],
      to: "2026-01-03T16:00:00Z",
    },
    {
      dates: ["2028-02-26", "2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02", "2028-03-03"],
      to: "2028-03-03T16:00:00Z",
    },
  ])("keeps dates continuous across year and leap-day boundaries", ({ dates, to }) => {
    const report = buildDailyReport(analytics(dates.map((date) => day(date)), to));
    expect(report.days.map((value) => value.date)).toEqual([...dates].reverse());
    expect(new Set(report.days.map((value) => value.date)).size).toBe(dates.length);
  });

  it("uses the response's exclusive Beijing boundary for today, independently of the device date", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-01-01T23:00:00Z"));
      for (const to of ["2026-01-01T16:00:00Z", "2026-01-02T00:00:00+08:00"]) {
        const report = buildDailyReport(analytics([
          day("2025-12-31", 101), day("2026-01-01", 9999),
        ], to));
        expect(report.today).toBe("2026-01-01");
        expect(report.averageCents).toBe(101);
        expect(report.peak?.date).toBe("2025-12-31");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("compares completed days including zeros, rounds to cents and picks the latest tied peak", () => {
    const report = buildDailyReport(analytics([
      day("2026-10-06", 100), day("2026-10-07", 0), day("2026-10-08", 100),
      day("2026-10-09", 1), day("2026-10-10", 0), day("2026-10-11", 0),
      day("2026-10-12", 10000),
    ], "2026-10-12T16:00:00Z"));
    expect(report.averageCents).toBe(34);
    expect(report.maximum).toBe(10000);
    expect(report.peak).toMatchObject({ date: "2026-10-08", confirmed_amount_cents: 100 });
  });

  it("preserves all-zero evidence and distinguishes no completed days from a zero average", () => {
    const zero = buildDailyReport(analytics([
      day("2026-10-11"), day("2026-10-12"),
    ], "2026-10-12T16:00:00Z"));
    expect(zero.averageCents).toBe(0);
    expect(zero.maximum).toBe(0);
    expect(zero.peak?.date).toBe("2026-10-11");

    const todayOnly = buildDailyReport(analytics([day("2026-10-12", 125)], "2026-10-12T16:00:00Z"));
    expect(todayOnly.averageCents).toBeNull();
    expect(todayOnly.peak).toBeNull();
    expect(todayOnly.maximum).toBe(125);

    const empty = buildDailyReport(analytics([], "2026-10-12T16:00:00Z"));
    expect(empty).toMatchObject({ days: [], maximum: 0, averageCents: null, peak: null });
  });

  it("sorts shuffled dates without toSorted or mutations to the response and its day records", () => {
    const input = analytics([
      day("2026-10-10", 10), day("2026-10-12", 30), day("2026-10-11", 20),
    ], "2026-10-12T16:00:00Z");
    const before = structuredClone(input);
    for (const value of input.daily) Object.freeze(value);
    Object.freeze(input.daily);
    Object.freeze(input);

    const toSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    Reflect.deleteProperty(Array.prototype, "toSorted");
    try {
      const report = buildDailyReport(input);
      expect(input).toEqual(before);
      expect(report.days.map((value) => value.date)).toEqual(["2026-10-12", "2026-10-11", "2026-10-10"]);
      expect(report.days).not.toBe(input.daily);
    } finally {
      if (toSorted) Object.defineProperty(Array.prototype, "toSorted", toSorted);
    }
  });

  it("formats short calendar dates and Chinese weekdays without local time conversion", () => {
    expect(dailyDateLabel("2026-01-01")).toBe("01-01");
    expect(dailyDateLabel("2026-01-01", true)).toBe("2026-01-01");
    expect(dailyWeekday("2026-10-05")).toBe("周一");
    expect(dailyWeekday("2026-10-11")).toBe("周日");
    expect(dailyWeekday("2026-01-01")).toBe("周四");
    expect(dailyWeekday("2028-02-29")).toBe("周二");
  });
});
