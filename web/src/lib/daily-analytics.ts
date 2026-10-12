import type { SystemAnalytics } from "@/api/client";

const DAY_MILLISECONDS = 86_400_000;
const BEIJING_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export type DailyDay = SystemAnalytics["daily"][number];

export interface DailyWeek {
  readonly key: string;
  readonly days: DailyDay[];
  readonly from: string;
  readonly to: string;
  readonly confirmedAmountCents: number;
  readonly confirmations: number;
  readonly ordersCreated: number;
  readonly inProgress: boolean;
}

export interface DailyReport {
  readonly days: DailyDay[];
  readonly weeks: DailyWeek[];
  readonly today: string;
  readonly maximum: number;
  readonly averageCents: number | null;
  readonly peak: DailyDay | null;
}

function calendarDate(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

function mondayKey(date: string): string {
  const day = calendarDate(date);
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

export function dailyDateLabel(date: string, includeYear = false): string {
  return includeYear ? date : date.slice(5);
}

export function dailyWeekday(date: string): string {
  return WEEKDAYS[calendarDate(date).getUTCDay()]!;
}

export function buildDailyReport(analytics: SystemAnalytics): DailyReport {
  const days = analytics.daily.toSorted((a, b) => b.date.localeCompare(a.date));
  // The response includes its current Beijing day and ends at the next midnight.
  const today = new Date(
    Date.parse(analytics.to) - 1 + BEIJING_OFFSET_MILLISECONDS,
  ).toISOString().slice(0, 10);
  const currentWeek = mondayKey(today);
  const grouped = new Map<string, DailyDay[]>();

  for (const day of days) {
    const key = mondayKey(day.date);
    const week = grouped.get(key);
    if (week) week.push(day);
    else grouped.set(key, [day]);
  }

  const weeks = Array.from(grouped, ([key, weekDays]): DailyWeek => ({
    key,
    days: weekDays,
    from: weekDays.at(-1)!.date,
    to: weekDays[0]!.date,
    confirmedAmountCents: weekDays.reduce(
      (total, day) => total + day.confirmed_amount_cents,
      0,
    ),
    confirmations: weekDays.reduce((total, day) => total + day.confirmations, 0),
    ordersCreated: weekDays.reduce((total, day) => total + day.orders_created, 0),
    inProgress: key === currentWeek,
  }));

  const completed = days.filter((day) => day.date < today);
  const averageCents = completed.length
    ? Math.round(completed.reduce(
      (total, day) => total + day.confirmed_amount_cents,
      0,
    ) / completed.length)
    : null;
  // Newest-first order makes the latest completed day win equal amounts.
  const peak = completed.reduce<DailyDay | null>(
    (best, day) => !best || day.confirmed_amount_cents > best.confirmed_amount_cents
      ? day
      : best,
    null,
  );

  return {
    days,
    weeks,
    today,
    maximum: days.reduce((maximum, day) => Math.max(maximum, day.confirmed_amount_cents), 0),
    averageCents,
    peak,
  };
}
