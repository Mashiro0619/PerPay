import type { AdminOrderSummary } from "@/api/client";
import { Link } from "@/navigation";
import { ListMoney } from "@/components/list-primitives";
import { StatusBadge } from "@/components/business-status";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
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
    <ItemGroup className="record-list" data-density="compact" aria-label="最近订单">
      {orders.map((order) => (
          <Item key={order.order_id} className="record-list-row" size="sm" render={<Link to={"/orders/" + order.order_id} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="record-list-title" title={order.product_name}>
                {order.product_name}
              </ItemTitle>
              {order.product_name !== order.merchant_order_no && (
                <ItemDescription className="record-list-meta wrap-anywhere" title={order.merchant_order_no}>
                  {order.merchant_order_no}
                </ItemDescription>
              )}
            </ItemContent>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <ListMoney value={order.payable_amount_cents} />
              <StatusBadge value={order.payment.status} />
            </div>
          </Item>
      ))}
    </ItemGroup>
  );
}
