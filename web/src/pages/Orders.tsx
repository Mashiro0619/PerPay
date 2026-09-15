import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router";

import { useNavigate } from "../navigation";

import { api, result, type CheckoutStatus, type PaymentStatus } from "../api/client";
import { TestPaymentLink } from "../App";
import { OrderTable } from "../components/OrderTable";
import { Button, EmptyState, ErrorNotice, PageHeading, Pagination, Panel, QueryView, useCursor } from "../components/ui";

export default function Orders() {
  const [search, setSearch] = useSearchParams();
  const paymentValue = search.get("payment");
  const checkoutValue = search.get("checkout");
  const payment = ["UNPAID", "CONFIRMED", "DISPUTED"].includes(paymentValue ?? "") ? paymentValue as PaymentStatus : undefined;
  const checkout = ["OPEN", "CLOSED", "EXPIRED"].includes(checkoutValue ?? "") ? checkoutValue as CheckoutStatus : undefined;
  function filter(key: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("cursor"); next.delete("page");
    setSearch(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams(search);
    next.delete("payment");
    next.delete("checkout");
    next.delete("cursor"); next.delete("page");
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
    {page.data.length === 0 && pagination.page > 1 ? <EmptyState title="这一页暂无订单" description="订单列表可能已更新，返回上一页继续查看。"><Button onClick={pagination.previous}>{pagination.previousLabel === "返回首页" ? "返回首页" : "返回上一页"}</Button></EmptyState>
      : page.data.length === 0 && (payment || checkout) ? <EmptyState title="没有符合条件的订单" description="试试调整付款状态或收银台状态筛选。"><Button onClick={onClearFilters}>查看全部订单</Button></EmptyState> : <OrderTable orders={page.data} />}
    <Pagination previousLabel={pagination.previousLabel} page={pagination.page} count={page.data.length} hasNext={!!page.page.next_cursor} pending={orders.isFetching} onPrevious={pagination.previous} onNext={() => pagination.next(page.page.next_cursor)} />
  </>}</QueryView>;
}

export { OrderDetail } from "./OrderDetail";
