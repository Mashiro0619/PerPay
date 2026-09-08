import { Link } from "../navigation";

import type { AdminOrderSummary } from "../api/client";
import { dateTime, money } from "../lib/format";
import { LinkedTableRow } from "./LinkedTableRow";
import { Badge, EmptyState } from "./ui";

export function OrderTable({ orders, compact = false }: { orders: AdminOrderSummary[]; compact?: boolean }) {
  if (!orders.length) return <EmptyState title="还没有订单" description="接入订单 API 或创建一笔测试收款后，订单会出现在这里。"><Link to="/test-payment" className="button">创建测试订单</Link></EmptyState>;
  return <div className="table-scroll order-table-scroll" role="region" aria-label="订单列表" tabIndex={0}><table className={`data-table order-table ${compact ? "order-table--compact" : ""}`} role="table"><thead role="rowgroup"><tr role="row">
    <th scope="col" role="columnheader">订单 / 商品</th><th scope="col" role="columnheader" className="numeric">应付金额</th>{!compact && <th scope="col" role="columnheader" className="numeric">实收金额</th>}
    <th scope="col" role="columnheader">付款状态</th>{!compact && <th scope="col" role="columnheader">收银台状态</th>}<th scope="col" role="columnheader">创建时间</th>
  </tr></thead><tbody role="rowgroup">{orders.map((order) => <LinkedTableRow key={order.order_id}>
    <td className="order-identity" role="cell"><Link className="table-primary" data-row-link title={order.product_name} to={`/orders/${order.order_id}`}>{order.product_name}</Link><span className="table-secondary mono" title={order.merchant_order_no}>{order.merchant_order_no}</span></td>
    <td className="numeric amount order-payable" role="cell"><span className="order-cell-label" aria-hidden="true">应付</span>{money(order.payable_amount_cents)}</td>{!compact && <td className="numeric amount order-received" role="cell"><span className="order-cell-label" aria-hidden="true">实收</span>{money(order.received_amount_cents)}</td>}
    <td className="order-payment" role="cell"><span className="order-cell-label" aria-hidden="true">付款</span><Badge value={order.payment.status} /></td>{!compact && <td className="order-checkout" role="cell"><span className="order-cell-label" aria-hidden="true">收银台</span><Badge value={order.checkout.status} /></td>}
    <td className="table-time order-created" role="cell"><time dateTime={order.created_at}>{dateTime(order.created_at)}</time></td>
  </LinkedTableRow>)}</tbody></table></div>;
}
