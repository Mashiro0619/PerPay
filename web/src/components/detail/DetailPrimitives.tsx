import { useState, type ReactNode } from "react";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, result, type AdminOrderDetail, type ReconciliationOrder } from "../../api/client";
import { Link } from "../../navigation";
import { Badge, CopyValue, ErrorNotice } from "../ui";
import { dateTime, money } from "../../lib/format";

const detailQueryScopes = new Set(["order", "order-notifications", "match", "candidate", "exception", "ledger", "ledger-candidates", "notification", "notification-attempts", "conflict"]);
export function useDetailFetching() {
  return useIsFetching({ predicate: query => detailQueryScopes.has(String(query.queryKey[0])) });
}

export function DetailFields({ items, className = "", wide = [] }: { items: ReadonlyArray<readonly [string, ReactNode]>; className?: string; wide?: readonly string[] }) {
  return <dl className={"detail-facts " + className}>{items.map(([name, value]) => <div key={name} data-wide={wide.includes(name) || undefined}><dt>{name}</dt><dd>{value ?? "—"}</dd></div>)}</dl>;
}
export function TechnicalDetails({ data, identifiers = [], label = "技术详情" }: { data: unknown; identifiers?: ReadonlyArray<readonly [string, string | null]>; label?: string }) {
  return <LazyDetails className="detail-disclosure detail-technical" summary={label}>
    {identifiers.length > 0 && <DetailFields items={identifiers.filter((entry): entry is readonly [string, string] => entry[1] !== null).map(([name, id]) => [name, <CopyValue value={id} label={"复制" + name} />])} />}
    <pre className="detail-raw">{JSON.stringify(data, null, 2)}</pre>
  </LazyDetails>;
}
export function DetailLink({ to, label = "打开独立详情" }: { to: string; label?: string }) {
  return <Link className="detail-link" to={to}>{label}<ExternalLink size={13} aria-hidden="true" /></Link>;
}
export function OrderFacts({ order, linked = true }: { order: ReconciliationOrder | AdminOrderDetail; linked?: boolean }) {
  const payment = "payment" in order ? order.payment.status : order.payment_status;
  return <div className="detail-order-facts"><div className="detail-record-heading"><strong>{linked ? <Link to={"/orders/" + order.order_id}>{order.product_name}</Link> : order.product_name}</strong><Badge value={payment} /></div>
    <DetailFields items={[["商户订单号", <CopyValue value={order.merchant_order_no} label="复制商户订单号" />], ["订单应付", money(order.payable_amount_cents)], ["订单实收", money(order.received_amount_cents)], ["创建时间", dateTime(order.created_at)]]} />
  </div>;
}
export function useRelatedOrder(orderId: string | null, known?: ReconciliationOrder | AdminOrderDetail) {
  const query = useQuery({ queryKey: ["order", orderId], enabled: !!orderId && !known, queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId: orderId! }, signal })) });
  return { order: known ?? query.data?.data, query };
}
export function LazyDetails({ summary, children, className = "", initialOpen = false }: { summary: ReactNode; children: ReactNode; className?: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{summary}</summary>{open && children}</details>;
}
export function RelatedOrder({ orderId }: { orderId: string }) {
  const { query } = useRelatedOrder(orderId);
  return <div className="detail-related">{query.isPending ? <p className="detail-empty" role="status">正在读取关联订单…</p> : query.data ? <OrderFacts order={query.data.data} /> : null}
    <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />
  </div>;
}
