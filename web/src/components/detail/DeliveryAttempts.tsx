import { InlineEmpty } from "@/components/admin-empty";
import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WebhookAttempt } from "@/api/client";
import { useListSize } from "@/hooks/use-list-size";
import { ListDateTime, ListIdentity, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { attemptResult } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { Button } from "@/components/ui/button";
import { Item, ItemGroup } from "@/components/ui/item";
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
  const { ref, isSummary } = useListSize<HTMLElement>();
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
    <section ref={ref} className="flex min-w-0 flex-col gap-3" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-medium">
        投递尝试{available ? "（" + attempts.length + "）" : ""}
      </h3>
      {available ? (
        <>
          {isSummary ? (
            <ItemGroup className="record-list" data-density="compact" aria-labelledby={titleId}>
              {rows.length ? rows.map((attempt) => (
                <Item key={attempt.attempt_id} className="record-list-row" size="sm" role="listitem">
                  <ListSummary
                    identity={<ListIdentity meta={<ListDateTime value={attempt.started_at} inline />}>第 {attempt.attempt_number} 次</ListIdentity>}
                    aside={<span className="record-list-title">{label(attempt.outcome)}</span>}
                  >
                    <ListSummaryField label="HTTP / ACK">{attemptResult(attempt)}</ListSummaryField>
                  </ListSummary>
                </Item>
              )) : <InlineEmpty>暂无尝试明细</InlineEmpty>}
            </ItemGroup>
          ) : (
          <div className="business-table-surface" data-embedded="true" data-density="compact">
            <Table className="business-table table-fixed" aria-labelledby={titleId}>
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
                        <ListIdentity meta={<ListDateTime value={attempt.started_at} inline />}>
                          第 {attempt.attempt_number} 次
                        </ListIdentity>
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
                      <InlineEmpty>暂无尝试明细</InlineEmpty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          )}
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
