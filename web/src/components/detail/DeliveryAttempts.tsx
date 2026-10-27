import { InlineEmpty } from "@/components/admin-empty";
import { useId, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WebhookAttempt } from "@/api/client";
import { useListSize } from "@/hooks/use-list-size";
import { ListDateTime, ListIdentity, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { attemptResult } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from "@/components/ui/item";
import { DetailFields } from "./DetailPrimitives";
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
  readState,
  density = "default",
}: {
  attempts: readonly WebhookAttempt[];
  available: boolean;
  readState?: "loading" | "failed";
  density?: "default" | "comfortable";
}) {
  const titleId = useId();
  const { ref, isSummary } = useListSize<HTMLElement>();
  const [requestedPage, setPage] = useState(1);
  const ordered = [...attempts].sort(
    (a, b) =>
      Date.parse(b.started_at) - Date.parse(a.started_at) ||
      b.attempt_number - a.attempt_number ||
      b.attempt_id.localeCompare(a.attempt_id),
  );
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const rows = ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const comfortable = density === "comfortable";
  return (
    <section ref={ref} className={cn("flex min-w-0 flex-col", comfortable ? "gap-4" : "gap-3")} aria-labelledby={titleId} data-delivery-attempts data-density={comfortable ? "comfortable" : undefined}>
      <h3 id={titleId} className="text-sm font-medium">
        投递尝试{available ? "（" + attempts.length + "）" : ""}
      </h3>
      {available ? (
        <>
          {isSummary && comfortable ? (
            <ItemGroup aria-labelledby={titleId}>
              {rows.length ? rows.map((attempt) => (
                <Item key={attempt.attempt_id} role="listitem">
                  <ItemHeader className="flex-wrap">
                    <ItemTitle>第 {attempt.attempt_number} 次</ItemTitle>
                    <ItemTitle>{label(attempt.outcome)}</ItemTitle>
                  </ItemHeader>
                  <ItemContent className="min-w-0 basis-full">
                    <DetailFields density="comfortable" layout="flow" wide={["HTTP / ACK"]} items={[
                      ["开始时间", <ListDateTime value={attempt.started_at} inline />],
                      ["HTTP / ACK", attemptResult(attempt)],
                    ]} />
                  </ItemContent>
                </Item>
              )) : <InlineEmpty>暂无尝试明细</InlineEmpty>}
            </ItemGroup>
          ) : isSummary ? (
            <ItemGroup className="record-list" data-density="compact" aria-labelledby={titleId}>
              {rows.length ? rows.map((attempt) => (
                <Item key={attempt.attempt_id} className="record-list-row" size="xs" role="listitem">
                  <ListSummary
                    identity={<><ItemTitle>第 {attempt.attempt_number} 次</ItemTitle><ItemDescription><ListDateTime value={attempt.started_at} inline /></ItemDescription></>}
                    aside={<ItemTitle className="record-list-title">{label(attempt.outcome)}</ItemTitle>}
                  >
                    <ListSummaryField label="HTTP / ACK">{attemptResult(attempt)}</ListSummaryField>
                  </ListSummary>
                </Item>
              )) : <InlineEmpty>暂无尝试明细</InlineEmpty>}
            </ItemGroup>
          ) : (
          <div className={comfortable ? "min-w-0" : "business-table-surface"} data-embedded={comfortable ? undefined : "true"} data-density={comfortable ? undefined : "compact"}>
            <Table className={cn("table-fixed", !comfortable && "business-table")} aria-labelledby={titleId}>
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
                      <TableCell className={cn("whitespace-normal", comfortable && "py-3")}>
                        {comfortable ? <div className="flex min-w-0 flex-col gap-1">
                          <p className="font-medium">第 {attempt.attempt_number} 次</p>
                          <ListDateTime value={attempt.started_at} inline />
                        </div> : <ListIdentity meta={<ListDateTime value={attempt.started_at} inline />}>
                          第 {attempt.attempt_number} 次
                        </ListIdentity>}
                      </TableCell>
                      <TableCell className={cn("whitespace-normal break-words", comfortable && "py-3")}>
                        {label(attempt.outcome)}
                      </TableCell>
                      <TableCell className={cn("whitespace-normal wrap-anywhere", comfortable && "py-3")}>
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
                className={cn("text-muted-foreground", comfortable ? "text-sm" : "text-xs")}
                role="status"
                aria-live="polite"
              >
                第 {page} / {pages} 页 · 共 {attempts.length} 条
              </p>
              <PaginationContent>
                <PaginationItem>
                  <Button
                    variant="outline"
                    size={comfortable ? "icon" : "icon-sm"}
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
                    size={comfortable ? "icon" : "icon-sm"}
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
          {readState === "loading" ? "正在读取发送记录…"
            : readState === "failed" ? "发送记录读取失败，请重试；这不代表没有发送过。"
            : "发送记录尚未读取；这不代表没有发送过。"}
        </p>
      )}
    </section>
  );
}
