import { useState } from "react";
import type { SystemAnalytics } from "@/api/client";
import { count, money } from "@/lib/format";
import { buildDailyReport, dailyDateLabel, dailyWeekday, type DailyDay } from "@/lib/daily-analytics";
import { useListSize } from "@/hooks/use-list-size";
import { ListIdentity, ListMoney, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Item, ItemGroup } from "@/components/ui/item";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type DailyAnalyticsProps = {
  analytics: SystemAnalytics | undefined;
  range: number;
  pending: boolean;
};

export function DailyAnalytics(props: DailyAnalyticsProps) {
  const available = !props.pending ? props.analytics : undefined;
  const [period, setPeriod] = useState({ range: props.range, from: available?.from, to: available?.to });
  // Keep the last valid boundary through loading/errors, but reset for a new
  // selected period or a Beijing midnight. Ordinary refreshes retain expansion.
  if (period.range !== props.range || (available && (period.from !== available.from || period.to !== available.to))) {
    setPeriod({ range: props.range, from: available?.from, to: available?.to });
  }
  return <DailyReport key={`${period.range}:${period.from ?? ""}:${period.to ?? ""}`} {...props} />;
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
  const report = analytics && !pending ? buildDailyReport(analytics) : null;
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const weeks = report?.weeks ?? [];
  const openWeeks = (expanded ?? weeks.slice(0, 2).map((week) => week.key)).filter((key) => weeks.some((week) => week.key === key));
  const hasDays = !!report?.days.length;
  const includeYear = !!report && report.days[0]?.date.slice(0, 4) !== report.days.at(-1)?.date.slice(0, 4);

  return (
    <div ref={ref} className="daily-report" role="region" aria-label="每日数据" aria-busy={pending}>
      {pending ? (
        <div className="daily-report-summary" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="daily-summary-metric" key={index}>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-32" />
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </div>
      ) : hasDays && report && analytics ? (
        <dl className="daily-report-summary" aria-label="每日数据汇总">
          <div className="daily-summary-metric" data-daily-summary="total">
            <dt>区间确认金额</dt>
            <dd><ListMoney value={analytics.confirmations.amount_cents} /></dd>
            <dd className="daily-summary-note">含今日未结束的数据</dd>
          </div>
          <div className="daily-summary-metric" data-daily-summary="average">
            <dt>日均确认金额</dt>
            <dd><ListMoney value={report.averageCents} /></dd>
            <dd className="daily-summary-note">不含今日</dd>
          </div>
          <div className="daily-summary-metric" data-daily-summary="peak">
            <dt>单日最高金额</dt>
            <dd><ListMoney value={report.peak?.confirmed_amount_cents} /></dd>
            <dd className="daily-summary-note">
              {report.peak ? `${dailyDateLabel(report.peak.date, includeYear)} · 不含今日` : "不含今日"}
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="daily-report-tools">
        <Button size="sm" variant="ghost" disabled={pending || !hasDays || openWeeks.length === weeks.length} onClick={() => setExpanded(weeks.map((week) => week.key))}>
          全部展开
        </Button>
        <Button size="sm" variant="ghost" disabled={pending || !hasDays || !openWeeks.length} onClick={() => setExpanded([])}>
          全部收起
        </Button>
      </div>

      {pending ? (
        <div className="daily-report-loading" aria-hidden="true">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex min-w-0 flex-col gap-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      ) : hasDays && report ? (
        <Accordion className="daily-weeks" multiple value={openWeeks} onValueChange={(value) => setExpanded(value.map(String))}>
          {weeks.map((week) => (
            <AccordionItem key={week.key} value={week.key}>
              <AccordionTrigger className="daily-week-trigger" aria-label={`${week.from} — ${week.to}，${week.days.length === 7 ? "7 天" : `区间内 ${week.days.length} 天`}，${week.inProgress ? "进行中，" : ""}确认金额 ${money(week.confirmedAmountCents)}，确认次数 ${count(week.confirmations)}，新建订单 ${count(week.ordersCreated)}`}>
                <span className="daily-week-heading">
                  <span className="daily-week-period">
                    <span>{dailyDateLabel(week.from, includeYear)} — {dailyDateLabel(week.to, includeYear)}</span>
                    <span className="daily-week-note">
                      {week.days.length === 7 ? "7 天" : `区间内 ${week.days.length} 天`}
                      {week.inProgress && <Badge variant="secondary">进行中</Badge>}
                    </span>
                  </span>
                  <span className="daily-week-metrics">
                    <span className="daily-week-metric"><span>确认金额</span><ListMoney value={week.confirmedAmountCents} /></span>
                    <span className="daily-week-metric"><span>确认次数</span><span>{count(week.confirmations)}</span></span>
                    <span className="daily-week-metric"><span>新建订单</span><span>{count(week.ordersCreated)}</span></span>
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent className="daily-week-content">
                {isSummary ? (
                  <ItemGroup className="record-list daily-mobile-list" role="list" aria-label="每日收款数据">
                    {week.days.map((day) => (
                      <Item key={day.date} className="record-list-row" size="sm" role="listitem">
                        <div className="daily-mobile-day">
                          <ListSummary
                            identity={<ListIdentity><DailyDate day={day} today={report.today} includeYear={includeYear} /></ListIdentity>}
                            aside={<ListMoney value={day.confirmed_amount_cents} label="确认金额" />}
                          >
                            <ListSummaryField label="确认次数">{count(day.confirmations)}</ListSummaryField>
                            <ListSummaryField label="新建订单">{count(day.orders_created)}</ListSummaryField>
                          </ListSummary>
                          <DailyAmountBar day={day} maximum={report.maximum} />
                        </div>
                      </Item>
                    ))}
                  </ItemGroup>
                ) : (
                  <Table className="daily-week-table" aria-label="每日收款数据">
                    <colgroup><col className="daily-date-column" /><col /><col className="daily-count-column" /><col className="daily-count-column" /></colgroup>
                    <TableHeader>
                      <TableRow><TableHead>日期</TableHead><TableHead>确认金额</TableHead><TableHead>确认次数</TableHead><TableHead>新建订单</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {week.days.map((day) => (
                        <TableRow key={day.date}>
                          <TableCell><DailyDate day={day} today={report.today} includeYear={includeYear} /></TableCell>
                          <TableCell><div className="daily-amount"><DailyAmountBar day={day} maximum={report.maximum} /><ListMoney value={day.confirmed_amount_cents} /></div></TableCell>
                          <TableCell>{count(day.confirmations)}</TableCell>
                          <TableCell>{count(day.orders_created)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        <Empty><EmptyHeader><EmptyTitle>{analytics ? "暂无每日数据" : "统计数据暂不可用"}</EmptyTitle></EmptyHeader></Empty>
      )}

      <p role="status" aria-live="polite" aria-atomic="true" className="daily-report-status">
        {pending ? "正在读取每日数据…" : !analytics ? "等待统计数据" : `共 ${report?.days.length ?? 0} 天 · ${weeks.length} 周`}
      </p>
    </div>
  );
}
