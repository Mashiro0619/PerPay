import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useInRouterContext } from "react-router";
import { ArrowRight, Star, TrendingDown } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { count, money, naturalCollator } from "@/lib/format";
import {
  CALENDAR_WEEKDAYS,
  buildCalendarWeeks,
  buildDailyReport,
  calendarCellDateLabel,
  calendarHeatLevel,
  compactCalendarMoney,
  compactDeltaPercent,
  dailyDeltaPercent,
  dailyWeekday,
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
    const ordered = days.toSorted((a, b) => naturalCollator.compare(a.date, b.date));
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
  const peakDate = report?.peak && report.peak.confirmed_amount_cents > 0 ? report.peak.date : null;
  const lowestDate = report?.lowest?.date ?? null;
  const activeDays = days.filter((day) => day.confirmed_amount_cents > 0).length;

  const defaultSelectedDate = peakDate ?? report?.days[0]?.date ?? null;

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

    if (targetIndex === null) return;
    event.preventDefault();
    if (targetIndex < 0 || targetIndex >= chronologicalDates.length) {
      return;
    }

    const targetDate = chronologicalDates[targetIndex];
    if (!targetDate) return;
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
  const selectedIsPeak = Boolean(selectedDay && peakDate === selectedDay.date);
  const selectedIsLowest = Boolean(selectedDay && lowestDate === selectedDay.date);
  const selectedDeltaPct =
    selectedDay && !selectedIsToday
      ? dailyDeltaPercent(selectedDay.confirmed_amount_cents, report?.averageCents ?? null)
      : null;
  const selectedAverageTicket =
    selectedDay && selectedDay.confirmations > 0
      ? Math.round(selectedDay.confirmed_amount_cents / selectedDay.confirmations)
      : null;

  return (
    <div className="daily-report" role="region" aria-label="每日数据" aria-busy={pending}>
      {pending ? (
        <div className="daily-cal-loading" aria-hidden="true">
          <div className="daily-cal-detail">
            <div className="daily-cal-detail-header">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-7 w-28" />
            </div>
            <div className="daily-cal-detail-grid">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="daily-cal-detail-cell">
                  <Skeleton className="h-3.5 w-14" />
                  <Skeleton className="h-5 w-20" />
                </div>
              ))}
            </div>
          </div>
          <div className="daily-cal-surface">
            <div className="daily-cal-week daily-cal-loading-head">
              {CALENDAR_WEEKDAYS.map((weekday) => (
                <Skeleton key={weekday} className="mx-auto h-3.5 w-8" />
              ))}
            </div>
            <div className="daily-cal-loading-grid">
              {Array.from({ length: LOADING_WEEKS * 7 }, (_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      ) : hasDays && report && analytics ? (
        <>
          {selectedDay && (
            <div className="daily-cal-detail" data-daily-detail={selectedDay.date}>
              <div className="daily-cal-detail-header">
                <div className="daily-cal-detail-identity">
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
                  {selectedIsLowest && (
                    <Badge variant="outline" className="daily-day-badge">
                      单日最低
                    </Badge>
                  )}
                  {selectedDeltaPct !== null && (
                    <Badge variant="outline" className="daily-day-badge daily-cal-delta-badge">
                      较日均 {selectedDeltaPct > 0 ? `+${selectedDeltaPct}` : selectedDeltaPct}%
                    </Badge>
                  )}
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

              <dl
                className="daily-cal-detail-grid"
                data-has-warning={selectedDay.notifications_failed > 0 || undefined}
                aria-label="选中日期明细"
              >
                <div
                  className="daily-cal-detail-cell daily-cal-detail-primary"
                  data-detail-metric="amount"
                >
                  <dt>当日实收</dt>
                  <dd>
                    <ListMoney value={selectedDay.confirmed_amount_cents} />
                  </dd>
                </div>
                <div className="daily-cal-detail-cell" data-detail-metric="confirmations">
                  <dt>确认笔数</dt>
                  <dd>{count(selectedDay.confirmations)} 笔</dd>
                </div>
                <div className="daily-cal-detail-cell" data-detail-metric="average">
                  <dt>笔均金额</dt>
                  <dd>
                    {selectedAverageTicket !== null ? (
                      <ListMoney value={selectedAverageTicket} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div className="daily-cal-detail-cell" data-detail-metric="orders">
                  <dt>新建订单</dt>
                  <dd>{count(selectedDay.orders_created)} 笔</dd>
                </div>
                {selectedDay.notifications_failed > 0 && (
                  <div className="daily-cal-detail-cell" data-detail-metric="notifications">
                    <dt>通知异常</dt>
                    <dd className="daily-cal-detail-warn">
                      失败 {count(selectedDay.notifications_failed)} 次
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          <div className="daily-cal-surface" data-daily-surface="true">
            <div className="daily-cal-grid-wrap">
              <div
                ref={scrollRef}
                role="grid"
                aria-label="每日收款日历"
                className="daily-cal-body"
                data-scrollable={isScrollable || undefined}
              >
                <div role="rowgroup" className="daily-cal-head">
                  <div role="row" className="daily-cal-week">
                    {CALENDAR_WEEKDAYS.map((weekday) => (
                      <div key={weekday} role="columnheader" className="daily-cal-weekday">
                        {weekday}
                      </div>
                    ))}
                  </div>
                </div>
                <div role="rowgroup" className="daily-cal-rows">
                  {weeks.map((week) => (
                    <div key={week[0]!.iso} role="row" className="daily-cal-week">
                      {week.map((cell) => {
                        if (!cell.day) {
                          return <div key={cell.iso} role="gridcell" className="daily-cal-pad" />;
                      }
                      const day = cell.day;
                      const isToday = day.date === report.today;
                      const isPeak = peakDate === day.date;
                      const isLowest = lowestDate === day.date;
                      const deltaPct = isToday
                        ? null
                        : dailyDeltaPercent(day.confirmed_amount_cents, report.averageCents);
                      const level = calendarHeatLevel(day.confirmed_amount_cents, report.maximum);
                      const isSelected = day.date === selectedDate;
                      const isFocusable = isSelected || (!selectedDate && day.date === firstDate);
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
                        isLowest ? "单日最低" : null,
                        `确认金额 ${money(day.confirmed_amount_cents)}`,
                        deltaPct !== null
                          ? `较日均 ${deltaPct > 0 ? `+${deltaPct}` : deltaPct}%`
                          : null,
                        `确认 ${count(day.confirmations)} 笔`,
                        `新建订单 ${count(day.orders_created)} 笔`,
                      ].filter(Boolean);

                      return (
                        <div key={day.date} role="gridcell" className="daily-cal-slot">
                          <Button
                            type="button"
                            variant="ghost"
                            tabIndex={isFocusable ? 0 : -1}
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
                            data-daily-lowest={isLowest || undefined}
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
                              {(isPeak || isLowest) && (
                                <span
                                  className={cn(
                                    "daily-cal-mark",
                                    isPeak ? "daily-cal-mark-peak" : "daily-cal-mark-low",
                                  )}
                                  title={isPeak ? "单日最高" : "单日最低"}
                                  aria-hidden="true"
                                >
                                  {isPeak ? (
                                    <Star className="daily-cal-mark-icon daily-cal-mark-star" />
                                  ) : (
                                    <TrendingDown className="daily-cal-mark-icon" strokeWidth={2.25} />
                                  )}
                                </span>
                              )}
                            </span>
                            <span className="daily-cal-cell-body" aria-hidden="true">
                              <span className="daily-cal-amount">
                                {compactCalendarMoney(day.confirmed_amount_cents)}
                              </span>
                              <span className="daily-cal-cell-foot">
                                <span className="daily-cal-count">
                                  {count(day.confirmations)} 笔
                                </span>
                                {deltaPct !== null && (
                                  <span
                                    className="daily-cal-delta"
                                    data-delta-sign={
                                      deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat"
                                    }
                                  >
                                    {compactDeltaPercent(deltaPct)}
                                  </span>
                                )}
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
          </div>
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
        <div className="daily-report-footer-start">
          {!pending && hasDays && (
            <p className="trend-dates daily-report-dates">
              <time dateTime={firstDate}>{firstDate}</time>
              {" — "}
              <time dateTime={lastDate}>{lastDate}</time>
            </p>
          )}
          <p role="status" aria-live="polite" aria-atomic="true" className="daily-report-status">
            {pending ? "正在读取每日数据…" : !analytics ? "等待统计数据" : `共 ${totalDays} 天`}
          </p>
        </div>
        {!pending && hasDays && report && analytics && (
          <div className="daily-report-meta-group">
            {peakDate && (
              <span className="daily-cal-legend">
                <Star className="daily-cal-legend-icon daily-cal-mark-star" aria-hidden="true" />
                最高
              </span>
            )}
            {lowestDate && (
              <span className="daily-cal-legend">
                <TrendingDown className="daily-cal-legend-icon" aria-hidden="true" />
                最低
              </span>
            )}
            <p className="daily-report-meta">
              有收款 {count(activeDays)} 天 · 确认 {count(analytics.confirmations.count)} 笔 · 新建{" "}
              {count(analytics.orders.created)} 笔
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
