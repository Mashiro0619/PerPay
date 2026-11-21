import { useQuery } from "@/lib/workspace-query";
import { useWorkspaceApi } from "@/workspace";
import { result, type AdminOrderDetail, type FinancialException, type MatchCandidate, type PaymentMatchDetail, type ReconciliationLedgerEntry } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger, exceptionExplanation, exceptionResolution, exceptionStateLabel, type CandidateOrderRelease } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList, type Field } from "@/components/record/FieldList";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime } from "@/components/record/Timeline";
import type { DatedTechnicalEntry } from "@/components/record/ActionBar";
import { useIgnoreDisputeReminder } from "./disputed-order-actions";
import { useRelatedLedger } from "./EvidenceParts";
import { useAssociateIncome, useReverseMatch } from "./FinancialActions";

/** The facts needed to check an entry against the order, and the ones consulted only occasionally. */
function ledgerFields(entry: ReconciliationLedgerEntry): { primary: Field[]; extra: Field[] } {
  return {
    primary: [
      { label: "支付宝交易金额", kind: "money", value: <span className="inline-flex flex-wrap items-center gap-2">{money(entry.amount_cents)}<StatusBadge value={entry.direction} /></span> },
      { label: "支付宝交易时间", kind: "time", value: <RecordTime value={entry.occurred_at} /> },
      { label: "交易对方", value: entry.other_account ?? "未提供" },
      entry.provider_order_no
        ? { label: "支付宝订单号", kind: "id", value: entry.provider_order_no, copy: entry.provider_order_no }
        : { label: "支付宝订单号", value: "未提供" },
      ...(entry.memo ? [{ label: "支付宝备注", value: entry.memo }] : []),
    ],
    extra: [
      ...(entry.merchant_order_no ? [{ label: "支付宝商户单号", kind: "id" as const, value: entry.merchant_order_no, copy: entry.merchant_order_no }] : []),
      { label: "内部流水编号", kind: "id", value: entry.ledger_entry_id, copy: entry.ledger_entry_id },
    ],
  };
}

/** Collapsed evidence of a sub-record. `anchor` makes the candidate a `#candidate-…` target. */
function Evidence({ extra, candidate, ledger, order, anchor }: {
  extra: readonly Field[];
  candidate?: MatchCandidate | null | undefined;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: CandidateOrderRelease | null | undefined;
  anchor: boolean;
}) {
  const facts = candidate ? candidateFactsBeyondLedger(candidate, ledger, order) : [];
  const incomplete = !!candidate && candidateFacts(candidate).length < 3;
  if (!extra.length && !facts.length && !incomplete) return null;
  return <Disclosure label="核对凭据" count={extra.length + facts.length}>
    <FieldList items={extra} />
    {candidate && (facts.length > 0 || incomplete) && <div id={anchor ? "candidate-" + candidate.candidate_id : undefined} tabIndex={anchor ? -1 : undefined} data-match-evidence
      className="flex min-w-0 flex-col gap-1 rounded-md outline-none transition-colors duration-1000 data-anchor-hit:bg-accent data-anchor-hit:duration-0">
      <h4 className="text-[0.8125rem] leading-5 font-medium">匹配依据</h4>
      {incomplete && <p className="text-[0.8125rem] leading-5 text-muted-foreground">匹配信息不完整</p>}
      <FieldList items={facts.map(([name, value]) => ({ label: name, value }))} />
    </div>}
  </Disclosure>;
}

/**
 * One association between this order and an Alipay entry. `release` offers to
 * move a reversed association's entry to the order it really belongs to.
 */
export function OrderMatchRecord({ match, release = false }: { match: PaymentMatchDetail; release?: boolean }) {
  const operation = match.creation_operation;
  const reversal = match.status === "REVERSED" ? match.resolution_operation : null;
  // A reversed association moves into the collapsed history, taking its trigger with it.
  const reverse = useReverseMatch(match, true);
  const reassign = useAssociateIncome({ ledgerId: match.ledger_entry_id, ledgerLabel: match.ledger_entry.external_event_id, actionLabel: "将原流水关联到正确订单" });
  const { primary, extra } = ledgerFields(match.ledger_entry);
  return <SubRecord id={"match-" + match.payment_match_id} title="收款关联记录" status={<StatusBadge value={match.status} />}
    description={<>
      {match.evidence_type === "MANUAL" ? "管理员人工关联 · " + (operation?.actor_id ?? "未记录") : "PerPay 按金额和付款时间推断"}
      {" · "}<RecordTime value={operation?.created_at ?? match.created_at} />
    </>}
    href={"/reconciliation/matches/" + match.payment_match_id}
    actions={[...(reverse.action ? [reverse.action] : []), ...(release ? [reassign.action] : [])]} actionsLabel="更多操作，收款关联记录操作">
    <FieldList items={[
      ...primary,
      !!operation?.reason && { label: "关联理由", value: operation.reason },
      ...(match.status === "REVERSED" ? [
        { label: "撤销时间", kind: "time" as const, value: <RecordTime value={reversal?.created_at ?? match.resolved_at} /> },
        { label: "撤销操作人", value: reversal?.actor_id ?? "未记录" },
        { label: "撤销理由", value: reversal?.reason ?? "未记录" },
      ] : []),
    ]} />
    <Evidence extra={extra} candidate={match.candidate} ledger={match.ledger_entry} order={match.order} anchor />
    {reverse.dialog}
    {reassign.dialog}
  </SubRecord>;
}

/**
 * One reconciliation exception of this order. The entry and candidate come
 * from the order's associations when it has them, and are read otherwise.
 */
export function OrderExceptionRecord({ exception, order, ledger, candidate: knownCandidate, candidateAnchor = false, dismissible = false }: {
  exception: FinancialException;
  order: AdminOrderDetail;
  ledger?: ReconciliationLedgerEntry | undefined;
  candidate?: MatchCandidate | undefined;
  /** False when an association of the order already carries this candidate's anchor. */
  candidateAnchor?: boolean;
  /** A refund is on record, so this dispute reminder may be dismissed. */
  dismissible?: boolean;
}) {
  const api = useWorkspaceApi();
  const { entry, query } = useRelatedLedger(exception.ledger_entry_id, ledger);
  const candidateQuery = useQuery({
    queryKey: ["candidate", exception.candidate_id],
    enabled: !!exception.candidate_id && !knownCandidate,
    queryFn: ({ signal }) => result(api.getReconciliationCandidate({ path: { candidateId: exception.candidate_id! }, signal })),
  });
  const candidate = knownCandidate ?? candidateQuery.data?.data;
  const payment = order.payment.status;
  const resolution = exceptionResolution(exception);
  // The order footer already offers a general association entry; the exception
  // sub-record only adds a shortcut for its own specific available credit entry.
  const canAssociate = !["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(exception.exception_type) &&
    exception.status === "OPEN" &&
    (payment === "UNPAID" || (payment === "DISPUTED" && !order.refund_mark.marked)) &&
    !!exception.ledger_entry_id &&
    entry?.direction === "CREDIT" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state);
  const associate = useAssociateIncome({
    actionLabel: payment === "DISPUTED" ? "用此流水重新确认" : "用此流水关联",
    orderId: order.order_id,
    ledgerId: exception.ledger_entry_id ?? "",
    orderLabel: order.product_name,
    ledgerLabel: entry ? money(entry.amount_cents) + " · " + dateTime(entry.occurred_at) : undefined,
  });
  const ignore = useIgnoreDisputeReminder(exception.exception_id);
  const fields = entry ? ledgerFields(entry) : { primary: [], extra: [] };
  return <SubRecord id={"exception-" + exception.exception_id} title={label(exception.exception_type)}
    status={<StatusBadge value={exception.reminder_ignored ? "NONE" : exception.status} label={exceptionStateLabel(exception)} />}
    description={exceptionExplanation(exception)}
    href={"/reconciliation/exceptions/" + exception.exception_id}
    actions={[...(canAssociate ? [associate.action] : []), ...(dismissible ? [ignore.action] : [])]} actionsLabel="更多操作，异常记录操作">
    {dismissible && <ErrorNotice error={ignore.error} />}
    {!entry && exception.ledger_entry_id && query.isPending && <Loading label="正在读取关联流水…" />}
    {!ledger && exception.ledger_entry_id && <ErrorNotice scope="page" error={query.error} retry={() => { void query.refetch(); }} />}
    <FieldList items={[
      ...fields.primary,
      { label: "发现时间", kind: "time", value: <RecordTime value={exception.created_at} /> },
      !!exception.resolved_at && { label: "处理时间", kind: "time", value: <RecordTime value={exception.resolved_at} /> },
      !!resolution && { label: "处理结果", value: resolution },
    ]} />
    {!knownCandidate && exception.candidate_id && <ErrorNotice scope="page" error={candidateQuery.error} retry={() => { void candidateQuery.refetch(); }} />}
    <Evidence extra={fields.extra} candidate={candidate} ledger={entry} order={order} anchor={candidateAnchor} />
    {associate.dialog}
  </SubRecord>;
}

/** Raw data of the order's associations and exceptions for the record's single technical entry point. */
export function paymentTechnical(order: AdminOrderDetail): DatedTechnicalEntry[] {
  return [
    ...order.reconciliation.matches.map(match => ({
      id: "match-" + match.payment_match_id, title: "收款关联技术信息", created: match.created_at, data: match,
      identifiers: [["关联编号", match.payment_match_id], ["内部流水编号", match.ledger_entry_id], ["可能匹配记录编号", match.candidate_id]] as const,
    })),
    ...order.reconciliation.exceptions.map(exception => ({
      id: "exception-" + exception.exception_id, title: "异常记录技术信息", created: exception.created_at, data: exception,
      identifiers: [["异常编号", exception.exception_id]] as const,
    })),
  ];
}
