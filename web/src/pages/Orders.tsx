import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Search } from "lucide-react";
import { useParams, useSearchParams } from "react-router";

import { Link, useNavigate } from "../navigation";

import { api, result, type CheckoutStatus, type PaymentStatus } from "../api/client";
import { TestPaymentLink } from "../App";
import { OrderTable } from "../components/OrderTable";
import { Badge, Button, CopyValue, Details, EmptyState, ErrorNotice, JsonDetails, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";
import { dateTime, money, shortId } from "../lib/format";
import { label } from "../lib/labels";

export default function Orders() {
  const [search, setSearch] = useSearchParams();
  const paymentValue = search.get("payment");
  const checkoutValue = search.get("checkout");
  const payment = ["UNPAID", "CONFIRMED", "DISPUTED"].includes(paymentValue ?? "") ? paymentValue as PaymentStatus : undefined;
  const checkout = ["OPEN", "CLOSED", "EXPIRED"].includes(checkoutValue ?? "") ? checkoutValue as CheckoutStatus : undefined;
  function filter(key: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    setSearch(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams(search);
    next.delete("payment");
    next.delete("checkout");
    setSearch(next, { replace: true });
  }
  return <><PageHeading title="订单" actions={<TestPaymentLink />} />
    <Panel><div className="orders-toolbar"><OrderSearch /><div className="filter-group">
      <label><span className="sr-only">付款状态筛选</span><select value={payment ?? ""} onChange={(event) => filter("payment", event.target.value)}><option value="">全部付款状态</option><option value="UNPAID">未付款</option><option value="CONFIRMED">已确认</option><option value="DISPUTED">有争议</option></select></label>
      <label><span className="sr-only">收银台状态筛选</span><select value={checkout ?? ""} onChange={(event) => filter("checkout", event.target.value)}><option value="">全部收银台状态</option><option value="OPEN">开放中</option><option value="CLOSED">已关闭</option><option value="EXPIRED">已过期</option></select></label>
    </div></div>{(payment || checkout) && <div className="list-subtoolbar active-filters"><span>已筛选 {[payment, checkout].filter(Boolean).length} 项</span><Button variant="quiet" onClick={clearFilters}>清除筛选</Button></div>}<OrderPage key={`${payment}:${checkout}`} payment={payment} checkout={checkout} onClearFilters={clearFilters} /></Panel>
  </>;
}

function OrderSearch() {
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("merchant");
  const navigate = useNavigate();
  const lookup = useMutation({
    mutationFn: () => kind === "merchant" ? result(api.getAdministratorOrderByMerchantNumber({ path: { merchantOrderNo: value.trim() } })) : result(api.getAdministratorOrder({ path: { orderId: value.trim() } })),
    onSuccess: ({ data }) => navigate(`/orders/${data.order_id}`),
  });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (value.trim()) lookup.mutate(); }
  return <div className="order-search-wrap"><form className="order-search" onSubmit={submit} role="search">
    <label><span className="sr-only">订单查询方式</span><select value={kind} disabled={lookup.isPending} onChange={(event) => { setKind(event.target.value); lookup.reset(); }}><option value="merchant">商户订单号</option><option value="internal">内部订单编号</option></select></label>
    <label className="search-input"><Search size={16} aria-hidden="true" /><span className="sr-only">订单号</span><input name="order-query" type="search" value={value} maxLength={128} disabled={lookup.isPending} required autoComplete="off" placeholder="输入完整订单号" onChange={(event) => { setValue(event.target.value); lookup.reset(); }} /></label>
    <Button type="submit" pending={lookup.isPending} disabled={!value.trim()}>查找</Button>
  </form><ErrorNotice error={lookup.error} /></div>;
}

function OrderPage({ payment, checkout, onClearFilters }: { payment: PaymentStatus | undefined; checkout: CheckoutStatus | undefined; onClearFilters: () => void }) {
  const pagination = useCursor();
  const orders = useQuery({
    queryKey: ["orders", payment, checkout, pagination.cursor],
    queryFn: ({ signal }) => result(api.listAdministratorOrders({ signal, query: {
      limit: 20, ...(payment ? { payment_status: payment } : {}), ...(checkout ? { checkout_status: checkout } : {}), ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    } })),
  });
  return <QueryView query={orders}>{(page) => <>
    {page.data.length === 0 && pagination.page > 1 ? <EmptyState title="这一页暂无订单" description="订单列表可能已更新，返回上一页继续查看。"><Button onClick={pagination.previous}>返回上一页</Button></EmptyState>
      : page.data.length === 0 && (payment || checkout) ? <EmptyState title="没有符合条件的订单" description="试试调整付款状态或收银台状态筛选。"><Button onClick={onClearFilters}>查看全部订单</Button></EmptyState> : <OrderTable orders={page.data} />}
    <Pagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={orders.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
  </>}</QueryView>;
}

export function OrderDetail() {
  const { orderId = "" } = useParams();
  const order = useQuery({ queryKey: ["order", orderId], queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId }, signal })) });
  return <><PageHeading title="订单详情" back={{ to: "/orders", label: "全部订单" }} actions={<Button pending={order.isFetching} onClick={() => { void order.refetch(); }}><RefreshCw size={16} />刷新</Button>} />
    <QueryView query={order}>{({ data }) => <>
      <Panel title={data.product_name} action={<Badge value={data.payment.status} />} className="content-panel">
        <div className="order-amounts"><div><span>原始金额</span><strong>{money(data.requested_amount_cents)}</strong></div><div><span>应付金额（含尾差）</span><strong>{money(data.payable_amount_cents)}</strong></div><div><span>实收金额</span><strong>{money(data.received_amount_cents)}</strong></div></div>
        <Details items={[["商户订单号", <CopyValue value={data.merchant_order_no} />], ["内部订单编号", <CopyValue value={data.order_id} />], ["付款依据", <Badge value={data.payment.basis} />], ["收银台状态", <Badge value={data.checkout.status} />], ["退款记录", <Badge value={data.refund.status} />], ["订单版本", data.version], ["创建时间", dateTime(data.created_at)], ["收银台过期时间", dateTime(data.checkout.expires_at)], ["备注", data.note ?? "无备注"]]} />
      </Panel>
      <div className="two-column"><Panel title="订单时间线"><ol className="timeline">{data.events.map((event) => <li key={event.event_id}><span className="timeline-node" /><div><strong>{label(event.event_type)}</strong><time>{dateTime(event.occurred_at)}</time><JsonDetails data={event.details} label="查看事件详情" /></div></li>)}</ol></Panel>
        <Panel title="对账依据" className="content-panel">
          {data.reconciliation.matches.length === 0 && data.reconciliation.exceptions.length === 0 ? <EmptyState title="暂无对账记录" /> : <ul className="related-list">
            {data.reconciliation.matches.map((match) => <li key={match.payment_match_id}><Link to={`/reconciliation/matches/${match.payment_match_id}`}><span><strong>{money(match.ledger_entry.amount_cents)}</strong><small>{match.evidence_type === "MANUAL" ? "人工关联" : "金额推断关联"} · {dateTime(match.created_at)}</small></span><Badge value={match.status} /><ArrowRight size={16} /></Link></li>)}
            {data.reconciliation.exceptions.map((exception) => <li key={exception.exception_id}><Link to={`/reconciliation/exceptions/${exception.exception_id}`}><span>{label(exception.exception_type)}</span><Badge value={exception.status} label={exception.status === "OPEN" ? "待处理" : "已处理"} /><ArrowRight size={16} /></Link></li>)}
          </ul>}
        </Panel></div>
      <Panel title="业务通知历史"><OrderNotifications key={orderId} orderId={orderId} /></Panel>
      <JsonDetails data={data} label="查看完整订单字段" />
    </>}</QueryView>
  </>;
}

function OrderNotifications({ orderId }: { orderId: string }) {
  const pagination = useCursor();
  const deliveries = useQuery({ queryKey: ["order-notifications", orderId, pagination.cursor], queryFn: ({ signal }) => result(api.listAdministratorOrderWebhookDeliveries({ path: { orderId }, signal, query: { limit: 10, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) } })) });
  return <QueryView query={deliveries}>{(page) => <>
    {page.data.length ? <div className="table-scroll" role="region" aria-label="订单通知记录" tabIndex={0}><table className="data-table"><thead><tr><th>投递编号</th><th>事件</th><th>状态</th><th>尝试次数</th><th>创建时间</th></tr></thead><tbody>{page.data.map((item) => <tr key={item.delivery.delivery_id}>
      <td><Link className="mono" to={`/notifications/${item.delivery.delivery_id}`}>{shortId(item.delivery.delivery_id)}</Link></td><td>{label(item.event.event_type)}</td><td><Badge value={item.delivery.status} /></td><td>{item.delivery.attempt_count}</td><td>{dateTime(item.delivery.created_at)}</td>
    </tr>)}</tbody></table></div> : <EmptyState title="暂无通知投递" description="订单没有配置通知地址，或尚未产生需要通知的付款事件。" />}
    <Pagination page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={deliveries.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
  </>}</QueryView>;
}
