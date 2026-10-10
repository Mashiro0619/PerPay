import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { count } from "@/lib/format";
import { useListSize } from "@/hooks/use-list-size";
import { ListIdentity, ListMoney, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Item, ItemGroup } from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 10;
type DailyAnalyticsProps = {
  analytics: SystemAnalytics | undefined;
  range: number;
  pending: boolean;
};

export function DailyAnalytics(props: DailyAnalyticsProps) {
  // A changed period resets pagination; switching views keeps this panel mounted.
  return <DailyAnalyticsTable key={props.range} {...props} />;
}
function DailyAnalyticsTable({
  analytics,
  range,
  pending,
}: DailyAnalyticsProps) {
  const { ref, isSummary } = useListSize();
  const [requestedPage, setPage] = useState(1);
  // This is at most 90 aggregated days, not a client-side search of business records.
  const days =
    analytics?.daily.toSorted((a, b) => b.date.localeCompare(a.date)) ?? [];
  const pageCount = Math.max(1, Math.ceil(days.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const rows = days.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div
      ref={ref}
      className="flex w-full min-w-0 flex-col gap-3"
      role="region"
      aria-label="每日数据"
      aria-busy={pending}
    >
      {isSummary ? (
        <ItemGroup className="record-list" data-density="compact" aria-label="每日收款数据">
          {pending ? (
            Array.from({ length: Math.min(range, PAGE_SIZE) }, (_, index) => (
              <Item key={index} className="record-list-row" size="sm" aria-hidden="true">
                <div className="flex w-full flex-col gap-3">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-10 w-full" />
                </div>
              </Item>
            ))
          ) : rows.length ? (
            rows.map((day) => (
              <Item key={day.date} className="record-list-row" size="sm" role="listitem">
                <ListSummary
                  identity={<ListIdentity><time dateTime={day.date}>{day.date}</time></ListIdentity>}
                  aside={
                    <div className="flex flex-col items-end gap-1">
                      <span className="record-list-meta">确认金额</span>
                      <ListMoney value={day.confirmed_amount_cents} />
                    </div>
                  }
                >
                  <ListSummaryField label="确认次数">{count(day.confirmations)}</ListSummaryField>
                  <ListSummaryField label="新建订单">{count(day.orders_created)}</ListSummaryField>
                </ListSummary>
              </Item>
            ))
          ) : (
            <Empty><EmptyHeader><EmptyTitle>{analytics ? "暂无每日数据" : "统计数据暂不可用"}</EmptyTitle></EmptyHeader></Empty>
          )}
        </ItemGroup>
      ) : (
      <div className="business-table-surface" data-embedded="true" data-density="compact">
        <Table className="business-table" aria-label="每日收款数据">
          <colgroup>
            <col data-column-layout="datetime" />
            <col data-column-layout="amount" />
            <col data-column-layout="number" />
            <col data-column-layout="number" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">日期</TableHead>
              <TableHead data-column-layout="amount">确认金额</TableHead>
              <TableHead data-column-layout="number">确认次数</TableHead>
              <TableHead data-column-layout="number">新建订单</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending ? (
              Array.from({ length: Math.min(range, PAGE_SIZE) }, (_, index) => (
                <TableRow key={index} aria-hidden="true">
                  {Array.from({ length: 4 }, (_, cell) => (
                    <TableCell key={cell} className="first:pl-4 last:pr-4">
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((day) => (
                <TableRow key={day.date}>
                  <TableCell className="pl-4">
                    <time dateTime={day.date}>{day.date}</time>
                  </TableCell>
                  <TableCell data-column-layout="amount">
                    <ListMoney value={day.confirmed_amount_cents} />
                  </TableCell>
                  <TableCell data-column-layout="number">
                    {count(day.confirmations)}
                  </TableCell>
                  <TableCell data-column-layout="number">
                    {count(day.orders_created)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4}>
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>
                        {analytics ? "暂无每日数据" : "统计数据暂不可用"}
                      </EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      )}
      <Pagination
        className="flex-wrap justify-between gap-2"
        aria-label="每日数据分页"
      >
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-xs text-muted-foreground"
        >
          {pending
            ? "正在读取每日数据…"
            : !analytics
              ? "等待统计数据"
              : days.length
                ? "第 " +
                  page +
                  " / " +
                  pageCount +
                  " 页 · 共 " +
                  days.length +
                  " 天"
                : "共 0 天"}
        </p>
        <PaginationContent>
          <PaginationItem>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="每日数据上一页"
              disabled={pending || page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="每日数据下一页"
              disabled={pending || page >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
