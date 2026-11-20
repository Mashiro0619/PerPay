import { useQuery } from "@/lib/workspace-query";
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { Link } from "@/navigation";
import { result, type AdminOrderDetail, type FinancialException, type MatchCandidate, type ReconciliationLedgerEntry } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger, exceptionExplanation, exceptionResolution, exceptionStateLabel } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { OrderStatusBadge, StatusBadge } from "@/components/business-status";
import { OverlaySummary } from "@/components/overlay-actions";
import { ActionBar } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime, Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { ErrorNotice, Loading, ReadPausedNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAssociateIncome } from "./FinancialActions";
import { useRelatedOrder } from "./DetailPrimitives";
import { useRelatedLedger } from "./PaymentEvidence";

const note = "text-[0.8125rem] leading-5 text-muted-foreground";
const link = "text-[0.8125rem] leading-5 underline underline-offset-4";

/** What stands in for a part of the record while its own read is under way. */
function Pending({ query, label }: { query: { isPending: boolean; isPaused: boolean }; label: string }) {
  if (!query.isPending) return null;
  return query.isPaused ? <ReadPausedNotice /> : <Loading label={label} />;
}

/**
 * The two facts an exception turns on, order beside entry: what was due against what arrived, and when the
 * checkout stopped taking payment against when the payment was made.
 */
function comparison(order: AdminOrderDetail, entry: ReconciliationLedgerEntry) {
  const difference = entry.amount_cents - order.payable_amount_cents;
  const ended = order.checkout.closed_at ?? order.checkout.expires_at;
  const late = Date.parse(entry.occurred_at) >= Date.parse(ended);
  return [
    { label: "金额", differs: difference !== 0, left: <>应付 {money(order.payable_amount_cents)}</>,
      right: <>流水 {money(entry.amount_cents)}{difference !== 0 && <span data-amount-difference>（{difference > 0 ? "多" : "少"} {money(Math.abs(difference))}）</span>}</> },
    { label: "时间", differs: late, left: <>收银台{order.checkout.closed_at ? "关闭" : "到期"} <RecordTime value={ended} /></>,
      right: <>付款 <RecordTime value={entry.occurred_at} />{late && "（已结束）"}</> },
  ];
}

/** A financial exception: why it was raised, the order and the entry it concerns, and what became of it. */
export function ExceptionRecord({ exception }: { exception: FinancialException }) {
  const api = useWorkspaceApi();
  const { clientId } = useWorkspace();
  const { entry, query: ledgerQuery } = useRelatedLedger(exception.ledger_entry_id);
  const { order: related, query: orderQuery } = useRelatedOrder(exception.order_id);
  const order = related as AdminOrderDetail | undefined;
  const candidateQuery = useQuery({
    queryKey: ["candidate", exception.candidate_id],
    enabled: !!exception.candidate_id,
    queryFn: ({ signal }) => result(api.getReconciliationCandidate({ path: { candidateId: exception.candidate_id! }, signal })),
  });
  const candidate: MatchCandidate | undefined = candidateQuery.data?.data;
  const retired = ["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(exception.exception_type);
  const payment = order?.payment.status ?? null;
  const resolution = exceptionResolution(exception);
  const canAssociate = !retired && exception.status === "OPEN" &&
    (!exception.order_id || payment === "UNPAID" || (payment === "DISPUTED" && !order?.refund_mark.marked)) &&
    (!exception.ledger_entry_id || (entry?.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state)));
  const associate = useAssociateIncome({
    actionLabel: payment === "DISPUTED" ? "重新核对并确认收款" : "人工关联收款",
    orderId: exception.order_id ?? "", ledgerId: exception.ledger_entry_id ?? "", orderLabel: order?.product_name,
    ledgerLabel: entry ? money(entry.amount_cents) + " · " + dateTime(entry.occurred_at) : undefined,
  });
  const facts = candidate ? candidateFactsBeyondLedger(candidate, entry) : [];
  const incomplete = !!candidate && candidateFacts(candidate).length < 3;
  const evidence = !!exception.candidate_id && (!candidate || facts.length > 0 || incomplete);
  const history: TimelineEntry[] = [
    ...(exception.resolved_at ? [{ id: "resolved", title: "异常已处理", time: exception.resolved_at, body: resolution, tone: "success" as const }] : []),
    { id: "created", title: "发现异常", time: exception.created_at, body: exceptionExplanation(exception) },
  ];

  return <>
    <OverlaySummary>
      <RecordSummary label="异常概况"
        status={<StatusBadge value={exception.reminder_ignored ? "NONE" : exception.status} label={exceptionStateLabel(exception)} />}
        meta={[exceptionExplanation(exception)]}
        compare={order && entry ? comparison(order, entry) : []}
        nav={[
          { id: "order", label: "关联订单" },
          { id: "ledger", label: "支付宝流水" },
          ...(evidence ? [{ id: "evidence", label: "匹配依据" }] : []),
          { id: "history", label: "处理记录" },
        ]} />
    </OverlaySummary>
    <Sections label="账务异常详情内容">
      <Section id="order" title="关联订单" empty={!exception.order_id && "尚未关联订单"}>
        {order && <SubRecord title={order.product_name}
          status={<OrderStatusBadge payment={order.payment.status} checkout={order.checkout.status} refundMarked={order.refund_mark.marked} />}
          href={"/orders/" + order.order_id} hrefLabel="查看订单">
          <FieldList items={[
            { label: "商户订单号", kind: "id", value: order.merchant_order_no, copy: order.merchant_order_no },
            { label: "业务网站", value: <Link global className="underline underline-offset-4" to={"/sites/" + encodeURIComponent(order.api_client_id) + "/summary"}>{order.site_name ?? "业务网站名称暂不可用"}</Link> },
            { label: "应付金额", kind: "money", value: money(order.payable_amount_cents) },
            order.received_amount_cents !== null && { label: "实收金额", kind: "money", value: money(order.received_amount_cents) },
            { label: "创建时间", kind: "time", value: <RecordTime value={order.created_at} /> },
            { label: order.checkout.closed_at ? "收银台关闭" : "收银台到期", kind: "time", value: <RecordTime value={order.checkout.closed_at ?? order.checkout.expires_at} /> },
          ]} />
        </SubRecord>}
        {!order && <Pending query={orderQuery} label="正在读取关联订单…" />}
        <ErrorNotice scope="page" error={orderQuery.error} retainedData={!!order} retry={() => { void orderQuery.refetch(); }} placeholder="关联订单读取失败，请刷新重试。" />
      </Section>
      <Section id="ledger" title="支付宝流水" empty={!exception.ledger_entry_id && "这条异常没有对应的支付宝流水"}
        actions={exception.ledger_entry_id && <Link to={"/reconciliation/ledger/" + exception.ledger_entry_id} className={link}>查看流水<span aria-hidden="true"> ›</span></Link>}>
        {entry && <FieldList items={[
          { label: "交易金额", kind: "money", value: <span className="inline-flex flex-wrap items-center gap-2">{money(entry.amount_cents)}<StatusBadge value={entry.direction} /></span> },
          { label: "交易时间", kind: "time", value: <RecordTime value={entry.occurred_at} /> },
          { label: "对方", value: entry.other_account ?? "未提供" },
          !!entry.memo && { label: "支付宝备注", value: entry.memo },
          { label: "支付宝流水号", kind: "id", value: entry.external_event_id, copy: entry.external_event_id },
          entry.provider_order_no
            ? { label: "支付宝订单号", kind: "id", value: entry.provider_order_no, copy: entry.provider_order_no }
            : { label: "支付宝订单号", value: "未提供" },
          !!entry.merchant_order_no && { label: "支付宝商户单号", kind: "id", value: entry.merchant_order_no, copy: entry.merchant_order_no },
          { label: "内部流水编号（PerPay）", kind: "id", value: entry.ledger_entry_id, copy: entry.ledger_entry_id },
        ]} />}
        {!entry && <Pending query={ledgerQuery} label="正在读取关联流水…" />}
        <ErrorNotice scope="page" error={ledgerQuery.error} retainedData={!!entry} retry={() => { void ledgerQuery.refetch(); }} placeholder="关联流水读取失败，请刷新重试。" />
      </Section>
      {evidence && <Section id="evidence" title="匹配依据">
        {incomplete && <p className={note}>匹配信息不完整</p>}
        <FieldList items={facts.map(([label, value]) => ({ label, value }))} />
        {!candidate && <Pending query={candidateQuery} label="正在读取匹配依据…" />}
        <ErrorNotice scope="page" error={candidateQuery.error} retainedData={!!candidate} retry={() => { void candidateQuery.refetch(); }} placeholder="匹配依据读取失败，请刷新重试。" />
      </Section>}
      <Section id="history" title="处理记录">
        <Timeline label="处理记录" entries={history} />
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，异常记录操作"
      primary={canAssociate && (associate.action.to
        ? <Link global to={associate.action.to} className={buttonVariants()}>{associate.action.label}</Link>
        : <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={associate.action.disabled}
          onClick={event => associate.action.onSelect?.(event.currentTarget)}>{associate.action.label}</Button>)}
      technical={[{ title: "账务异常技术信息", data: exception, identifiers: [
        ["异常编号", exception.exception_id],
        ["网站编号", order?.api_client_id ?? clientId ?? null],
        ["内部流水编号（PerPay）", exception.ledger_entry_id],
        ["内部订单编号", exception.order_id],
        ["可能匹配记录编号", exception.candidate_id],
      ] }]} />
    {associate.dialog}
  </>;
}
