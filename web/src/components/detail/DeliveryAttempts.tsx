import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WebhookAttempt } from "@/api/client";
import { dateTime } from "@/lib/format";
import { attemptResult } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
const PAGE_SIZE = 10;
export function DeliveryAttempts({
  attempts,
  available,
}: {
  attempts: readonly WebhookAttempt[];
  available: boolean;
}) {
  const titleId = useId();
  const [requestedPage, setPage] = useState(1);
  const ordered = attempts.toSorted(
    (a, b) =>
      Date.parse(b.started_at) - Date.parse(a.started_at) ||
      b.attempt_number - a.attempt_number ||
      b.attempt_id.localeCompare(a.attempt_id),
  );
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const rows = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-medium">
        投递尝试{available ? "（" + attempts.length + "）" : ""}
      </h3>
      {available ? (
        <>
          <div className="min-w-0 overflow-hidden rounded-lg border">
            <Table className="table-fixed" aria-labelledby={titleId}>
              <colgroup>
                <col className="w-2/5" />
                <col className="w-1/4" />
                <col />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-normal">
                    次数 / 开始时间
                  </TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead className="whitespace-normal">
                    HTTP / ACK
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? (
                  rows.map((attempt) => (
                    <TableRow key={attempt.attempt_id}>
                      <TableCell className="align-top whitespace-normal">
                        <div className="flex flex-col gap-1">
                          第 {attempt.attempt_number} 次
                          <time
                            className="text-xs text-muted-foreground"
                            dateTime={attempt.started_at}
                          >
                            {dateTime(attempt.started_at)}
                          </time>
                        </div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal break-words">
                        {label(attempt.outcome)}
                      </TableCell>
                      <TableCell className="align-top whitespace-normal wrap-anywhere">
                        {attemptResult(attempt)}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={3}>
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>暂无尝试明细</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {pages > 1 && (
            <Pagination
              aria-label="投递尝试分页"
              className="flex-wrap justify-between gap-2"
            >
              <p
                className="text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                第 {page} / {pages} 页 · 共 {attempts.length} 条
              </p>
              <PaginationContent>
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="投递尝试上一页"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                </PaginationItem>
                <PaginationItem>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="投递尝试下一页"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          尚未获得尝试明细，不能据此判断未曾投递。
        </p>
      )}
    </section>
  );
}
