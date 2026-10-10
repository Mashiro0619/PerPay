import { useWorkspace } from "@/workspace";
import { SiteIdentity } from "@/components/site-identity";
import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import type { ListQueryControl } from "@/lib/list-query";
import { StatusBadge } from "@/components/business-status";
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
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
const checkoutNames = {
  OPEN: "收银台开放中",
  CLOSED: "收银台已关闭",
  EXPIRED: "收银台已过期",
} as const;
function OrderStatus({ order }: { order: AdminOrderSummary }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex flex-wrap gap-1">
        <StatusBadge value={order.payment.status} />
        {order.refund_mark.marked && <StatusBadge value="ADMIN_REFUND_MARK" />}
      </div>
      {order.payment.status !== "CONFIRMED" && <span className="text-xs text-muted-foreground">{checkoutNames[order.checkout.status]}</span>}
    </div>
  );
}
export function DataTable({
  data,
  control,
}: {
  data: AdminOrderSummary[];
  control?: ListQueryControl;
}) {
  const { clientId } = useWorkspace();
  if (!data.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle role="heading" aria-level={2}>
            暂无订单
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  const columns: BusinessColumn<AdminOrderSummary>[] = [
    {
      id: "identity",
      label: "订单 / 商品",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (order, context) => (
        <ListIdentity
          meta={
            <ListMeta>
              <span className="list-code" title={order.merchant_order_no}>
                {order.merchant_order_no}
              </span>
              {!clientId && (
                <SiteIdentity clientId={order.api_client_id} name={order.site_name} />
              )}
            </ListMeta>
          }
          description={(
            context.showInSummary("created_at") ||
            context.showInSummary("status") ||
            (!context.isColumnVisible("payable_amount_cents") && context.showInSummary("received_amount_cents"))
          ) && (
            <>
              {context.showInSummary("created_at") && (
                <ListDateTime value={order.created_at} inline />
              )}
              {context.showInSummary("status") && <OrderStatus order={order} />}
              {!context.isColumnVisible("payable_amount_cents") &&
                context.showInSummary("received_amount_cents") && (
                  <ListMeta>
                    <span>实收 <ListMoney value={order.received_amount_cents} secondary /></span>
                  </ListMeta>
                )}
            </>
          )}
        >
          <Link
            to={"/orders/" + order.order_id}
            data-row-link
            title={order.product_name}
            className="list-primary-link"
          >
            {order.product_name}
          </Link>
        </ListIdentity>
      ),
    },
    {
      id: "payable_amount_cents",
      sortBy: "payable_amount_cents",
      label: "应付金额",
      align: "right",
      layout: "amount",
      summaryDefault: true,
      cell: (order, context) => (
        <div className="flex flex-col items-end gap-1">
          <ListMoney value={order.payable_amount_cents} />
          {context.showInSummary("received_amount_cents") && (
            <ListMeta>
              <span>实收 <ListMoney value={order.received_amount_cents} secondary /></span>
            </ListMeta>
          )}
        </div>
      ),
    },
    {
      id: "received_amount_cents",
      sortBy: "received_amount_cents",
      label: "实收金额",
      align: "right",
      layout: "amount",
      summaryDefault: false,
      responsive: { minWidthRem: 62, basis: "container" },
      cell: (order) => <ListMoney value={order.received_amount_cents} />,
    },
    {
      id: "status",
      label: "状态",
      layout: "status",
      summaryDefault: true,
      responsive: { minWidthRem: 32, basis: "container" },
      cell: (order) => <OrderStatus order={order} />,
    },
    {
      id: "created_at",
      sortBy: "created_at",
      label: "创建时间",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 46, basis: "container" },
      cell: (order) => <ListDateTime value={order.created_at} />,
    },
  ];
  if (control) columns.push({
    id: "payment_confirmed_at", label: "付款确认时间",
    layout: "datetime", summaryDefault: false,
    responsive: { minWidthRem: 75, basis: "container" },
    cell: order => <ListDateTime value={order.payment_confirmed_at} />,
  });
  return (
    <div className="@container/orders min-w-0">
      <BusinessTable
        id={control ? "orders" : "recent-orders"}
        aria-label={control ? "订单列表" : "最近订单"}
        items={data}
        columns={columns}
        rowId={(order) => order.order_id}
        control={control}
        density={control ? "default" : "compact"}
        embedded={!control}
        renderSummary={(order, context) => (
          <ListSummary
            identity={columns[0]!.cell(order, context)}
            aside={context.isColumnVisible("payable_amount_cents") && (
              <div className="flex flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">应付金额</span>
                <ListMoney value={order.payable_amount_cents} />
              </div>
            )}
          >
            {columns.filter((column) =>
              column.id !== "identity" &&
              column.id !== "payable_amount_cents" &&
              context.isColumnVisible(column.id),
            ).map((column) => (
              <ListSummaryField key={column.id} label={column.label}>
                {column.cell(order, context)}
              </ListSummaryField>
            ))}
          </ListSummary>
        )}
        columnsMenu={!!control}
      />
    </div>
  );
}
