import type { SystemAnalytics } from "@/api/client";
import { buildDailyReport, type DailyDay } from "@/lib/daily-analytics";

export type TrendMetric = "amount" | "orders";

export type TrendDay = DailyDay & {
  /** Amounts remain in cents until display formatting. */
  readonly amount: number;
  readonly orders: number;
};

export interface TrendMetricSummary {
  readonly total: number;
  readonly average: number | null;
  readonly peak: {
    readonly date: string | null;
    readonly value: number;
  } | null;
  readonly activeDays: number;
}

export interface TrendReport {
  readonly today: string;
  readonly data: TrendDay[];
  readonly completedDays: number;
  readonly amount: TrendMetricSummary;
  readonly orders: TrendMetricSummary;
}

function summarize(
  days: TrendDay[],
  completed: TrendDay[],
  metric: TrendMetric,
  total: number,
): TrendMetricSummary {
  const average = completed.length
    ? completed.reduce((sum, day) => sum + day[metric], 0) / completed.length
    : null;
  // Days are oldest-first, so a tie advances to the most recent completed day.
  const peak = completed.reduce<TrendDay | null>(
    (best, day) => (!best || day[metric] >= best[metric] ? day : best),
    null,
  );

  return {
    total,
    average:
      average !== null && metric === "amount" ? Math.round(average) : average,
    // A zero maximum is real evidence, but no date earned a meaningful peak.
    peak: peak
      ? { date: peak[metric] > 0 ? peak.date : null, value: peak[metric] }
      : null,
    activeDays: days.filter((day) => day[metric] > 0).length,
  };
}

export function buildTrendReport(analytics: SystemAnalytics): TrendReport {
  const daily = buildDailyReport(analytics);
  const data = [...daily.days].reverse().map((day) => ({
    ...day,
    amount: day.confirmed_amount_cents,
    orders: day.orders_created,
  }));
  const completed = data.filter((day) => day.date < daily.today);

  return {
    today: daily.today,
    data,
    completedDays: completed.length,
    // Aggregate fields own the totals; daily rows own calendar comparisons.
    amount: summarize(
      data,
      completed,
      "amount",
      analytics.confirmations.amount_cents,
    ),
    orders: summarize(data, completed, "orders", analytics.orders.created),
  };
}
