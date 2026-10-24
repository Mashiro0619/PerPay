import type { ReactNode } from "react";
import type { AdminWorkItem } from "@/api/client";
import { Link } from "@/navigation";
import type { ListQueryControl } from "@/lib/list-query";
import { notificationErrorName } from "@/lib/detail-summary";
import { workItemHref, workItemTitle } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import {
  BusinessTable,
  type BusinessColumn,
} from "@/components/business-table";
import {
  ListDateTime,
  ListIdentity,
  ListMeta,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
export function WorkItemsTable({
  items,
  actions,
  control,
  emptyTitle = "暂无待处理提醒",
}: {
  items: AdminWorkItem[];
  actions?: ((item: AdminWorkItem) => ReactNode) | undefined;
  control?: ListQueryControl;
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
  const columns: BusinessColumn<AdminWorkItem>[] = [
    {
      id: "identity",
      label: "提醒",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (item, context) => (
        <ListIdentity
          description={item.type === "NOTIFICATION_FAILURE" && item.last_error_code
            ? notificationErrorName(item.last_error_code)
            : undefined}
          meta={(
            (item.type === "LEDGER_CONFLICT" && item.external_event_id) ||
            item.type === "NOTIFICATION_FAILURE" ||
            context.showInSummary("actionable_at") ||
            item.ignored_at
          ) && (
            <ListMeta>
              {item.type === "LEDGER_CONFLICT" && item.external_event_id && (
                <span className="list-code" title={item.external_event_id}>
                  {item.external_event_id}
                </span>
              )}
              {item.type === "NOTIFICATION_FAILURE" && (
                <>
                  <span>已尝试 {item.attempt_count} 次</span>
                  {item.next_attempt_at && !item.ended && (
                    <span>下次 <ListDateTime value={item.next_attempt_at} inline /></span>
                  )}
                </>
              )}
              {context.showInSummary("actionable_at") && (
                <span>提醒时间 <ListDateTime value={item.actionable_at} inline /></span>
              )}
              {item.ignored_at && (
                <span>
                  {item.ignored_by ?? "管理员"}已忽略
                  {(!actions || context.showInSummary("ignored_at")) && (
                    <> · <ListDateTime value={item.ignored_at} inline /></>
                  )}
                </span>
              )}
            </ListMeta>
          )}
        >
          <Link
            data-row-link
            data-reminder-id={item.type + ":" + item.resource_id}
            className="list-primary-link"
            to={workItemHref(item)}
          >
            {workItemTitle(item)}
          </Link>
        </ListIdentity>
      ),
    },
    {
      id: "actionable_at",
      sortBy: "actionable_at",
      label: "提醒时间",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: {
        minWidthRem: 40,
        basis: "container",
      },
      cell: (item) => <ListDateTime value={item.actionable_at} />,
    },
    {
      id: "created_at",
      sortBy: "created_at",
      label: "创建时间",
      align: "center",
      layout: "datetime",
      summaryDefault: false,
      responsive: {
        minWidthRem: 64,
        basis: "container",
      },
      cell: (item) => <ListDateTime value={item.created_at} />,
    },
    ...(actions
      ? [
          {
            id: "ignored_at",
            sortBy: "ignored_at",
            label: "忽略时间",
            align: "center" as const,
            layout: "datetime" as const,
            summaryDefault: false,
            responsive: {
              minWidthRem: 64,
              basis: "container" as const,
            },
            cell: (item: AdminWorkItem) => <ListDateTime value={item.ignored_at} />,
          },
        ]
      : []),
    {
      id: "actions",
      label: actions ? "提醒状态" : "分类",
      hideable: false,
      align: "center",
      layout: "actions",
      summaryDefault: true,
      cell: (item) => (
        <div className="business-cell-stack flex flex-col items-end gap-2">
          {item.ignored_at ? (
            <Badge variant="secondary">
              {item.ended ? "已结束" : "已忽略"}
            </Badge>
          ) : (
            <StatusBadge
              value={item.type === "NOTIFICATION_FAILURE" &&
                ["PENDING", "LEASED", "RETRY_WAIT"].includes(item.status)
                ? "RETRY_WAIT"
                : item.type}
              label={item.type === "NOTIFICATION_FAILURE" ? "通知失败" : undefined}
            />
          )}{" "}
          {actions?.(item)}
        </div>
      ),
    },
  ];
  return (
    <BusinessTable
      id={actions ? "ignored-work-items" : "work-items"}
      aria-label={actions ? "已忽略提醒列表" : "待处理提醒列表"}
      items={items}
      columns={columns}
      rowId={(item) => item.type + ":" + item.resource_id}
      control={control}
      density={control ? "default" : "compact"}
      embedded={!control}
      columnsMenu={!!control}
      renderSummary={(item, context) => (
        <ListSummary
          identity={columns[0]!.cell(item, context)}
          aside={columns.find((column) => column.id === "actions")!.cell(item, context)}
          details={columns.filter((column) =>
            context.isColumnVisible(column.id) && !context.isSummaryPrimary(column.id),
          ).map((column) => (
            <ListSummaryField key={column.id} label={column.label}>
              {column.cell(item, context)}
            </ListSummaryField>
          ))}
        >
          {columns.filter((column) =>
            column.id !== "identity" &&
            column.id !== "actions" &&
            context.isSummaryPrimary(column.id),
          ).map((column) => (
            <ListSummaryField key={column.id} label={column.label}>
              {column.cell(item, context)}
            </ListSummaryField>
          ))}
        </ListSummary>
      )}
    />
  );
}
