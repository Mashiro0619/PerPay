import { describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import {
  buildCalendarWeeks,
  buildDailyCsv,
  buildDailyReport,
  calendarCellDateLabel,
  calendarHeatLevel,
  compactCalendarMoney,
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

  it("aligns calendar weeks Monday-to-Sunday with empty boundary padding", () => {
    // 2026-10-07 is Wednesday (offset 2), 2026-10-12 is Monday (sunday pad 6)
    const input = [
      day("2026-10-12", 500),
      day("2026-10-07", 200),
      day("2026-10-08", 0),
      day("2026-10-09", 300),
      day("2026-10-10", 0),
      day("2026-10-11", 400),
    ];
    const weeks = buildCalendarWeeks(input);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]!.map((cell) => cell.day?.date ?? null)).toEqual([
      null,
      null,
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(weeks[1]!.map((cell) => cell.day?.date ?? null)).toEqual([
      "2026-10-12",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(buildCalendarWeeks([])).toEqual([]);
  });

  it("computes compact cell currency, heat levels, cell labels and UTF-8 BOM CSV", () => {
    expect(compactCalendarMoney(0)).toBe("¥0");
    expect(compactCalendarMoney(1)).toBe("¥0.01");
    expect(compactCalendarMoney(9999)).toBe("¥99.99");
    expect(compactCalendarMoney(220321)).toBe("¥2,203");
    expect(compactCalendarMoney(1_250_000)).toBe("¥1.3万");
    expect(compactCalendarMoney(123_456_789_012)).toBe("¥12.3亿");
    expect(compactCalendarMoney(2_000_000_000_000_000)).toBe("¥20万亿");

    expect(calendarHeatLevel(0, 1000)).toBe(0);
    expect(calendarHeatLevel(100, 0)).toBe(0);
    expect(calendarHeatLevel(200, 1000)).toBe(1);
    expect(calendarHeatLevel(400, 1000)).toBe(2);
    expect(calendarHeatLevel(700, 1000)).toBe(3);
    expect(calendarHeatLevel(1000, 1000)).toBe(4);

    expect(calendarCellDateLabel("2026-11-23", "2026-11-23", "2026-10-25")).toBe("今日");
    expect(calendarCellDateLabel("2026-10-25", "2026-11-23", "2026-10-25")).toBe("10月25日");
    expect(calendarCellDateLabel("2026-10-25", "2026-11-23", "2026-10-25", true)).toBe("10/25");
    expect(calendarCellDateLabel("2026-11-01", "2026-11-23", "2026-10-25")).toBe("11月1日");
    expect(calendarCellDateLabel("2026-11-01", "2026-11-23", "2026-10-25", true)).toBe("11/1");
    expect(calendarCellDateLabel("2026-11-17", "2026-11-23", "2026-10-25")).toBe("17");

    const csv = buildDailyCsv([
      { ...day("2026-10-06", 10050, 2, 3), notifications_acknowledged: 2, notifications_failed: 0 },
      { ...day("2026-10-07", 0, 0, 1), notifications_acknowledged: 0, notifications_failed: 1 },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("日期,星期,确认金额(元),确认笔数,笔均金额(元),新建订单,通知已确认,通知失败");
    expect(lines[1]).toBe("2026-10-07,周三,0.00,0,0.00,1,0,1");
    expect(lines[2]).toBe("2026-10-06,周二,100.50,2,50.25,3,2,0");
  });
});
