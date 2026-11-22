import type { SystemAnalytics } from "@/api/client";

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const CALENDAR_WEEKDAYS = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
] as const;

export type DailyDay = SystemAnalytics["daily"][number];
export type CalendarHeatLevel = 0 | 1 | 2 | 3 | 4;

export interface CalendarCell {
  readonly iso: string;
  readonly day: DailyDay | null;
}

export interface DailyReport {
  readonly days: DailyDay[];
  readonly today: string;
  readonly maximum: number;
  readonly averageCents: number | null;
  readonly peak: DailyDay | null;
}

function calendarDate(date: string): Date {
  return new Date(date + "T00:00:00.000Z");
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

export function dailyDateLabel(date: string, includeYear = false): string {
  return includeYear ? date : date.slice(5);
}

export function dailyWeekday(date: string): string {
  return WEEKDAYS[calendarDate(date).getUTCDay()]!;
}

export function calendarCellDateLabel(
  date: string,
  today: string,
  firstDate: string,
  compact = false,
): string {
  if (date === today) return "今日";
  const day = Number(date.slice(8, 10));
  if (date === firstDate || date.endsWith("-01")) {
    const month = Number(date.slice(5, 7));
    return compact ? `${month}/${day}` : `${month}月${day}日`;
  }
  return String(day);
}

export function calendarHeatLevel(
  amountCents: number,
  maximumCents: number,
): CalendarHeatLevel {
  if (amountCents <= 0 || maximumCents <= 0) return 0;
  const ratio = amountCents / maximumCents;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.78) return 3;
  return 4;
}

export function compactCalendarMoney(cents: number): string {
  if (cents === 0) return "¥0";
  const sign = cents < 0 ? "-" : "";
  const absCents = Math.abs(cents);
  const yuan = absCents / 100;
  if (yuan < 100) {
    return `${sign}¥${yuan.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (yuan < 10_000) {
    return `${sign}¥${Math.round(yuan).toLocaleString("zh-CN")}`;
  }
  if (yuan < 100_000_000) {
    const wan = yuan / 10_000;
    const formatted = wan >= 100 ? Math.round(wan).toLocaleString("zh-CN") : trimTrailingZero(wan.toFixed(1));
    return `${sign}¥${formatted}万`;
  }
  if (yuan < 1_000_000_000_000) {
    const yi = yuan / 100_000_000;
    const formatted = yi >= 100 ? Math.round(yi).toLocaleString("zh-CN") : trimTrailingZero(yi.toFixed(1));
    return `${sign}¥${formatted}亿`;
  }
  const wanYi = yuan / 1_000_000_000_000;
  const formatted = wanYi >= 100 ? Math.round(wanYi).toLocaleString("zh-CN") : trimTrailingZero(wanYi.toFixed(1));
  return `${sign}¥${formatted}万亿`;
}

/** Build chronological Monday-to-Sunday calendar weeks covering the given days. */
export function buildCalendarWeeks(days: readonly DailyDay[]): CalendarCell[][] {
  if (!days.length) return [];
  const chronological = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(chronological.map((day) => [day.date, day]));
  const first = calendarDate(chronological[0]!.date);
  const last = calendarDate(chronological.at(-1)!.date);

  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const sundayPad = 6 - ((last.getUTCDay() + 6) % 7);
  const startMs = first.getTime() - mondayOffset * DAY_MILLISECONDS;
  const endMs = last.getTime() + sundayPad * DAY_MILLISECONDS;
  const totalCells = Math.round((endMs - startMs) / DAY_MILLISECONDS) + 1;

  const weeks: CalendarCell[][] = [];
  let week: CalendarCell[] = [];
  for (let index = 0; index < totalCells; index++) {
    const iso = new Date(startMs + index * DAY_MILLISECONDS).toISOString().slice(0, 10);
    week.push({ iso, day: byDate.get(iso) ?? null });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length) weeks.push(week);
  return weeks;
}

export function buildDailyCsv(days: readonly DailyDay[]): string {
  const ordered = [...days].sort((a, b) => b.date.localeCompare(a.date));
  const header = [
    "日期",
    "星期",
    "确认金额(元)",
    "确认笔数",
    "笔均金额(元)",
    "新建订单",
    "通知已确认",
    "通知失败",
  ].join(",");
  const rows = ordered.map((day) => {
    const avgCents = day.confirmations > 0
      ? Math.round(day.confirmed_amount_cents / day.confirmations)
      : 0;
    return [
      day.date,
      dailyWeekday(day.date),
      (day.confirmed_amount_cents / 100).toFixed(2),
      String(day.confirmations),
      (avgCents / 100).toFixed(2),
      String(day.orders_created),
      String(day.notifications_acknowledged),
      String(day.notifications_failed),
    ].join(",");
  });
  return "\uFEFF" + [header, ...rows].join("\r\n");
}

export function downloadDailyCsv(days: readonly DailyDay[]): void {
  if (!days.length) return;
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const first = ordered[0]!.date;
  const last = ordered.at(-1)!.date;
  const filename = first === last
    ? `perpay-daily-${first}.csv`
    : `perpay-daily-${first}-to-${last}.csv`;
  const blob = new Blob([buildDailyCsv(days)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildDailyReport(analytics: SystemAnalytics): DailyReport {
  const days = [...analytics.daily].sort((a, b) => b.date.localeCompare(a.date));
  // The response includes its current Beijing day and ends at the next midnight.
  const today = new Date(
    Date.parse(analytics.to) - 1 + BEIJING_OFFSET_MILLISECONDS,
  ).toISOString().slice(0, 10);
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
    today,
    maximum: days.reduce((maximum, day) => Math.max(maximum, day.confirmed_amount_cents), 0),
    averageCents,
    peak,
  };
}
