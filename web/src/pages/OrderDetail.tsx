import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useParams } from "react-router";
import { api, refreshOperationalData, result, type AdminOrderDetail, type AdminOrderEvent, type PaymentMatchDetail } from "../api/client";
import { useDetailBack } from "../navigation";
import { Badge, Button, CopyValue, PageHeading, Panel, QueryView } from "../components/ui";
import { DetailFields, useDetailFetching, LazyDetails } from "../components/detail/DetailPrimitives";
import { AssociateIncomeAction } from "../components/detail/FinancialActions";
import { ExceptionCard, MatchCard } from "../components/detail/PaymentEvidence";
import { OrderNotifications } from "../components/detail/NotificationEvidence";
import { eventExplanation, isHistoricalException } from "../lib/detail-summary";
import { dateTime, money } from "../lib/format";
import { label } from "../lib/labels";
import { RefundMarkPanel } from "./RefundMark";

export function OrderDetail() {
  const { orderId = "" } = useParams();
  const back = useDetailBack("/orders", "全部订单");
  const order = useQuery({ queryKey: ["order", orderId], queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId }, signal })) });
  const fetching = useDetailFetching();
  return <div className="detail-page order-detail-page">
    <PageHeading title={order.data?.data.product_name ?? "订单详情"} back={back} actions={<Button pending={fetching > 0} onClick={() => { void refreshOperationalData(); }}><RefreshCw size={16} />刷新</Button>} />
    <QueryView query={order}>{({ data }) => <OrderDesk key={data.order_id} order={data} />}</QueryView>
  </div>;
}
function OrderDesk({ order }: { order: AdminOrderDetail }) {
  const matches = order.reconciliation.matches;
  const active = matches.filter(match => match.status === "SETTLED");
  const reversed = matches.filter(match => match.status === "REVERSED");
  const exceptions = order.reconciliation.exceptions.filter(exception => !isHistoricalException(exception));
  const history = order.reconciliation.exceptions.filter(isHistoricalException);
  const ledgers = new Map(matches.map(match => [match.ledger_entry_id, match.ledger_entry]));
  const candidates = new Map(matches.flatMap(match => match.candidate ? [[match.candidate.candidate_id, match.candidate] as const] : []));
  const confirmed = [...order.events].reverse().find(event => event.event_type === "PAYMENT_CONFIRMED");
  return <>
    <Panel className="detail-overview">
      <div className="detail-overview-top"><div className="detail-statuses"><Badge value={order.payment.status} /><Badge value={order.checkout.status} label={"收银台" + (order.checkout.status === "OPEN" ? "开放中" : order.checkout.status === "EXPIRED" ? "已过期" : "已关闭")} /></div></div>
      <div className="detail-amounts"><div className="detail-amount-primary"><span>实收金额</span><strong>{money(order.received_amount_cents)}</strong></div><div><span>应付金额</span><strong>{money(order.payable_amount_cents)}</strong></div>{order.requested_amount_cents !== order.payable_amount_cents && <div><span>原始金额</span><strong>{money(order.requested_amount_cents)}</strong></div>}</div>
      <DetailFields className="detail-overview-facts" items={[["商户订单号", <CopyValue value={order.merchant_order_no} label="复制商户订单号" />], ["创建时间", dateTime(order.created_at)], ...(confirmed ? [["付款确认时间", dateTime(confirmed.occurred_at)] as const] : []), ["付款截止", dateTime(order.checkout.expires_at)]]} />
      <RefundMarkPanel key={order.order_id} order={order} includeOrderTools />
    </Panel>
    <div className="order-detail-grid"><div className="order-detail-main">
      {exceptions.length > 0 && <Panel title={"账务异常 · " + exceptions.length} className="detail-panel detail-panel--attention">{exceptions.map(exception => <ExceptionCard key={exception.exception_id} exception={exception} candidate={exception.candidate_id ? candidates.get(exception.candidate_id) : undefined} ledger={exception.ledger_entry_id ? ledgers.get(exception.ledger_entry_id) : undefined} order={order} embedded />)}</Panel>}
      <Panel {...(!active.length ? { title: "收款" } : {})} className="detail-panel">
        {active.map(match => <MatchCard key={match.payment_match_id} match={match} embedded />)}
        {!active.length && <div className="detail-empty-row"><p className="detail-empty">{reversed.length ? "收款关联已撤销。" : "尚未关联收款。"}</p>{order.payment.status === "UNPAID" && <AssociateIncomeAction orderId={order.order_id} orderLabel={order.product_name} />}</div>}
        {reversed.length > 0 && <details className="detail-disclosure detail-panel-history" open={active.length === 0}><summary>已撤销的收款关联（{reversed.length}）</summary>{reversed.map(match => <MatchCard key={match.payment_match_id} match={match} embedded />)}</details>}
      </Panel>
      <Panel className="detail-panel"><OrderNotifications key={order.order_id} orderId={order.order_id} notifyUrl={order.notification.notify_url} /></Panel>
      {history.length > 0 && <LazyDetails className="detail-history-panel" summary={<>异常历史（{history.length}）<span>含已忽略、已处理记录</span></>}>{history.map(exception => <ExceptionCard key={exception.exception_id} exception={exception} candidate={exception.candidate_id ? candidates.get(exception.candidate_id) : undefined} ledger={exception.ledger_entry_id ? ledgers.get(exception.ledger_entry_id) : undefined} order={order} embedded />)}</LazyDetails>}
    </div><aside className="order-detail-aside" aria-label="订单动态与辅助信息">
      <Panel title="订单动态" className="detail-panel"><OrderTimeline events={order.events} matches={matches} /></Panel>
      {(order.note || order.refund.status !== "NONE") && <Panel title="补充信息" className="detail-panel"><div className="detail-record"><DetailFields items={[...(order.note ? [["订单备注", order.note] as const] : []), ...(order.refund.status !== "NONE" ? [["历史退款（只读）", <Badge value={order.refund.status} />] as const] : [])]} /></div></Panel>}
    </aside></div>
  </>;
}
function OrderTimeline({ events, matches }: { events: AdminOrderEvent[]; matches: PaymentMatchDetail[] }) {
  const operations = new Map(matches.flatMap(match => [match.creation_operation, match.resolution_operation].filter(operation => operation !== null && operation !== undefined).map(operation => [operation.financial_operation_id, operation] as const)));
  const ordered = [...events].sort((a, b) => b.sequence - a.sequence);
  const entries = (values: AdminOrderEvent[]) => <ol className="detail-event-list">{values.map(event => {
    const operationId = event.details.financial_operation_id;
    const operation = typeof operationId === "string" ? operations.get(operationId) : undefined;
    return <li key={event.event_id}><div><strong>{label(event.event_type)}</strong><time dateTime={event.occurred_at}>{dateTime(event.occurred_at)}</time></div><p>{eventExplanation(event)}</p>{operation?.reason && <p>{operation.actor_id ? operation.actor_id + "：" : ""}{operation.reason}</p>}</li>;
  })}</ol>;
  return <div className="detail-timeline">{ordered.length ? entries(ordered.slice(0, 6)) : <p className="detail-empty">暂无订单事件</p>}{ordered.length > 6 && <details className="detail-disclosure"><summary>更早动态（{ordered.length - 6}）</summary>{entries(ordered.slice(6))}</details>}</div>;
}
