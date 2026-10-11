import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { useWorkspace } from "@/workspace";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { StatusBadge } from "@/components/business-status";
import {
  ListDateTime,
  ListIdentity,
  ListMeta,
  ListMoney,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import { SiteIdentity } from "@/components/site-identity";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

function OrderAmounts({ order }: { order: AdminOrderSummary }) {
  const received = order.received_amount_cents;
  if (received == null || received === order.payable_amount_cents) {
    return <ListMoney value={order.payable_amount_cents} label="应付金额" />;
  }
  return (
    <dl className="overview-order-money">
      <dt className="overview-record-note">应付</dt>
      <dd>
        <ListMoney value={order.payable_amount_cents} label="应付金额" secondary />
      </dd>
      <dt className="overview-record-note">实收</dt>
      <dd className="overview-order-received">
        <ListMoney value={received} label="实收金额" />
      </dd>
    </dl>
  );
}

function PaymentResult({ order }: { order: AdminOrderSummary }) {
  return (
    <div className="overview-record-stack business-cell-stack">
      <StatusBadge value={order.payment.status} />
      {order.refund_mark.marked && <StatusBadge value="ADMIN_REFUND_MARK" />}
    </div>
  );
}

function NotificationBadge({ summary }: { summary: NonNullable<AdminOrderSummary["notification_summary"]> }) {
  switch (summary.status) {
    case "NOT_CONFIGURED":
      return <Badge variant="secondary">未配置通知</Badge>;
    case "NO_EVENT":
      return <Badge variant="secondary">暂无通知事件</Badge>;
    case "UNMATERIALIZED":
      return <Badge variant="warning">等待生成投递</Badge>;
    case "ACKNOWLEDGED":
      return summary.total_events > 0 && summary.acknowledged_events === summary.total_events
        ? <StatusBadge value="ACKNOWLEDGED" label="全部已确认" />
        : <Badge variant="warning">尚未全部送达</Badge>;
    default:
      return <StatusBadge value={summary.status} />;
  }
}

function NotificationResult({ order }: { order: AdminOrderSummary }) {
  const summary = order.notification_summary;
  return summary
    ? <NotificationBadge summary={summary} />
    : <Badge variant="secondary">通知状态未知</Badge>;
}

function OrderTimes({ order }: { order: AdminOrderSummary }) {
  return (
    <div className="overview-order-times">
      <div className="overview-order-time-entry">
        <span className="overview-record-note">创建</span>
        <ListDateTime value={order.created_at} inline />
      </div>
      {order.payment_confirmed_at && (
        <div className="overview-order-time-entry">
          <span className="overview-record-note">确认</span>
          <ListDateTime value={order.payment_confirmed_at} inline />
        </div>
      )}
    </div>
  );
}

export function RecentOrders({ orders }: { orders: readonly AdminOrderSummary[] }) {
  const { clientId } = useWorkspace();
  if (!orders.length) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>暂无订单</EmptyTitle>
          <EmptyDescription>新订单会显示在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const columns: BusinessColumn<AdminOrderSummary>[] = [
    {
      id: "identity",
      label: "订单 / 商品",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (order, context) => (
        <ListIdentity
          meta={(order.product_name !== order.merchant_order_no || !clientId) && (
            <ListMeta>
              {order.product_name !== order.merchant_order_no && (
                <span className="list-code" title={order.merchant_order_no}>{order.merchant_order_no}</span>
              )}
              {!clientId && <SiteIdentity clientId={order.api_client_id} name={order.site_name} />}
            </ListMeta>
          )}
          description={context.showInSummary("created_at") && <OrderTimes order={order} />}
        >
          <Link data-row-link className="list-primary-link" title={order.product_name} to={"/orders/" + order.order_id}>
            {order.product_name}
          </Link>
        </ListIdentity>
      ),
    },
    {
      id: "amounts",
      label: "金额",
      align: "center",
      hideable: false,
      layout: "amount",
      summaryDefault: true,
      cell: (order) => <OrderAmounts order={order} />,
    },
    {
      id: "payment",
      label: "收款状态",
      align: "center",
      hideable: false,
      layout: "status",
      summaryDefault: true,
      cell: (order) => <PaymentResult order={order} />,
    },
    {
      id: "notification",
      label: "通知状态",
      align: "center",
      hideable: false,
      layout: "status",
      summaryDefault: true,
      cell: (order) => <NotificationResult order={order} />,
    },
    {
      id: "created_at",
      label: "时间",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 48, basis: "container" },
      cell: (order) => <OrderTimes order={order} />,
    },
  ];

  return (
    <div className="overview-orders">
      <BusinessTable
        id="overview-recent-orders"
        aria-label="最近订单"
        items={[...orders]}
        columns={columns}
        rowId={(order) => order.order_id}
        density="compact"
        embedded
        columnsMenu={false}
        tableClassName="overview-orders-table"
        renderSummary={(order, context) => (
          <ListSummary identity={columns[0]!.cell(order, context)} aside={<OrderAmounts order={order} />}>
            <ListSummaryField label="收款状态"><PaymentResult order={order} /></ListSummaryField>
            <ListSummaryField label="通知状态"><NotificationResult order={order} /></ListSummaryField>
            <ListSummaryField label="时间"><OrderTimes order={order} /></ListSummaryField>
          </ListSummary>
        )}
      />
    </div>
  );
}
