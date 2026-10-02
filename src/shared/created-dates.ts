const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
export class CreatedDateError extends Error {}
export function beijingDate(now = Date.now()): string {
  return new Date(now + OFFSET).toISOString().slice(0, 10);
}
function dayStart(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1970-01-01")
    throw new CreatedDateError("日期须为有效的 YYYY-MM-DD");
  const utc = Date.parse(value + "T00:00:00.000Z");
  if (
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== value
  )
    throw new CreatedDateError("日期须为有效的 YYYY-MM-DD");
  return utc - OFFSET;
}
/** Inclusive Beijing dates become a half-open timestamp interval. */
export function createdDateRange(from?: string, to?: string) {
  if (from === undefined && to === undefined) return null;
  if (from === undefined || to === undefined)
    throw new CreatedDateError("请同时提供开始和结束日期");
  const start = dayStart(from),
    end = dayStart(to) + DAY;
  if (start >= end) throw new CreatedDateError("开始日期不能晚于结束日期");
  return { start, end, days: (end - start) / DAY };
}
export function createdDatePreset(
  days: number,
  yesterday = false,
  now = Date.now(),
) {
  const to = beijingDate(now - (yesterday ? DAY : 0));
  return { from: beijingDate(dayStart(to) - (days - 1) * DAY), to };
}
