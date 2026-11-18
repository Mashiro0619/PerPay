import { useQuery } from '@/lib/workspace-query';
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { RefreshButton } from "@/components/refresh-button";
import { ExternalLink } from "lucide-react";
import { useParams } from "react-router";
import { queryClient, result, type AdminOrderDetail, type AdminOrderEvent, type PaymentMatchDetail } from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { eventExplanation, isHistoricalException } from "@/lib/detail-summary";
import { money, preciseDateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge, OrderStatusBadge, paymentBasisDescription } from "@/components/business-status";
import { AlipayAccountIdentity } from "@/components/alipay-account-identity";
import { ListMoney } from "@/components/list-primitives";
import { OverlaySummary } from "@/components/overlay-actions";
import { QueryView } from "@/components/request-state";
import { DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { disputeState } from "@/components/detail/disputed-order-actions";
import { useAssociateIncome } from "@/components/detail/FinancialActions";
import { notificationTechnical, OrderNotificationsSection, useOrderNotifications } from "@/components/detail/OrderNotificationRecords";
import { OrderExceptionRecord, OrderMatchRecord, paymentTechnical, type DatedTechnicalEntry } from "@/components/detail/OrderPaymentRecords";
import { ActionBar, type TechnicalEntry } from "@/components/record/ActionBar";
import type { RecordAction } from "@/components/record/ActionMenu";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList } from "@/components/record/FieldList";
import { RecordNotice, RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { RecordTime, Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { Button, buttonVariants } from "@/components/ui/button";
import { RefundMarkStatus, useRefundMark } from "./RefundMark";

export function OrderDetail() {
  const api = useWorkspaceApi();
  const { orderId = "" } = useParams();
  const back = useDetailBack("/orders", "全部订单");
  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId }, signal })),
  });
  return <DetailPage>
    <PageHeading title={order.data?.data.product_name ?? "订单详情"} />
    <DetailNavigation back={back}>
      <PageHeaderActions><RefreshButton disabled={order.isFetching} busy={order.isFetching} onClick={() => {
        void order.refetch();
        void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes("order-notifications") && query.queryKey.includes(orderId) });
      }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={order}>{({ data }) => <OrderDesk key={data.order_id} order={data} />}</QueryView>
  </DetailPage>;
}

/** Entries that share a title are told apart by when their record was created. */
function technicalEntries(entries: readonly DatedTechnicalEntry[]): TechnicalEntry[] {
  const titles = new Map<string, number>();
  for (const entry of entries) titles.set(entry.title, (titles.get(entry.title) ?? 0) + 1);
  return entries.map(({ created, ...entry }) => titles.get(entry.title)! > 1 ? { ...entry, note: preciseDateTime(created) } : entry);
}

const eventTones: Partial<Record<AdminOrderEvent["event_type"], NonNullable<TimelineEntry["tone"]>>> = {
  PAYMENT_CONFIRMED: "success",
  PAYMENT_DISPUTED: "danger",
  CHECKOUT_CLOSED: "muted",
  CHECKOUT_EXPIRED: "muted",
};

/** Newest first; an event caused by an administrator carries who acted and why. */
function orderTimeline(events: readonly AdminOrderEvent[], matches: readonly PaymentMatchDetail[]): TimelineEntry[] {
  const operations = new Map(matches.flatMap(match => [match.creation_operation, match.resolution_operation]
    .filter(operation => operation !== null && operation !== undefined)
    .map(operation => [operation.financial_operation_id, operation] as const)));
  return [...events].sort((a, b) => b.sequence - a.sequence).map(event => {
    const operationId = event.details.financial_operation_id;
    const operation = typeof operationId === "string" ? operations.get(operationId) : undefined;
    const explanation = eventExplanation(event);
    return {
      id: event.event_id,
      title: label(event.event_type),
      time: event.occurred_at,
      tone: eventTones[event.event_type] ?? "default",
      ...(explanation || operation?.reason ? { body: <>
        {explanation && <p>{explanation}</p>}
        {operation?.reason && <p className="text-foreground">{operation.actor_id ? operation.actor_id + "：" : ""}{operation.reason}</p>}
      </> } : {}),
    };
  });
}

function OrderDesk({ order }: { order: AdminOrderDetail }) {
  const { clientId } = useWorkspace();
  const basis = paymentBasisDescription(order.payment.basis);
  const matches = order.reconciliation.matches;
  const active = matches.filter(match => match.status === "SETTLED");
  const reversed = matches.filter(match => match.status === "REVERSED");
  const exceptions = order.reconciliation.exceptions.filter(exception => !isHistoricalException(exception));
  const history = order.reconciliation.exceptions.filter(isHistoricalException);
  const ledgers = new Map(matches.map(match => [match.ledger_entry_id, match.ledger_entry]));
  const candidates = new Map(matches.flatMap(match => match.candidate ? [[match.candidate.candidate_id, match.candidate] as const] : []));
  const confirmed = [...order.events].reverse().find(event => event.event_type === "PAYMENT_CONFIRMED");
  const unpaid = order.payment.status === "UNPAID";
  const dispute = order.payment.status === "DISPUTED" ? disputeState(order) : null;
  // A dispute stays open to reconfirmation or a refund until a refund is on record.
  const unresolved = !!dispute && !dispute.refunded;
  const received = order.received_amount_cents;
  const paid = received !== null && received !== undefined && received > 0;
  const difference = paid ? received - order.payable_amount_cents : 0;
  const unassociated = !active.length && !exceptions.length && !reversed.length;
  const pending = `${exceptions.length} 项待核对`;

  const notifications = useOrderNotifications(order.order_id);
  const refund = useRefundMark(order);
  const associate = useAssociateIncome({ orderId: order.order_id, orderLabel: order.product_name, ...(dispute ? { actionLabel: "重新核对并确认收款" } : {}) });

  // A candidate anchored by an association is not anchored again by an exception.
  const anchored = new Set(candidates.keys());
  const exceptionRecord = (exception: AdminOrderDetail["reconciliation"]["exceptions"][number]) => {
    const candidateAnchor = !!exception.candidate_id && !anchored.has(exception.candidate_id);
    if (candidateAnchor) anchored.add(exception.candidate_id!);
    return <OrderExceptionRecord key={exception.exception_id} exception={exception} order={order}
      candidate={exception.candidate_id ? candidates.get(exception.candidate_id) : undefined}
      ledger={exception.ledger_entry_id ? ledgers.get(exception.ledger_entry_id) : undefined}
      candidateAnchor={candidateAnchor} dismissible={!!dispute && dispute.dismissible.has(exception.exception_id)} />;
  };

  const checkout: RecordAction = {
    label: unpaid && order.checkout.status === "OPEN" ? "打开收银台" : "查看收银台结果",
    href: "/api/admin/v1" + (clientId ? "/sites/" + encodeURIComponent(clientId) : "") + "/orders/" + encodeURIComponent(order.order_id) + "/checkout",
    title: "在新标签页查看收银台",
  };
  const paymentCount = active.length + exceptions.length;

  return <>
    <OverlaySummary>
      <RecordSummary label="PerPay 收款状态" value={money(paid ? received : order.payable_amount_cents)}
        status={<OrderStatusBadge payment={order.payment.status} checkout={order.checkout.status} refundMarked={order.refund_mark.marked} />}
        meta={[
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="inline-flex items-baseline gap-1"><span>应付</span><ListMoney value={order.payable_amount_cents} /></span>
            <span className="inline-flex items-baseline gap-1">
              <span>实收</span><ListMoney value={received} />
              {difference !== 0 && <span className="text-destructive" data-amount-difference>（{difference > 0 ? "+" : "−"}{money(Math.abs(difference))}）</span>}
            </span>
            {basis && <span>{basis}</span>}
          </span>,
          <RecordTime value={order.created_at} />,
        ]}
        nav={[
          { id: "overview", label: "订单信息" },
          { id: "payments", label: "收款关联", ...(paymentCount ? { count: paymentCount } : {}) },
          { id: "notifications", label: "通知", ...(notifications.count ? { count: notifications.count } : {}) },
          { id: "history", label: "动态" },
        ]} />
    </OverlaySummary>
    {dispute ? <RecordNotice tone="danger" {...(exceptions.length ? { jump: { section: "payments", label: pending } } : {})}>
      {!active.length && !unassociated && <p>原收款关联已撤销，请继续核对付款凭证。</p>}
      <p>{dispute.guidance}</p>
    </RecordNotice> : exceptions.length > 0 && <RecordNotice tone="warning" jump={{ section: "payments", label: pending }}>
      {[...new Set(exceptions.map(exception => label(exception.exception_type)))].join("、")}
    </RecordNotice>}
    <Sections label="订单详情内容">
      <Section id="overview" title="订单信息">
        <FieldList items={[
          { label: "商户订单号", kind: "id", value: order.merchant_order_no, copy: order.merchant_order_no },
          Array.from(order.product_name).length > 24 && { label: "商品名称", value: order.product_name },
          !clientId && { label: "业务网站", value: <Link global className="underline underline-offset-4" to={"/sites/" + encodeURIComponent(order.api_client_id) + "/summary"}>{order.site_name ?? "业务网站名称暂不可用"}</Link> },
          { label: "收款账号", value: <AlipayAccountIdentity id={order.alipay_account_id} name={order.alipay_account_name} /> },
          { label: "下单金额", kind: "money", value: money(order.requested_amount_cents) },
          { label: "加价金额", kind: "money", value: money(order.payable_amount_cents - order.requested_amount_cents) },
          !!confirmed && { label: "确认收款时间", kind: "time", value: <RecordTime value={confirmed.occurred_at} /> },
          { label: "收银台状态", value: <StatusBadge value={order.checkout.status} /> },
          { label: "有效期至", kind: "time", value: <RecordTime value={order.checkout.expires_at} /> },
          !!order.note && { label: "订单备注", value: order.note },
          order.refund.status !== "NONE" && { label: "历史退款（只读）", value: <StatusBadge value={order.refund.status} /> },
        ]} />
        <RefundMarkStatus order={order} />
      </Section>
      <Section id="payments" title="收款关联" anchorPrefixes={["match-", "candidate-", "exception-"]} {...(paymentCount ? { count: paymentCount } : {})}
        empty={unassociated ? dispute ? "原收款关联已撤销，请继续核对付款凭证。" : "尚未关联收款。" : undefined}>
        {exceptions.map(exceptionRecord)}
        {active.map(match => <OrderMatchRecord key={match.payment_match_id} match={match} />)}
        {reversed.length > 0 && <Disclosure label="已撤销的收款关联" count={reversed.length} defaultOpen={!!dispute && dispute.released.size > 0}>
          {!!dispute && dispute.released.size > 0 && <p className="text-[0.8125rem] leading-5 text-muted-foreground">原流水属于其他订单时，选择正确订单继续处理：</p>}
          {reversed.map(match => <OrderMatchRecord key={match.payment_match_id} match={match} release={!!dispute && dispute.released.has(match.payment_match_id)} />)}
        </Disclosure>}
      </Section>
      <OrderNotificationsSection notifications={notifications} notifyUrl={order.notification.notify_url} />
      <Section id="history" title="动态">
        <Timeline label="订单动态" entries={orderTimeline(order.events, matches)} moreLabel="更早动态" empty="暂无订单事件" />
        {history.length > 0 && <Disclosure label="异常历史" count={history.length}>{history.map(exceptionRecord)}</Disclosure>}
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，订单操作"
      primary={(unpaid || unresolved) && <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={associate.action.disabled} onClick={event => associate.action.onSelect?.(event.currentTarget)}>{associate.action.label}</Button>}
      secondary={unresolved
        ? <Button variant="outline" onClick={event => refund.open(true, event.currentTarget, true)}>标记已退款</Button>
        : <a className={buttonVariants({ variant: "outline" })} href={checkout.href} target="_blank" rel="noopener noreferrer" title={checkout.title}>{checkout.label}<ExternalLink data-icon="inline-end" aria-hidden="true" /></a>}
      menu={[...(refund.action && !unresolved ? [refund.action] : []), ...(unresolved ? [checkout] : [])]}
      technical={technicalEntries([
        { title: "订单技术信息", created: order.created_at, data: order, identifiers: [["内部订单编号", order.order_id], ["网站编号", order.api_client_id]] },
        ...paymentTechnical(order),
        ...notificationTechnical(notifications.deliveries),
      ])} />
    {refund.dialog}
    {associate.dialog}
  </>;
}
