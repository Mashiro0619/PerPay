import { Fragment } from "react";
import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemSeparator,
} from "@/components/ui/item";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";

/** Overview only: the order list and detail retain timestamps, lifecycle and technical columns. */
export function RecentOrders({
  orders,
}: {
  orders: readonly AdminOrderSummary[];
}) {
  if (!orders.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>暂无订单</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  return (
    <ItemGroup className="has-data-[size=xs]:gap-0" aria-label="最近订单">
      {orders.map((order, index) => (
        <Fragment key={order.order_id}>
          {index > 0 && <ItemSeparator className="my-0" />}
          <Item size="xs" render={<Link to={"/orders/" + order.order_id} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full">
                <span className="truncate">{order.product_name}</span>
              </ItemTitle>
              {order.product_name !== order.merchant_order_no && (
                <ItemDescription className="break-all">
                  {order.merchant_order_no}
                </ItemDescription>
              )}
            </ItemContent>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-sm font-medium tabular-nums">
                {money(order.payable_amount_cents)}
              </span>
              <StatusBadge value={order.payment.status} />
            </div>
          </Item>
        </Fragment>
      ))}
    </ItemGroup>
  );
}
