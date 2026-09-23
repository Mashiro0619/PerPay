import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { dateTime, money } from "@/lib/format";
import type { ListQueryControl } from "@/lib/list-query";
import { StatusBadge } from "@/components/business-status";
import {
  BusinessTable,
  type BusinessColumn,
} from "@/components/business-table";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
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
      <span className="text-xs text-muted-foreground">
        {checkoutNames[order.checkout.status]}
      </span>
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
      className:
        "min-w-0 whitespace-normal py-3 @lg/orders:w-full @lg/orders:max-w-64",
      cell: (order) => (
        <div className="flex flex-col gap-1">
          <Link
            to={"/orders/" + order.order_id}
            data-row-link
            title={order.product_name}
            className="line-clamp-2 font-medium break-all hover:underline"
          >
            {order.product_name}
          </Link>
          <span
            className="truncate text-xs text-muted-foreground"
            title={order.merchant_order_no}
          >
            {order.merchant_order_no}
          </span>
          <time
            className="text-xs text-muted-foreground @2xl/orders:hidden"
            dateTime={order.created_at}
          >
            {dateTime(order.created_at)}
          </time>
          <div className="@lg/orders:hidden">
            <OrderStatus order={order} />
          </div>
        </div>
      ),
    },
    {
      id: "payable_amount_cents",
      sortBy: "payable_amount_cents",
      label: "应付金额",
      align: "right",
      cell: (order) => (
        <div className="flex min-w-0 flex-col gap-1 overflow-x-auto">
          <span>{money(order.payable_amount_cents)}</span>
          <span className="text-xs text-muted-foreground @3xl/orders:hidden">
            实收 {money(order.received_amount_cents)}
          </span>
        </div>
      ),
    },
    {
      id: "received_amount_cents",
      sortBy: "received_amount_cents",
      label: "实收金额",
      align: "right",
      className: "hidden @3xl/orders:table-cell",
      cell: (order) => money(order.received_amount_cents),
    },
    {
      id: "status",
      label: "状态",
      className: "hidden @lg/orders:table-cell",
      cell: (order) => <OrderStatus order={order} />,
    },
    {
      id: "created_at",
      sortBy: "created_at",
      label: "创建时间",
      className: "hidden @2xl/orders:table-cell",
      cell: (order) => (
        <time dateTime={order.created_at}>{dateTime(order.created_at)}</time>
      ),
    },
  ];
  return (
    <div className="@container/orders min-w-0">
      <BusinessTable
        id={control ? "orders" : "recent-orders"}
        items={data}
        columns={columns}
        rowId={(order) => order.order_id}
        control={control}
        tableClassName="table-fixed @lg/orders:table-auto"
        columnsMenu={!!control}
      />
    </div>
  );
}
