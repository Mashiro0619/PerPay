import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { dateTime, money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { LinkedTableRow } from "@/components/LinkedTableRow";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
const checkoutNames = {
  OPEN: "收银台开放中",
  CLOSED: "收银台已关闭",
  EXPIRED: "收银台已过期",
} as const;
export function DataTable({ data }: { data: AdminOrderSummary[] }) {
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
  return (
    <div className="@container/orders min-w-0">
      <Table className="table-fixed @lg/orders:table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>订单 / 商品</TableHead>
            <TableHead className="w-28 text-right @lg/orders:w-auto">
              应付金额
            </TableHead>
            <TableHead className="hidden text-right @3xl/orders:table-cell">
              实收金额
            </TableHead>
            <TableHead className="hidden @lg/orders:table-cell">状态</TableHead>
            <TableHead className="hidden @2xl/orders:table-cell">
              创建时间
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((order) => {
            const status = (
              <div className="flex flex-col items-start gap-1.5">
                <div className="flex flex-wrap gap-1">
                  <StatusBadge value={order.payment.status} />
                  {order.refund_mark.marked && (
                    <StatusBadge value="ADMIN_REFUND_MARK" />
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {checkoutNames[order.checkout.status]}
                </span>
              </div>
            );
            return (
              <LinkedTableRow key={order.order_id}>
                <TableCell className="min-w-0 whitespace-normal py-3 @lg/orders:w-full @lg/orders:max-w-64">
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
                    <div className="@lg/orders:hidden">{status}</div>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <div className="flex min-w-0 flex-col gap-1 overflow-x-auto">
                    <span>{money(order.payable_amount_cents)}</span>
                    <span className="text-xs text-muted-foreground @3xl/orders:hidden">
                      实收 {money(order.received_amount_cents)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden text-right tabular-nums @3xl/orders:table-cell">
                  {money(order.received_amount_cents)}
                </TableCell>
                <TableCell className="hidden @lg/orders:table-cell">
                  {status}
                </TableCell>
                <TableCell className="hidden text-muted-foreground @2xl/orders:table-cell">
                  <time dateTime={order.created_at}>
                    {dateTime(order.created_at)}
                  </time>
                </TableCell>
              </LinkedTableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
