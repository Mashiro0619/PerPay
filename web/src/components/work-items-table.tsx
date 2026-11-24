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
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

export interface WorkItemSelection {
  readonly selectedKeys: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly onToggle: (item: AdminWorkItem, checked: boolean) => void;
  readonly onToggleAll: (checked: boolean) => void;
}

export function workItemKey(item: Pick<AdminWorkItem, "type" | "resource_id">): string {
  return item.type + ":" + item.resource_id;
}

function workItemCategoryLabel(item: AdminWorkItem): string {
  if (item.type === "NOTIFICATION_FAILURE") return "通知失败";
  if (item.type === "LEDGER_CONFLICT") return "账本冲突";
  return "账务异常";
}

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

function ReminderStatus({
  item,
  showCategory = false,
}: {
  item: AdminWorkItem;
  showCategory?: boolean;
}) {
  if (item.ended || item.ignored_at) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-1">
        <Badge variant="secondary">{item.ended ? "已结束" : "已忽略"}</Badge>
        {showCategory && (
          <span className="text-xs text-muted-foreground">
            {workItemCategoryLabel(item)}
          </span>
        )}
      </div>
    );
  }
  return (
    <StatusBadge
      value={item.type === "NOTIFICATION_FAILURE" ? item.status : item.type}
      label={item.type === "NOTIFICATION_FAILURE" && item.status !== "ACKNOWLEDGED" ? "通知失败" : undefined}
    />
  );
}

export function WorkItemsTable({
  items,
  actions,
  inlineAction,
  selection,
  showCategoryInIgnored = false,
  control,
  emptyTitle = "暂无待处理提醒",
}: {
  items: AdminWorkItem[];
  actions?: ((item: AdminWorkItem) => ReactNode) | undefined;
  inlineAction?: ((item: AdminWorkItem) => ReactNode) | undefined;
  selection?: WorkItemSelection | undefined;
  showCategoryInIgnored?: boolean | undefined;
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

  const selectableItems = selection ? items.filter((item) => !item.ended) : [];
  const selectedOnPage = selection
    ? selectableItems.filter((item) => selection.selectedKeys.has(workItemKey(item))).length
    : 0;
  const allPageSelected = selectableItems.length > 0 && selectedOnPage === selectableItems.length;
  const somePageSelected = selectedOnPage > 0 && selectedOnPage < selectableItems.length;

  const columns: BusinessColumn<AdminWorkItem>[] = [
    ...(selection
      ? [
          {
            id: "select",
            label: "选择",
            hideable: false,
            menuHidden: true,
            align: "center" as const,
            layout: "select" as const,
            summaryDefault: false,
            header: () => (
              <div className="flex items-center justify-center" data-row-action>
                <Checkbox
                  aria-label="全选当前页提醒"
                  checked={allPageSelected}
                  indeterminate={somePageSelected}
                  disabled={selection.disabled || selectableItems.length === 0}
                  onCheckedChange={(value) => selection.onToggleAll(Boolean(value))}
                />
              </div>
            ),
            cell: (item: AdminWorkItem) => (
              <div className="flex items-center justify-center" data-row-action>
                <Checkbox
                  aria-label={"选择提醒：" + workItemTitle(item)}
                  checked={selection.selectedKeys.has(workItemKey(item))}
                  disabled={selection.disabled || item.ended}
                  onCheckedChange={(value) => selection.onToggle(item, Boolean(value))}
                />
              </div>
            ),
          },
        ]
      : []),
    {
      id: "identity",
      label: "提醒",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (item, context) => {
        const showIgnoredInIdentity =
          Boolean(item.ignored_at) &&
          (context.isSummary
            ? !control
            : !actions || !context.isColumnVisible("ignored_at"));
        return (
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
              showIgnoredInIdentity
            ) && (
              <ListMeta>
                {item.type === "NOTIFICATION_FAILURE" && (
                  <>
                    <span>已尝试 {item.attempt_count} 次</span>
                    {item.next_attempt_at && !item.ended && ["PENDING", "RETRY_WAIT"].includes(item.status) && (
                      <span>
                        {item.status === "PENDING" ? "计划发送" : "下次重试"}{" "}
                        <ListDateTime value={item.next_attempt_at} inline />
                      </span>
                    )}
                  </>
                )}
                {context.showInSummary("actionable_at") && (
                  <span>提醒时间 <ListDateTime value={item.actionable_at} inline /></span>
                )}
                {showIgnoredInIdentity && (
                  <span>
                    {item.ignored_by ?? "管理员"}已忽略 ·{" "}
                    <ListDateTime value={item.ignored_at} inline />
                  </span>
                )}
              </ListMeta>
            )}
          >
            <Link
              data-row-link
              data-reminder-id={workItemKey(item)}
              className="list-primary-link"
              to={workItemHref(item)}
            >
              {workItemTitle(item)}
            </Link>
          </ListIdentity>
        );
      },
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
        minWidthRem: actions ? 68 : 52,
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
      ...(actions
        ? { defaultVisible: false }
        : {
            responsive: {
              minWidthRem: 80,
              basis: "container" as const,
            },
          }),
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
              minWidthRem: 52,
              basis: "container" as const,
            },
            cell: (item: AdminWorkItem) => (
              <div className="business-cell-stack flex min-w-0 flex-col items-center gap-0.5">
                <ListDateTime value={item.ignored_at} />
                {item.ignored_by && (
                  <span
                    className="max-w-full truncate text-xs text-muted-foreground"
                    title={"操作人：" + item.ignored_by}
                  >
                    {item.ignored_by}
                  </span>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      id: "actions",
      label: actions ? "提醒状态" : "分类",
      hideable: false,
      align: "center",
      layout: "status",
      summaryDefault: true,
      cell: (item) => {
        const actionNode = actions?.(item) ?? inlineAction?.(item);
        return (
          <div className="business-cell-stack flex flex-col items-center gap-1.5">
            <ReminderStatus item={item} showCategory={Boolean(actions && showCategoryInIgnored)} />
            {actionNode && <div data-row-action>{actionNode}</div>}
          </div>
        );
      },
    },
  ];
  if (!clientId) {
    const relatedIndex = columns.findIndex((column) => column.id === "related_record");
    columns.splice(relatedIndex + 1, 0, {
      id: "site",
      label: "网站",
      layout: "text",
      summaryDefault: false,
      cell: (item) => (
        <SiteIdentity
          clientId={item.order_summary?.api_client_id}
          name={item.order_summary?.site_name}
        />
      ),
    });
  }
  const identityColumn = columns.find((column) => column.id === "identity")!;
  const actionsColumn = columns.find((column) => column.id === "actions")!;
  return (
    <BusinessTable
      id={actions ? "ignored-work-items" : "work-items"}
      tableClassName="work-items-table"
      aria-label={actions ? "已忽略提醒列表" : "待处理提醒列表"}
      items={items}
      columns={columns}
      rowId={workItemKey}
      control={control}
      density={control ? "default" : "compact"}
      embedded={!control}
      columnsMenu={!!control}
      renderSummary={(item, context) => (
        <ListSummary
          layout={control ? "activity" : undefined}
          identity={
            selection ? (
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="pt-0.5" data-row-action>
                  <Checkbox
                    aria-label={"选择提醒：" + workItemTitle(item)}
                    checked={selection.selectedKeys.has(workItemKey(item))}
                    disabled={selection.disabled || item.ended}
                    onCheckedChange={(value) => selection.onToggle(item, Boolean(value))}
                  />
                </div>
                <div className="min-w-0 flex-1">{identityColumn.cell(item, context)}</div>
              </div>
            ) : (
              identityColumn.cell(item, context)
            )
          }
          aside={
            control ? (
              <ReminderStatus item={item} showCategory={Boolean(actions && showCategoryInIgnored)} />
            ) : (
              actionsColumn.cell(item, context)
            )
          }
          actions={control && (actions?.(item) ?? inlineAction?.(item))}
          metadata={control && <dl className="activity-summary-context">
            {!clientId && <div><dt className="sr-only">网站</dt><dd><SiteIdentity clientId={item.order_summary?.api_client_id} name={item.order_summary?.site_name} /></dd></div>}
            <div><dt>提醒时间</dt><dd><ListDateTime value={item.actionable_at} inline /></dd></div>
            {item.ignored_at && (
              <div>
                <dt>忽略时间</dt>
                <dd>
                  {item.ignored_by ?? "管理员"} · <ListDateTime value={item.ignored_at} inline />
                </dd>
              </div>
            )}
          </dl>}
          details={columns.filter((column) =>
            column.id !== "select" &&
            context.isColumnVisible(column.id) &&
            !context.isSummaryPrimary(column.id),
          ).map((column) => (
            <ListSummaryField key={column.id} label={column.label}>
              {column.cell(item, context)}
            </ListSummaryField>
          ))}
        >
          {columns.filter((column) =>
            column.id !== "select" &&
            column.id !== "identity" &&
            column.id !== "actions" &&
            (!control || (column.id !== "actionable_at" && (column.id !== "payable_amount_cents" || !!item.order_summary))) &&
            context.isSummaryPrimary(column.id),
          ).map((column) => (
            column.id === "related_record" ? (
              <div key={column.id} className="business-summary-field activity-summary-related">
                <dt className="sr-only">{column.label}</dt>
                <dd className="w-full">{column.cell(item, context)}</dd>
              </div>
            ) : (
              <ListSummaryField key={column.id} label={column.label} visibleLabel={!!control} fullWidth={!!control && column.layout === "datetime"}>
                {column.cell(item, context)}
              </ListSummaryField>
            )
          ))}
        </ListSummary>
      )}
    />
  );
}
