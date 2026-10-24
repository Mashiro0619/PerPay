import type { AdminWorkItem } from "@/api/client";
import { Link } from "@/navigation";
import { useWorkspace } from "@/workspace";
import { notificationErrorName } from "@/lib/detail-summary";
import { workItemHref, workItemTitle } from "@/lib/labels";
import { LinkedSummaryRow } from "@/components/LinkedTableRow";
import { StatusBadge } from "@/components/business-status";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { SiteIdentity } from "@/components/site-identity";
import { Badge } from "@/components/ui/badge";
import { ItemActions, ItemContent, ItemDescription, ItemGroup, ItemHeader, ItemTitle } from "@/components/ui/item";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

const workActions = {
  FINANCIAL_EXCEPTION: "核对异常",
  LEDGER_CONFLICT: "核对冲突",
  NOTIFICATION_FAILURE: "查看通知",
} as const;
const notificationTitles = {
  PENDING: "通知等待投递",
  LEASED: "通知正在投递",
  RETRY_WAIT: "通知等待重试",
  ACKNOWLEDGED: "通知已确认",
  DEAD_LETTER: "通知已停止重试",
} as const;

function itemReason(item: AdminWorkItem) {
  if (item.type !== "NOTIFICATION_FAILURE") return workItemTitle(item);
  if (item.last_error_code && item.status !== "ACKNOWLEDGED") return notificationErrorName(item.last_error_code);
  return notificationTitles[item.status];
}

function WorkStatus({ item }: { item: AdminWorkItem }) {
  if (item.ended) return <Badge variant="secondary">已结束</Badge>;
  if (item.ignored_at) return <Badge variant="secondary">已忽略</Badge>;
  if (item.type === "NOTIFICATION_FAILURE") {
    return <StatusBadge value={item.status} />;
  }
  return item.status === "OPEN"
    ? null
    : <StatusBadge value={item.status} />;
}

export function OverviewWorkItems({ items }: { items: readonly AdminWorkItem[] }) {
  const { clientId } = useWorkspace();
  if (!items.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>暂无待处理提醒</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup className="overview-work-list" aria-label="概览待处理" data-density="compact">
      {items.map((item) => {
        const order = item.order_summary;
        const orderId = order?.order_id ?? item.order_id;
        const ledgerIdentity = item.type === "LEDGER_CONFLICT"
          ? item.external_event_id ?? item.ledger_entry_id
          : item.ledger_entry_id;
        const ledgerLabel = item.type === "LEDGER_CONFLICT" && item.external_event_id
          ? "支付宝流水号"
          : "内部流水编号（PerPay）";
        const reason = itemReason(item);
        const action = workActions[item.type];
        return (
          <LinkedSummaryRow
            key={item.type + ":" + item.resource_id}
            density="compact"
            rowId={item.type + ":" + item.resource_id}
            className="overview-work-item"
            aria-label={reason + (order ? "，" + order.product_name : "")}
          >
            <ItemContent className="overview-work-content">
              <ItemHeader className="min-w-0">
                <ItemTitle className="min-w-0 max-w-full flex-1 line-clamp-2 wrap-anywhere">
                  <Link
                    data-row-link
                    className="list-primary-link"
                    aria-label={action + "：" + reason + (order ? "，" + order.product_name : "")}
                    title={reason}
                    to={workItemHref(item)}
                  >
                    {reason}
                  </Link>
                </ItemTitle>
                <ItemActions><WorkStatus item={item} /></ItemActions>
              </ItemHeader>
              {order ? (
                <div className="overview-work-order-heading">
                  <ItemDescription className="overview-work-order-context line-clamp-none">
                    <Link
                      className="overview-work-product"
                      aria-label={"查看订单：" + order.product_name}
                      title={order.product_name}
                      to={"/orders/" + order.order_id}
                    >
                      {order.product_name}
                    </Link>
                    {!clientId && <SiteIdentity clientId={order.api_client_id} name={order.site_name} />}
                  </ItemDescription>
                  <ItemActions className="overview-order-money-line" title="应付金额">
                    <span className="record-list-meta">应付</span>
                    <ListMoney value={order.payable_amount_cents} label="应付金额" />
                  </ItemActions>
                </div>
              ) : (
                <ItemDescription className="line-clamp-none flex min-w-0 flex-wrap gap-2 wrap-anywhere">
                  <span>{orderId ? "订单摘要暂不可用" : "未关联订单"}</span>
                  {orderId && (
                    <Link
                      className="list-code"
                      title={orderId}
                      aria-label={"查看订单，内部订单编号（PerPay）：" + orderId}
                      to={"/orders/" + orderId}
                    >
                      内部订单编号（PerPay） {orderId}
                    </Link>
                  )}
                  {ledgerIdentity && (
                    <span className="list-code" title={ledgerIdentity}>{ledgerLabel} {ledgerIdentity}</span>
                  )}
                </ItemDescription>
              )}
              <dl className="overview-work-fields">
                {order && order.product_name !== order.merchant_order_no && (
                  <div className="overview-work-order-reference">
                    <dt>商户订单号</dt>
                    <dd className="list-code" title={order.merchant_order_no}>{order.merchant_order_no}</dd>
                  </div>
                )}
                <div className="overview-work-time">
                  <dt>提醒</dt>
                  <dd><ListDateTime value={item.actionable_at} inline /></dd>
                </div>
              </dl>
              {item.type === "NOTIFICATION_FAILURE" && !item.ended &&
                ["PENDING", "RETRY_WAIT"].includes(item.status) && item.next_attempt_at && (
                <ItemDescription className="line-clamp-none wrap-anywhere">
                  {item.status === "RETRY_WAIT" ? "下次重试" : "计划投递"}{" "}
                  <ListDateTime value={item.next_attempt_at} inline />
                </ItemDescription>
              )}
            </ItemContent>
          </LinkedSummaryRow>
        );
      })}
    </ItemGroup>
  );
}
