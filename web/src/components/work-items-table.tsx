import type { ReactNode } from "react";
import type { AdminWorkItem } from "@/api/client";
import { Link } from "@/navigation";
import { dateTime } from "@/lib/format";
import { notificationErrorName } from "@/lib/detail-summary";
import { workItemHref, workItemTitle } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { LinkedTableRow } from "@/components/LinkedTableRow";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
export function WorkItemsTable({
  items,
  actions,
  emptyTitle = "暂无待处理提醒",
}: {
  items: AdminWorkItem[];
  actions?: ((item: AdminWorkItem) => ReactNode) | undefined;
  emptyTitle?: string | undefined;
}) {
  if (!items.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle role="heading" aria-level={2}>
            {emptyTitle}
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>事项</TableHead>
          <TableHead className="hidden sm:table-cell">时间</TableHead>
          <TableHead className="text-right">
            {actions ? "提醒状态" : "分类"}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <LinkedTableRow key={item.type + item.resource_id}>
            <TableCell className="w-full max-w-md whitespace-normal py-3">
              <div className="flex flex-col gap-1">
                <Link
                  data-row-link
                  data-reminder-id={item.type + ":" + item.resource_id}
                  className="font-medium hover:underline"
                  to={workItemHref(item)}
                >
                  {workItemTitle(item)}
                </Link>
                {item.type === "LEDGER_CONFLICT" && item.external_event_id && (
                  <span className="text-sm break-all text-muted-foreground">
                    {item.external_event_id}
                  </span>
                )}
                {item.type === "NOTIFICATION_FAILURE" && (
                  <span className="text-sm text-muted-foreground">
                    {item.last_error_code
                      ? notificationErrorName(item.last_error_code) + " · "
                      : ""}
                    已尝试 {item.attempt_count} 次
                    {item.next_attempt_at && !item.ended
                      ? " · 下次 " + dateTime(item.next_attempt_at)
                      : ""}
                  </span>
                )}
                <time
                  className="text-xs text-muted-foreground sm:hidden"
                  dateTime={item.actionable_at}
                >
                  提醒时间 {dateTime(item.actionable_at)}
                </time>
                {item.ignored_at && (
                  <span className="text-xs text-muted-foreground">
                    {item.ignored_by ?? "管理员"}已忽略 ·{" "}
                    {dateTime(item.ignored_at)}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              <time dateTime={item.actionable_at}>
                {dateTime(item.actionable_at)}
              </time>
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-end gap-2">
                {item.ignored_at ? (
                  <Badge variant="secondary">
                    {item.ended ? "已结束" : "已忽略"}
                  </Badge>
                ) : (
                  <StatusBadge value={item.type} />
                )}
                {actions?.(item)}
              </div>
            </TableCell>
          </LinkedTableRow>
        ))}
      </TableBody>
    </Table>
  );
}
