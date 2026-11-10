import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { useWorkspace } from "@/workspace";
import { useListSize } from "@/hooks/use-list-size";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { OrderStatusBadge, StatusBadge } from "@/components/business-status";
import {
  ListDateTime,
  ListIdentity,
  ListMoney,
  ListSummary,
} from "@/components/list-primitives";
import { SiteIdentity } from "@/components/site-identity";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

function OrderAmounts({ order }: { order: AdminOrderSummary }) {
  const received = order.received_amount_cents;
  if (received == null || received === order.payable_amount_cents) {
    return <span className="inline-flex min-w-0 flex-wrap items-baseline justify-end gap-1">
      <span className="overview-record-note">应付</span>
      <ListMoney value={order.payable_amount_cents} label="应付金额" />
    </span>;
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
      <OrderStatusBadge payment={order.payment.status} checkout={order.checkout.status} refundMarked={order.refund_mark.marked} />
    </div>
  );
}

function NotificationBadge({ summary }: { summary: NonNullable<AdminOrderSummary["notification_summary"]> }) {
  switch (summary.status) {
    case "NOT_CONFIGURED":
      return <Badge variant="secondary">此订单未设置通知地址</Badge>;
    case "NO_EVENT":
      return <Badge variant="secondary">暂无通知事件</Badge>;
    case "UNMATERIALIZED":
      return <Badge variant="warning">等待生成投递</Badge>;
    case "ACKNOWLEDGED":
      return summary.total_events > 0 && summary.acknowledged_events === summary.total_events
        ? <StatusBadge value="ACKNOWLEDGED" label="通知已确认" />
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
    <dl className="overview-order-times">
      <div className="overview-order-time-entry">
        <dt>创建</dt>
        <dd><ListDateTime value={order.created_at} inline /></dd>
      </div>
      {order.payment_confirmed_at && (
        <div className="overview-order-time-entry">
          <dt>确认</dt>
          <dd><ListDateTime value={order.payment_confirmed_at} inline /></dd>
        </div>
      )}
    </dl>
  );
}

function OrderProductLink({ order }: { order: AdminOrderSummary }) {
  return (
    <Link data-row-link className="list-primary-link" title={order.product_name} to={"/orders/" + order.order_id}>
      {order.product_name}
    </Link>
  );
}

function OrderMeta({ order, showSite, showTimes = false }: { order: AdminOrderSummary; showSite: boolean; showTimes?: boolean }) {
  return (
    <div className="overview-order-meta">
      <span className="overview-order-reference">
        <span>网站订单号</span>
        <span className="list-code" title={order.merchant_order_no}>{order.merchant_order_no}</span>
      </span>
      {showSite && <SiteIdentity clientId={order.api_client_id} name={order.site_name} />}
      {showTimes && <OrderTimes order={order} />}
    </div>
  );
}

function RecentOrderSummary({ order, showSite }: { order: AdminOrderSummary; showSite: boolean }) {
  const received = order.received_amount_cents;
  const hasReceipt = received != null;
  const differs = hasReceipt && received !== order.payable_amount_cents;
  const notification = order.notification_summary;
  const showNotification = !notification || !["NO_EVENT", "NOT_CONFIGURED"].includes(notification.status);
  return <ListSummary layout="order"
    identity={<>
      <ListIdentity><OrderProductLink order={order} /></ListIdentity>
      <dl className="order-summary-metadata">
        {showSite && <div><dt className="sr-only">网站</dt><dd><SiteIdentity clientId={order.api_client_id} name={order.site_name} /></dd></div>}
        <div><dt className="sr-only">创建时间</dt><dd><ListDateTime value={order.created_at} inline /></dd></div>
      </dl>
    </>}
    aside={<div className="order-summary-payment">
      <dl className="order-summary-amounts">
        <div className="order-summary-primary-amount">
          <dt>{hasReceipt ? "实收" : "应付"}</dt>
          <dd><ListMoney value={hasReceipt ? received : order.payable_amount_cents} label={hasReceipt ? "实收金额" : "应付金额"} /></dd>
        </div>
        {differs && <div className="order-summary-secondary-amount"><dt>应付</dt><dd><ListMoney value={order.payable_amount_cents} label="应付金额" secondary /></dd></div>}
        {!hasReceipt && order.payment.status === "CONFIRMED" && <div className="order-summary-secondary-amount"><dt>实收</dt><dd>金额暂缺</dd></div>}
      </dl>
      <div role="group" className="overview-summary-statuses" aria-label="收款与通知状态">
        <div role="group" aria-label="收款状态"><PaymentResult order={order} /></div>
        {showNotification && <div role="group" aria-label="通知状态"><NotificationResult order={order} /></div>}
        {differs && <Badge variant="warning">{received < order.payable_amount_cents ? "少收" : "多收"}</Badge>}
      </div>
    </div>}
  />;
}

export function RecentOrders({ orders }: { orders: readonly AdminOrderSummary[] }) {
  const { clientId } = useWorkspace();
  const { ref, size } = useListSize();
  const separateStatuses = size.container >= 64 * size.rem;
  if (!orders.length) {
    return (
      <div ref={ref} className="overview-orders"><Empty>
        <EmptyHeader>
          <EmptyTitle>暂无订单</EmptyTitle>
        </EmptyHeader>
      </Empty></div>
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
          meta={<OrderMeta order={order} showSite={!clientId} showTimes={context.showInSummary("created_at")} />}
        >
          <OrderProductLink order={order} />
        </ListIdentity>
      ),
    },
    {
      id: "amounts",
      label: "金额",
      align: "right",
      hideable: false,
      layout: "amount",
      summaryDefault: true,
      cell: (order) => <OrderAmounts order={order} />,
    },
    {
      id: "payment",
      label: separateStatuses ? "收款状态" : "收款 / 通知",
      align: "center",
      hideable: false,
      layout: "status",
      summaryDefault: true,
      cell: (order) => separateStatuses ? <PaymentResult order={order} /> : (
        <div className="overview-order-progress">
          <div role="group" aria-label="收款状态"><PaymentResult order={order} /></div>
          <div role="group" aria-label="通知状态"><NotificationResult order={order} /></div>
        </div>
      ),
    },
    ...(separateStatuses ? [{
      id: "notification",
      label: "通知状态",
      align: "center",
      hideable: false,
      layout: "status",
      summaryDefault: true,
      cell: (order) => <NotificationResult order={order} />,
    } satisfies BusinessColumn<AdminOrderSummary>] : []),
    {
      id: "created_at",
      label: "时间",
      align: "left",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 48, basis: "container" },
      cell: (order) => <OrderTimes order={order} />,
    },
  ];

  return (
    <div ref={ref} className="overview-orders">
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
        renderSummary={order => <RecentOrderSummary order={order} showSite={!clientId} />}
      />
    </div>
  );
}
