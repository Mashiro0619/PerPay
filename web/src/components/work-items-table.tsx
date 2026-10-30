import type { ReactNode } from "react";
import type { AdminWorkItem } from "@/api/client";
import { Link } from "@/navigation";
import { useWorkspace } from "@/workspace";
import type { ListQueryControl } from "@/lib/list-query";
import { notificationErrorName } from "@/lib/detail-summary";
import { label, workItemHref, workItemTitle } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { SiteIdentity } from "@/components/site-identity";
import {
  BusinessTable,
  type BusinessColumn,
} from "@/components/business-table";
import {
  ListDateTime,
  ListIdentity,
  ListMeta,
  ListMoney,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

function RelatedRecord({ item, showSite }: { item: AdminWorkItem; showSite: boolean }) {
  const order = item.order_summary;
  if (order) {
    return (
      <div className="work-item-related-record">
        <ListIdentity
          meta={showSite && <SiteIdentity clientId={order.api_client_id} name={order.site_name} />}
          description={(
            <span>
              商户订单号 <span className="list-code" title={order.merchant_order_no}>{order.merchant_order_no}</span>
            </span>
          )}
        >
          <Link
            className="list-primary-link"
            aria-label={"查看订单：" + order.product_name}
            title={order.product_name}
            to={"/orders/" + order.order_id}
          >
            {order.product_name}
          </Link>
        </ListIdentity>
      </div>
    );
  }
  if (item.order_id) {
    return (
      <div className="list-identity">
        <span className="record-list-meta">订单摘要暂不可用</span>
        <Link
          className="list-secondary-link"
          aria-label={"查看订单，内部订单编号（PerPay）：" + item.order_id}
          to={"/orders/" + item.order_id}
        >
          内部订单编号（PerPay） <span className="list-code" title={item.order_id}>{item.order_id}</span>
        </Link>
      </div>
    );
  }
  const externalId = item.type === "LEDGER_CONFLICT" ? item.external_event_id : null;
  const reference = externalId ?? item.ledger_entry_id ?? item.resource_id;
  const referenceLabel = externalId ? "支付宝流水号" : item.ledger_entry_id ? "内部流水编号（PerPay）" : "提醒编号";
  return (
    <div className="list-identity">
      <span className="record-list-meta">未关联订单</span>
      <span className="record-list-meta">
        {referenceLabel} <span className="list-code" title={reference}>{reference}</span>
      </span>
    </div>
  );
}

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
  const { clientId } = useWorkspace();
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
          meta={item.type === "NOTIFICATION_FAILURE" && (
            <>
              {item.last_error_code && item.status !== "ACKNOWLEDGED" && (
                <div>{notificationErrorName(item.last_error_code)}</div>
              )}
              <div>通知事件：{label(item.event_type)}</div>
            </>
          )}
          description={(
            item.type === "NOTIFICATION_FAILURE" ||
            context.showInSummary("actionable_at") ||
            item.ignored_at
          ) && (
            <ListMeta>
              {item.type === "NOTIFICATION_FAILURE" && (
                <>
                  <span>已尝试 {item.attempt_count} 次</span>
                  {item.next_attempt_at && !item.ended && ["PENDING", "RETRY_WAIT"].includes(item.status) && (
                    <span>
                      {item.status === "PENDING" ? "计划投递" : "下次重试"}{" "}
                      <ListDateTime value={item.next_attempt_at} inline />
                    </span>
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
      id: "related_record",
      label: "关联记录",
      layout: "text",
      summaryDefault: true,
      cell: (item) => <RelatedRecord item={item} showSite={!clientId} />,
    },
    {
      id: "payable_amount_cents",
      label: "应付金额",
      align: "right",
      layout: "amount",
      summaryDefault: true,
      cell: (item) => <ListMoney value={item.order_summary?.payable_amount_cents} label="应付金额" />,
    },
    {
      id: "actionable_at",
      sortBy: "actionable_at",
      label: "提醒时间",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: {
        minWidthRem: 52,
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
        minWidthRem: 80,
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
              minWidthRem: 80,
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
          {item.ended || item.ignored_at ? (
            <Badge variant="secondary">
              {item.ended ? "已结束" : "已忽略"}
            </Badge>
          ) : (
            <StatusBadge
              value={item.type === "NOTIFICATION_FAILURE" ? item.status : item.type}
              label={item.type === "NOTIFICATION_FAILURE" && item.status !== "ACKNOWLEDGED" ? "通知失败" : undefined}
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
      tableClassName="work-items-table"
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
            column.id === "related_record" ? (
              <div key={column.id} className="business-summary-field col-span-full">
                <dt className="sr-only">{column.label}</dt>
                <dd className="w-full">{column.cell(item, context)}</dd>
              </div>
            ) : (
              <ListSummaryField key={column.id} label={column.label}>
                {column.cell(item, context)}
              </ListSummaryField>
            )
          ))}
        </ListSummary>
      )}
    />
  );
}
