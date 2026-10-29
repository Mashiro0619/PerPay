import { describe, expect, it, vi } from "vitest";
import type { SystemAnalytics } from "../src/api/client";
import type { DailyDay } from "../src/lib/daily-analytics";
import { buildTrendReport } from "../src/lib/trend-analytics";

function day(date: string, amount = 0, orders = 0): DailyDay {
  return {
    date,
    confirmed_amount_cents: amount,
    orders_created: orders,
    confirmations: amount > 0 ? 1 : 0,
    notifications_acknowledged: 0,
    notifications_failed: 0,
  };
}

function analytics(
  daily: DailyDay[],
  to = "2026-10-29T16:00:00Z",
): SystemAnalytics {
  return {
    range_days: 7,
    from: "2026-10-22T16:00:00Z",
    to,
    orders: {
      created: 900,
      unpaid: 0,
      confirmed: 0,
      disputed: 0,
      closed: 0,
      expired: 0,
    },
    confirmations: { count: 90, amount_cents: 90000 },
    notifications: { acknowledged: 0, failed: 0, pending: 0 },
    pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
    daily,
  };
}

describe("trend calendar summaries", () => {
  it("keeps sparse amounts in cents and includes zero days in completed-day comparisons", () => {
    const report = buildTrendReport(
      analytics([
        day("2026-10-23"),
        day("2026-10-24"),
        day("2026-10-25", 101, 3),
        day("2026-10-26"),
        day("2026-10-27"),
        day("2026-10-28"),
        day("2026-10-29", 123456, 100),
      ]),
    );

    expect(report.today).toBe("2026-10-29");
    expect(report.completedDays).toBe(6);
    expect(report.data[2]).toMatchObject({
      date: "2026-10-25",
      amount: 101,
      orders: 3,
    });
    expect(report.data.at(-1)).toMatchObject({
      date: "2026-10-29",
      amount: 123456,
      orders: 100,
    });
    expect(report.amount).toEqual({
      total: 90000,
      average: 17,
      peak: { date: "2026-10-25", value: 101 },
      activeDays: 2,
    });
    expect(report.orders).toEqual({
      total: 900,
      average: 0.5,
      peak: { date: "2026-10-25", value: 3 },
      activeDays: 2,
    });
  });

  it("selects the latest completed tied peak independently for each metric", () => {
    const report = buildTrendReport(
      analytics([
        day("2026-10-26", 100, 7),
        day("2026-10-27", 100, 4),
        day("2026-10-28", 1, 7),
        day("2026-10-29", 99999, 999),
      ]),
    );

    expect(report.amount.peak).toEqual({ date: "2026-10-27", value: 100 });
    expect(report.orders.peak).toEqual({ date: "2026-10-28", value: 7 });
    expect(report.amount.average).toBe(67);
    expect(report.orders.average).toBe(6);
  });

  it("distinguishes zero completed days from a period with no completed days", () => {
    const zero = buildTrendReport(
      analytics([day("2026-10-28"), day("2026-10-29")]),
    );
    for (const metric of [zero.amount, zero.orders]) {
      expect(metric).toMatchObject({
        average: 0,
        peak: { date: null, value: 0 },
        activeDays: 0,
      });
    }

    const todayOnly = buildTrendReport(analytics([day("2026-10-29", 1, 1)]));
    expect(todayOnly.completedDays).toBe(0);
    expect(todayOnly.data).toHaveLength(1);
    for (const metric of [todayOnly.amount, todayOnly.orders]) {
      expect(metric).toMatchObject({
        average: null,
        peak: null,
        activeDays: 1,
      });
    }

    const empty = buildTrendReport(analytics([]));
    expect(empty.data).toEqual([]);
    expect(empty.completedDays).toBe(0);
    for (const metric of [empty.amount, empty.orders]) {
      expect(metric).toMatchObject({
        average: null,
        peak: null,
        activeDays: 0,
      });
    }
  });

  it("uses the server Beijing boundary across a year change regardless of the device clock", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2031-01-01T23:00:00Z"));
      for (const to of ["2026-01-01T16:00:00Z", "2026-01-02T00:00:00+08:00"]) {
        const report = buildTrendReport(
          analytics(
            [day("2025-12-31", 1, 1), day("2026-01-01", 99999, 999)],
            to,
          ),
        );
        expect(report.today).toBe("2026-01-01");
        expect(report.amount.average).toBe(1);
        expect(report.amount.peak).toEqual({ date: "2025-12-31", value: 1 });
        expect(report.orders.average).toBe(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("sorts immutable response rows oldest-first and preserves every day's evidence", () => {
    const input = analytics([
      day("2026-10-28", 2, 4),
      day("2026-10-29", 3, 6),
      day("2026-10-27", 1, 2),
    ]);
    const before = structuredClone(input);
    for (const value of input.daily) Object.freeze(value);
    Object.freeze(input.daily);
    Object.freeze(input);

    const report = buildTrendReport(input);
    expect(input).toEqual(before);
    expect(report.data.map((value) => value.date)).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
    ]);
    expect(report.data.map((value) => [value.amount, value.orders])).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ]);
    expect(report.data[1]).toMatchObject(before.daily[0]!);
  });
});
