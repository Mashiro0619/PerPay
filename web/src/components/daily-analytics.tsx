import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { count, money } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
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
  // Changing the period starts at the newest day, even when returning to an earlier period.
  return <DailyAnalyticsCard key={props.range} {...props} />;
}

function DailyAnalyticsCard({
  analytics,
  range,
  pending,
}: DailyAnalyticsProps) {
  const titleId = useId();
  const [requestedPage, setPage] = useState(1);
  // This is at most 90 aggregated days, not a client-side search of business records.
  const days =
    analytics?.daily.toSorted((a, b) => b.date.localeCompare(a.date)) ?? [];
  const pageCount = Math.max(1, Math.ceil(days.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const rows = days.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <Card
      className="min-w-0"
      role="region"
      aria-labelledby={titleId}
      aria-busy={pending}
    >
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2}>
          每日数据
        </CardTitle>
        <CardDescription>日期倒序 · 每页 10 天</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 px-0">
        <Table aria-label="每日收款数据">
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">日期</TableHead>
              <TableHead className="text-right">确认金额</TableHead>
              <TableHead className="text-right">确认次数</TableHead>
              <TableHead className="pr-4 text-right">新建订单</TableHead>
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
                  <TableCell className="text-right tabular-nums">
                    {money(day.confirmed_amount_cents)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(day.confirmations)}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
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
      </CardContent>
      <CardFooter className="mt-auto">
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
      </CardFooter>
    </Card>
  );
}
