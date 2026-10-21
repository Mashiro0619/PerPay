import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { count } from "@/lib/format";
import { buildDailyReport, dailyDateLabel, dailyWeekday, type DailyDay } from "@/lib/daily-analytics";
import { useListSize } from "@/hooks/use-list-size";
import { ListIdentity, ListMoney, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Item, ItemGroup } from "@/components/ui/item";
import { Pagination, PaginationContent, PaginationItem } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 10;

type DailyAnalyticsProps = {
  analytics: SystemAnalytics | undefined;
  range: number;
  pending: boolean;
  scopeKey?: string;
};

export function DailyAnalytics(props: DailyAnalyticsProps) {
  const available = !props.pending ? props.analytics : undefined;
  const scopeKey = props.scopeKey ?? "all";
  const [period, setPeriod] = useState({ scopeKey, range: props.range, from: available?.from, to: available?.to });
  // Keep the last valid dates through loading/errors. Scope, range or Beijing
  // midnight changes reset pagination; ordinary refreshes retain the current page.
  if (period.scopeKey !== scopeKey || period.range !== props.range || (available && (period.from !== available.from || period.to !== available.to))) {
    setPeriod({ scopeKey, range: props.range, from: available?.from, to: available?.to });
  }
  return <DailyReport key={JSON.stringify(period)} {...props} />;
}

function DailyDate({ day, today, includeYear }: { day: DailyDay; today: string; includeYear: boolean }) {
  return (
    <div className="daily-date">
      <time dateTime={day.date} aria-label={`${day.date} ${dailyWeekday(day.date)}`} title={day.date}>
        {dailyDateLabel(day.date, includeYear)}
      </time>
      <span className="daily-date-weekday" aria-hidden="true">{dailyWeekday(day.date)}</span>
      {day.date === today && <Badge variant="secondary">今日</Badge>}
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

function DailyReport({ analytics, pending }: DailyAnalyticsProps) {
  const { ref, isSummary } = useListSize();
  const daysId = useId();
  const report = analytics && !pending ? buildDailyReport(analytics) : null;
  const [page, setPage] = useState(1);
  const totalDays = report?.days.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalDays / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const days = report?.days.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE) ?? [];
  const hasDays = totalDays > 0;
  const includeYear = !!report && report.days[0]?.date.slice(0, 4) !== report.days.at(-1)?.date.slice(0, 4);

  return (
    <div ref={ref} className="daily-report" role="region" aria-label="每日数据" aria-busy={pending}>
      {pending ? (
        <div className="daily-report-summary" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="daily-summary-metric" key={index}>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-32" />
            </div>
          ))}
        </div>
      ) : hasDays && report && analytics ? (
        <div className="daily-report-overview">
          <dl className="daily-report-summary" aria-label="每日数据汇总">
            <div className="daily-summary-metric" data-daily-summary="total">
              <dt>区间确认金额</dt>
              <dd><ListMoney value={analytics.confirmations.amount_cents} /></dd>
            </div>
            <div className="daily-summary-metric" data-daily-summary="average">
              <dt>日均确认金额</dt>
              <dd><ListMoney value={report.averageCents} /></dd>
            </div>
            <div className="daily-summary-metric" data-daily-summary="peak">
              <dt>单日最高金额</dt>
              <dd><ListMoney value={report.peak?.confirmed_amount_cents} /></dd>
              {report.peak && <dd className="daily-summary-note"><time dateTime={report.peak.date}>{dailyDateLabel(report.peak.date, includeYear)}</time></dd>}
            </div>
          </dl>
          <p className="daily-summary-note">区间金额含今日；日均与最高不含今日。</p>
        </div>
      ) : null}

      <div id={daysId}>
        {pending ? (
          <div className="daily-report-loading" aria-hidden="true">
            {Array.from({ length: PAGE_SIZE }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}
          </div>
        ) : hasDays && report ? (
          isSummary ? (
            <ItemGroup className="record-list daily-mobile-list" role="list" aria-label="每日收款数据">
              {days.map((day) => (
                <Item key={day.date} className="record-list-row" size="sm" role="listitem">
                  <ListSummary
                    identity={<ListIdentity><DailyDate day={day} today={report.today} includeYear={includeYear} /></ListIdentity>}
                    aside={<ListMoney value={day.confirmed_amount_cents} label="确认金额" />}
                  >
                    <ListSummaryField label="确认笔数">{count(day.confirmations)}</ListSummaryField>
                    <ListSummaryField label="新建订单">{count(day.orders_created)}</ListSummaryField>
                  </ListSummary>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <Table className="daily-report-table" aria-label="每日收款数据">
              <colgroup><col className="daily-date-column" /><col className="daily-amount-column" /><col className="daily-count-column" /><col className="daily-count-column" /></colgroup>
              <TableHeader>
                <TableRow><TableHead scope="col">日期</TableHead><TableHead scope="col">确认金额</TableHead><TableHead scope="col">确认笔数</TableHead><TableHead scope="col">新建订单</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {days.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell><DailyDate day={day} today={report.today} includeYear={includeYear} /></TableCell>
                    <TableCell><div className="daily-amount"><DailyAmountBar day={day} maximum={report.maximum} /><ListMoney value={day.confirmed_amount_cents} /></div></TableCell>
                    <TableCell>{count(day.confirmations)}</TableCell>
                    <TableCell>{count(day.orders_created)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        ) : (
          <Empty><EmptyHeader><EmptyTitle>{analytics ? "暂无每日数据" : "统计数据暂不可用"}</EmptyTitle></EmptyHeader></Empty>
        )}
      </div>

      <div className="daily-report-footer">
        <p role="status" aria-live="polite" aria-atomic="true" className="daily-report-status">
          {pending ? "正在读取每日数据…" : !analytics ? "等待统计数据" : pageCount > 1 ? `第 ${currentPage}/${pageCount} 页 · 共 ${totalDays} 天` : `共 ${totalDays} 天`}
        </p>
        {!pending && pageCount > 1 && (
          <Pagination className="m-0 w-auto justify-end" aria-label="每日数据分页" aria-controls={daysId}>
            <PaginationContent>
              <PaginationItem>
                <Button size="sm" variant="outline" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                  <ChevronLeft data-icon="inline-start" />上一页
                </Button>
              </PaginationItem>
              <PaginationItem>
                <Button size="sm" variant="outline" type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>
                  下一页<ChevronRight data-icon="inline-end" />
                </Button>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </div>
    </div>
  );
}
