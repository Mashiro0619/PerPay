import type { SystemAnalytics } from "@/api/client";
import { count } from "@/lib/format";
import { buildDailyReport, dailyDateLabel, dailyWeekday, type DailyDay } from "@/lib/daily-analytics";
import { useListSize } from "@/hooks/use-list-size";
import { ListIdentity, ListMoney, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Item, ItemGroup } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const LOADING_ROWS = 10;

type DailyAnalyticsProps = {
  analytics: SystemAnalytics | undefined;
  range: number;
  pending: boolean;
  scopeKey?: string;
};

function DailyDate({
  day,
  today,
  peakDate,
  includeYear,
}: {
  day: DailyDay;
  today: string;
  peakDate: string | null;
  includeYear: boolean;
}) {
  const isToday = day.date === today;
  const isPeak = peakDate === day.date && day.confirmed_amount_cents > 0 && !isToday;
  return (
    <div className="daily-date">
      <time dateTime={day.date} title={day.date}>
        {!includeYear && <span className="sr-only">{day.date.slice(0, 5)}</span>}
        {dailyDateLabel(day.date, includeYear)}
      </time>
      <span className="daily-date-weekday">{dailyWeekday(day.date)}</span>
      {isToday && <Badge variant="secondary" className="daily-day-badge">今日</Badge>}
      {isPeak && <Badge variant="outline" className="daily-day-badge">最高</Badge>}
    </div>
  );
}

function DailyAmountBar({ day, maximum }: { day: DailyDay; maximum: number }) {
  const width = maximum > 0 ? Math.max(0, Math.min(100, day.confirmed_amount_cents / maximum * 100)) : 0;
  return (
    <svg className="daily-amount-bar" data-date={day.date} viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect className="daily-amount-track" width="100" height="4" />
      <rect data-daily-bar-fill width={width} height="4" fill="currentColor" />
    </svg>
  );
}

export function DailyAnalytics({ analytics, pending }: DailyAnalyticsProps) {
  const { ref, isSummary } = useListSize();
  const report = analytics && !pending ? buildDailyReport(analytics) : null;
  const days = report?.days ?? [];
  const totalDays = days.length;
  const hasDays = totalDays > 0;
  const includeYear = !!report && report.days[0]?.date.slice(0, 4) !== report.days.at(-1)?.date.slice(0, 4);
  const peakDate = report?.peak?.date ?? null;
  const activeDays = days.filter((day) => day.confirmed_amount_cents > 0).length;

  return (
    <div ref={ref} className="daily-report" role="region" aria-label="每日数据" aria-busy={pending}>
      {pending ? (
        <div className="daily-report-summary" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="daily-summary-metric" key={index}>
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3.5 w-24" />
            </div>
          ))}
        </div>
      ) : hasDays && report && analytics ? (
        <dl className="daily-report-summary" aria-label="每日数据汇总">
          <div className="daily-summary-metric daily-summary-total" data-daily-summary="total">
            <dt>区间确认金额</dt>
            <dd><ListMoney value={analytics.confirmations.amount_cents} /></dd>
            <dd className="daily-summary-note">含今天 · 按确认时间</dd>
          </div>
          <div className="daily-summary-metric" data-daily-summary="average">
            <dt>日均确认金额</dt>
            <dd><ListMoney value={report.averageCents} /></dd>
            <dd className="daily-summary-note">按已结束日期计算</dd>
          </div>
          <div className="daily-summary-metric" data-daily-summary="peak">
            <dt>单日最高金额</dt>
            <dd><ListMoney value={report.peak?.confirmed_amount_cents} /></dd>
            <dd className="daily-summary-note">
              {report.peak ? (
                <time dateTime={report.peak.date}>{dailyDateLabel(report.peak.date, includeYear)}</time>
              ) : (
                "不含今天"
              )}
            </dd>
          </div>
        </dl>
      ) : null}

      <div
        className="daily-report-rows"
        data-daily-surface={hasDays && !pending ? "true" : undefined}
        tabIndex={totalDays > 10 ? 0 : undefined}
        aria-label="每日收款记录"
      >
        {pending ? (
          <div className="daily-report-loading" aria-hidden="true">
            {Array.from({ length: LOADING_ROWS }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}
          </div>
        ) : hasDays && report ? (
          isSummary ? (
            <ItemGroup className="record-list daily-mobile-list" role="list" aria-label="每日收款数据">
              {days.map((day) => {
                const isPeak = peakDate === day.date && day.confirmed_amount_cents > 0 && day.date !== report.today;
                return (
                  <Item
                    key={day.date}
                    className="record-list-row"
                    data-daily-today={day.date === report.today || undefined}
                    data-daily-peak={isPeak || undefined}
                    data-daily-zero={day.confirmed_amount_cents === 0 || undefined}
                    size="sm"
                    role="listitem"
                  >
                    <ListSummary
                      identity={<ListIdentity><DailyDate day={day} today={report.today} peakDate={peakDate} includeYear={includeYear} /></ListIdentity>}
                      aside={<ListMoney value={day.confirmed_amount_cents} label="确认金额" />}
                    >
                      <ListSummaryField label="确认笔数">{count(day.confirmations)}</ListSummaryField>
                      <ListSummaryField label="新建订单">{count(day.orders_created)}</ListSummaryField>
                    </ListSummary>
                  </Item>
                );
              })}
            </ItemGroup>
          ) : (
            <Table className="daily-report-table" aria-label="每日收款数据">
              <colgroup><col className="daily-date-column" /><col className="daily-amount-column" /><col className="daily-count-column" /><col className="daily-count-column" /></colgroup>
              <TableHeader>
                <TableRow><TableHead scope="col">日期</TableHead><TableHead scope="col">确认金额</TableHead><TableHead scope="col">确认笔数</TableHead><TableHead scope="col">新建订单</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {days.map((day) => {
                  const isPeak = peakDate === day.date && day.confirmed_amount_cents > 0 && day.date !== report.today;
                  return (
                    <TableRow
                      key={day.date}
                      data-daily-today={day.date === report.today || undefined}
                      data-daily-peak={isPeak || undefined}
                      data-daily-zero={day.confirmed_amount_cents === 0 || undefined}
                    >
                      <TableCell><DailyDate day={day} today={report.today} peakDate={peakDate} includeYear={includeYear} /></TableCell>
                      <TableCell><div className="daily-amount"><DailyAmountBar day={day} maximum={report.maximum} /><ListMoney value={day.confirmed_amount_cents} /></div></TableCell>
                      <TableCell data-zero={day.confirmations === 0 || undefined}>{count(day.confirmations)}</TableCell>
                      <TableCell data-zero={day.orders_created === 0 || undefined}>{count(day.orders_created)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )
        ) : (
          <Empty><EmptyHeader><EmptyTitle>{analytics ? "暂无每日数据" : "统计数据暂不可用"}</EmptyTitle></EmptyHeader></Empty>
        )}
      </div>

      <div className="daily-report-footer">
        <p role="status" aria-live="polite" aria-atomic="true" className="daily-report-status">
          {pending ? "正在读取每日数据…" : !analytics ? "等待统计数据" : `共 ${totalDays} 天`}
        </p>
        {!pending && hasDays && report && analytics && (
          <p className="daily-report-meta">
            有收款 {count(activeDays)} 天 · 确认 {count(analytics.confirmations.count)} 笔 · 新建 {count(analytics.orders.created)} 笔
          </p>
        )}
      </div>
    </div>
  );
}
