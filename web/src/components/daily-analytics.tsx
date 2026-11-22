import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useInRouterContext } from "react-router";
import { ArrowRight, Download, Star } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { count, money } from "@/lib/format";
import {
  CALENDAR_WEEKDAYS,
  buildCalendarWeeks,
  buildDailyReport,
  calendarCellDateLabel,
  calendarHeatLevel,
  compactCalendarMoney,
  dailyDateLabel,
  dailyWeekday,
  downloadDailyCsv,
} from "@/lib/daily-analytics";
import { ListMoney } from "@/components/list-primitives";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";

const LOADING_WEEKS = 5;

type DailyAnalyticsProps = {
  analytics: SystemAnalytics | undefined;
  range: number;
  pending: boolean;
  scopeKey?: string;
};

export function DailyAnalytics({
  analytics,
  range,
  pending,
  scopeKey = "all",
}: DailyAnalyticsProps) {
  const inRouter = useInRouterContext();
  const [selection, setSelection] = useState<{ scope: string; date: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const scrolledKeyRef = useRef<string | null>(null);

  const report = useMemo(
    () => (analytics && !pending ? buildDailyReport(analytics) : null),
    [analytics, pending],
  );
  const days = report?.days ?? [];
  const totalDays = days.length;
  const hasDays = totalDays > 0;

  const { weeks, daysByDate, chronologicalDates, indexByDate } = useMemo(() => {
    const calendarWeeks = buildCalendarWeeks(days);
    const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const map = new Map(ordered.map((day) => [day.date, day]));
    const dates = ordered.map((day) => day.date);
    const indexes = new Map(dates.map((date, index) => [date, index]));
    return {
      weeks: calendarWeeks,
      daysByDate: map,
      chronologicalDates: dates,
      indexByDate: indexes,
    };
  }, [days]);

  const firstDate = chronologicalDates[0] ?? "";
  const lastDate = chronologicalDates.at(-1) ?? "";
  const includeYear = Boolean(firstDate && lastDate && firstDate.slice(0, 4) !== lastDate.slice(0, 4));
  const peakDate = report?.peak?.date ?? null;
  const activeDays = days.filter((day) => day.confirmed_amount_cents > 0).length;
  const totalFailedNotifications = days.reduce(
    (sum, day) => sum + day.notifications_failed,
    0,
  );

  const defaultSelectedDate =
    report?.peak && report.peak.confirmed_amount_cents > 0
      ? report.peak.date
      : (report?.days[0]?.date ?? null);

  const selectedDate =
    selection &&
    selection.scope === scopeKey &&
    daysByDate.has(selection.date)
      ? selection.date
      : defaultSelectedDate;
  const selectedDay = selectedDate ? (daysByDate.get(selectedDate) ?? null) : null;

  const isScrollable = weeks.length > 6;

  useEffect(() => {
    if (pending || !isScrollable || !selectedDate) return;
    const container = scrollRef.current;
    const cell = cellRefs.current.get(selectedDate);
    if (!container || !cell) return;
    const scrollKey = `${scopeKey}:${range}:${firstDate}:${lastDate}`;
    if (scrolledKeyRef.current === scrollKey) return;
    scrolledKeyRef.current = scrollKey;
    const containerRect = container.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const relativeTop = cellRect.top - containerRect.top + container.scrollTop;
    const target = relativeTop - (container.clientHeight - cell.offsetHeight) / 2;
    container.scrollTop = Math.max(0, target);
  }, [pending, isScrollable, selectedDate, scopeKey, range, firstDate, lastDate]);

  function handleCellKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentDate: string) {
    const currentIndex = indexByDate.get(currentDate);
    if (currentIndex === undefined) return;

    let targetIndex: number | null = null;
    if (event.key === "ArrowLeft") targetIndex = currentIndex - 1;
    else if (event.key === "ArrowRight") targetIndex = currentIndex + 1;
    else if (event.key === "ArrowUp") targetIndex = currentIndex - 7;
    else if (event.key === "ArrowDown") targetIndex = currentIndex + 7;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = chronologicalDates.length - 1;

    if (targetIndex === null || targetIndex < 0 || targetIndex >= chronologicalDates.length) {
      return;
    }

    const targetDate = chronologicalDates[targetIndex];
    if (!targetDate) return;
    event.preventDefault();
    setSelection({ scope: scopeKey, date: targetDate });
    const targetNode = cellRefs.current.get(targetDate);
    if (targetNode) {
      targetNode.focus();
      const container = scrollRef.current;
      if (container && isScrollable) {
        const containerRect = container.getBoundingClientRect();
        const nodeRect = targetNode.getBoundingClientRect();
        if (nodeRect.top < containerRect.top) {
          container.scrollTop -= containerRect.top - nodeRect.top + 8;
        } else if (nodeRect.bottom > containerRect.bottom) {
          container.scrollTop += nodeRect.bottom - containerRect.bottom + 8;
        }
      }
    }
  }

  const selectedIsToday = Boolean(selectedDay && report && selectedDay.date === report.today);
  const selectedIsPeak = Boolean(
    selectedDay &&
    peakDate === selectedDay.date &&
    selectedDay.confirmed_amount_cents > 0,
  );
  const selectedDeltaPct =
    selectedDay &&
    !selectedIsToday &&
    report?.averageCents &&
    report.averageCents > 0 &&
    selectedDay.confirmed_amount_cents > 0
      ? Math.round(
        ((selectedDay.confirmed_amount_cents - report.averageCents) / report.averageCents) * 100,
      )
      : null;
  const selectedAverageTicket =
    selectedDay && selectedDay.confirmations > 0
      ? Math.round(selectedDay.confirmed_amount_cents / selectedDay.confirmations)
      : null;

  return (
    <div className="daily-report" role="region" aria-label="每日数据" aria-busy={pending}>
      {pending ? (
        <div className="daily-cal-loading" aria-hidden="true">
          <div className="daily-cal-top">
            <div className="daily-cal-summary">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
            </div>
            <Skeleton className="h-6 w-20" />
          </div>
          <div className="daily-cal-surface">
            <div className="daily-cal-week daily-cal-loading-head">
              {CALENDAR_WEEKDAYS.map((weekday) => (
                <Skeleton key={weekday} className="mx-auto h-3.5 w-8" />
              ))}
            </div>
            <div className="daily-cal-loading-grid">
              {Array.from({ length: LOADING_WEEKS * 7 }, (_, index) => (
                <Skeleton key={index} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          </div>
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : hasDays && report && analytics ? (
        <>
          <div className="daily-cal-top">
            <dl className="daily-cal-summary" aria-label="每日数据汇总">
              <div className="daily-cal-summary-item" data-daily-summary="total">
                <dt>区间实收</dt>
                <dd className="daily-cal-summary-primary">
                  <ListMoney value={analytics.confirmations.amount_cents} />
                </dd>
              </div>
              <div className="daily-cal-summary-item" data-daily-summary="average">
                <dt>日均</dt>
                <dd>
                  <ListMoney value={report.averageCents} />
                </dd>
              </div>
              <div className="daily-cal-summary-item" data-daily-summary="peak">
                <dt>单日最高</dt>
                <dd>
                  <ListMoney value={report.peak?.confirmed_amount_cents} />
                  {report.peak && (
                    <span className="daily-cal-summary-date">
                      {" ("}
                      <time dateTime={report.peak.date}>
                        {dailyDateLabel(report.peak.date, includeYear)}
                      </time>
                      {")"}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="daily-cal-tools">
              {totalFailedNotifications > 0 && (
                <span className="daily-cal-legend">
                  <span className="daily-cal-fail-dot" aria-hidden="true" />
                  通知异常
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="daily-cal-export"
                onClick={() => downloadDailyCsv(days)}
              >
                <Download aria-hidden="true" data-icon="inline-start" />
                导出 CSV
              </Button>
            </div>
          </div>

          <div className="daily-cal-surface" data-daily-surface="true">
            <div role="grid" aria-label="每日收款日历" className="daily-cal-grid-wrap">
              <div role="rowgroup" className="daily-cal-head">
                <div role="row" className="daily-cal-week">
                  {CALENDAR_WEEKDAYS.map((weekday) => (
                    <div key={weekday} role="columnheader" className="daily-cal-weekday">
                      {weekday}
                    </div>
                  ))}
                </div>
              </div>
              <div
                ref={scrollRef}
                role="rowgroup"
                className="daily-cal-body"
                data-scrollable={isScrollable || undefined}
                tabIndex={isScrollable ? 0 : undefined}
                aria-label="每日收款记录"
              >
                {weeks.map((week) => (
                  <div key={week[0]!.iso} role="row" className="daily-cal-week">
                    {week.map((cell) => {
                      if (!cell.day) {
                        return <div key={cell.iso} role="gridcell" className="daily-cal-pad" />;
                      }
                      const day = cell.day;
                      const isToday = day.date === report.today;
                      const isPeak = peakDate === day.date && day.confirmed_amount_cents > 0;
                      const level = calendarHeatLevel(day.confirmed_amount_cents, report.maximum);
                      const isSelected = day.date === selectedDate;
                      const cellLabel = calendarCellDateLabel(day.date, report.today, firstDate);
                      const compactCellLabel = calendarCellDateLabel(
                        day.date,
                        report.today,
                        firstDate,
                        true,
                      );
                      const ariaParts = [
                        `${day.date} ${dailyWeekday(day.date)}`,
                        isToday ? "今日" : null,
                        isPeak ? "单日最高" : null,
                        `确认金额 ${money(day.confirmed_amount_cents)}`,
                        `确认 ${count(day.confirmations)} 笔`,
                        `新建订单 ${count(day.orders_created)} 笔`,
                        day.notifications_failed > 0
                          ? `通知失败 ${count(day.notifications_failed)} 次`
                          : null,
                      ].filter(Boolean);

                      return (
                        <div key={day.date} role="gridcell" className="daily-cal-slot">
                          <Button
                            type="button"
                            variant="ghost"
                            ref={(node) => {
                              if (node) cellRefs.current.set(day.date, node);
                              else cellRefs.current.delete(day.date);
                            }}
                            className="daily-cal-cell"
                            data-cal-date={day.date}
                            data-cal-level={level}
                            data-selected={isSelected || undefined}
                            data-daily-today={isToday || undefined}
                            data-daily-peak={isPeak || undefined}
                            data-daily-zero={day.confirmed_amount_cents === 0 || undefined}
                            aria-pressed={isSelected}
                            aria-label={ariaParts.join("，")}
                            onClick={() => setSelection({ scope: scopeKey, date: day.date })}
                            onKeyDown={(event) => handleCellKeyDown(event, day.date)}
                          >
                            <span className="daily-cal-cell-head">
                              <span className="daily-date daily-cal-date">
                                <time dateTime={day.date} title={day.date}>
                                  {compactCellLabel !== cellLabel ? (
                                    <>
                                      <span className="daily-cal-date-full">{cellLabel}</span>
                                      <span className="daily-cal-date-short" aria-hidden="true">
                                        {compactCellLabel}
                                      </span>
                                    </>
                                  ) : (
                                    cellLabel
                                  )}
                                </time>
                              </span>
                              {(isPeak || day.notifications_failed > 0) && (
                                <span className="daily-cal-indicators" aria-hidden="true">
                                  {isPeak && <Star className="daily-cal-peak-icon" />}
                                  {day.notifications_failed > 0 && (
                                    <span className="daily-cal-fail-dot" />
                                  )}
                                </span>
                              )}
                            </span>
                            <span className="daily-cal-cell-body" aria-hidden="true">
                              <span className="daily-cal-amount">
                                {compactCalendarMoney(day.confirmed_amount_cents)}
                              </span>
                              <span className="daily-cal-count">
                                {count(day.confirmations)} 笔
                              </span>
                            </span>
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {selectedDay && (
            <div className="daily-cal-detail" data-daily-detail={selectedDay.date}>
              <div className="daily-cal-detail-info">
                <div className="daily-cal-detail-head">
                  <time className="daily-cal-detail-date" dateTime={selectedDay.date}>
                    {selectedDay.date}
                  </time>
                  <span className="daily-cal-detail-weekday">
                    {dailyWeekday(selectedDay.date)}
                  </span>
                  {selectedIsToday && (
                    <Badge variant="secondary" className="daily-day-badge">
                      今日累计中
                    </Badge>
                  )}
                  {selectedIsPeak && (
                    <Badge variant="outline" className="daily-day-badge">
                      单日最高
                    </Badge>
                  )}
                  {selectedDeltaPct !== null && (
                    <span className="daily-cal-detail-delta">
                      较日均 {selectedDeltaPct >= 0 ? `+${selectedDeltaPct}` : selectedDeltaPct}%
                    </span>
                  )}
                </div>

                <dl className="daily-cal-detail-metrics" aria-label="选中日期明细">
                  <div className="daily-cal-detail-metric" data-detail-metric="amount">
                    <dt>实收</dt>
                    <dd className="daily-cal-detail-amount">
                      <ListMoney value={selectedDay.confirmed_amount_cents} />
                    </dd>
                  </div>
                  <div className="daily-cal-detail-metric" data-detail-metric="confirmations">
                    <dt>确认</dt>
                    <dd>{count(selectedDay.confirmations)} 笔</dd>
                  </div>
                  <div className="daily-cal-detail-metric" data-detail-metric="average">
                    <dt>笔均</dt>
                    <dd>
                      {selectedAverageTicket !== null ? (
                        <ListMoney value={selectedAverageTicket} />
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div className="daily-cal-detail-metric" data-detail-metric="orders">
                    <dt>新建</dt>
                    <dd>{count(selectedDay.orders_created)} 笔</dd>
                  </div>
                  {selectedDay.notifications_failed > 0 && (
                    <div className="daily-cal-detail-metric" data-detail-metric="notifications">
                      <dt>通知</dt>
                      <dd className="daily-cal-detail-warn">
                        失败 {count(selectedDay.notifications_failed)} 次
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              {inRouter && (
                <div className="daily-cal-detail-actions">
                  {selectedDay.notifications_failed > 0 && (
                    <Link
                      to={`/notifications?created_from=${selectedDay.date}&created_to=${selectedDay.date}`}
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "daily-cal-warn-action",
                      )}
                    >
                      排查通知
                      <ArrowRight aria-hidden="true" data-icon="inline-end" />
                    </Link>
                  )}
                  <Link
                    to={`/orders?created_from=${selectedDay.date}&created_to=${selectedDay.date}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    查看当天订单
                    <ArrowRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="daily-cal-empty">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{analytics ? "暂无每日数据" : "统计数据暂不可用"}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      )}

      <div className="daily-report-footer">
        <p role="status" aria-live="polite" aria-atomic="true" className="daily-report-status">
          {pending ? "正在读取每日数据…" : !analytics ? "等待统计数据" : `共 ${totalDays} 天`}
        </p>
        {!pending && hasDays && report && analytics && (
          <p className="daily-report-meta">
            有收款 {count(activeDays)} 天 · 确认 {count(analytics.confirmations.count)} 笔 · 新建{" "}
            {count(analytics.orders.created)} 笔
          </p>
        )}
      </div>
    </div>
  );
}
