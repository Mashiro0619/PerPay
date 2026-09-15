import { useQuery } from "@tanstack/react-query";
import { api, result, type AdminOrderDetail, type FinancialException, type MatchCandidate, type PaymentMatchDetail, type ReconciliationLedgerEntry, type ReconciliationOrder } from "../../api/client";
import { Badge, CopyValue, ErrorNotice } from "../ui";
import { candidateFacts, detailTimestamp, exceptionExplanation, exceptionResolution, exceptionStateLabel, numberField } from "../../lib/detail-summary";
import { dateTime, money } from "../../lib/format";
import { label } from "../../lib/labels";
import { AssociateIncomeAction, ReverseMatchAction } from "./FinancialActions";
import { DetailFields, DetailLink, OrderFacts, TechnicalDetails, useRelatedOrder } from "./DetailPrimitives";

type DetailOrder = ReconciliationOrder | AdminOrderDetail;
export function LedgerFacts({ entry }: { entry: ReconciliationLedgerEntry }) {
  return <DetailFields items={[
    ["流水金额", <span className="detail-inline-value"><strong>{money(entry.amount_cents)}</strong><Badge value={entry.direction} /></span>],
    ["交易时间", detailTimestamp(entry.occurred_at)],
    ["支付宝订单号", entry.provider_order_no ? <CopyValue value={entry.provider_order_no} label="复制支付宝订单号" /> : "未提供"],
    ["交易对方", entry.other_account ?? "未提供"],
    ...(entry.merchant_order_no ? [["流水商户单号", <CopyValue value={entry.merchant_order_no} label="复制流水商户单号" />] as const] : []),
    ...(entry.memo ? [["流水备注", entry.memo] as const] : []),
  ]} />;
}
export function useRelatedLedger(ledgerId: string | null, known?: ReconciliationLedgerEntry) {
  const query = useQuery({ queryKey: ["ledger", ledgerId], enabled: !!ledgerId && !known, queryFn: ({ signal }) => result(api.getReconciliationLedgerEntry({ path: { ledgerEntryId: ledgerId! }, signal })) });
  return { entry: known ?? query.data?.data, query };
}
export function RelatedLedger({ ledgerId, known }: { ledgerId: string; known?: ReconciliationLedgerEntry | undefined }) {
  const { entry, query } = useRelatedLedger(ledgerId, known);
  return <div className="detail-related">{entry ? <LedgerFacts entry={entry} /> : query.isPending ? <p className="detail-empty" role="status">正在读取关联流水…</p> : null}
    {!known && <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />}
  </div>;
}
export function CandidateEvidence({ candidate, ledger }: { candidate: MatchCandidate; ledger?: ReconciliationLedgerEntry | undefined }) {
  const facts = candidateFacts(candidate);
  const shownFacts = facts.filter(([name]) => {
    if (!ledger) return true;
    if (name === "匹配金额") return numberField(candidate.evidence, "amount_cents") !== ledger.amount_cents;
    if (name === "流水发生时间") return numberField(candidate.evidence, "occurred_at") !== Date.parse(ledger.occurred_at);
    return true;
  });
  return <div className="detail-evidence"><p>{facts.length === 3 ? "金额推断：按同额收入与付款时间窗口形成匹配依据，并非支付平台按商户订单号确认。" : facts.length ? "此金额推断记录仅提供以下依据；缺失信息不能由当前证据确认。" : "该记录未提供可解释的金额窗口证据；仅展示已有事实，完整内容可在技术详情查看。"}</p>
    {shownFacts.length > 0 && <DetailFields items={shownFacts} />}
  </div>;
}
export function MatchCard({ match, embedded = false }: { match: PaymentMatchDetail; embedded?: boolean }) {
  const operation = match.creation_operation;
  const reversal = match.status === "REVERSED" ? match.resolution_operation : null;
  return <article className="detail-record" aria-label="收款关联记录">
    <div className="detail-record-heading"><h3>{match.evidence_type === "MANUAL" ? "人工关联收款" : "金额推断收款"}</h3><Badge value={match.status} /></div>
    {!embedded && <OrderFacts order={match.order} />}
    <LedgerFacts entry={match.ledger_entry} />
    <DetailFields items={[["确认时间", dateTime(operation?.created_at ?? match.created_at)],
      ["确认方式", match.evidence_type === "MANUAL" ? "管理员 " + (operation?.actor_id ?? "未记录") : "系统金额推断"],
      ...(operation?.reason ? [["关联理由", operation.reason] as const] : []),
      ...(match.status === "REVERSED" ? [["撤销时间", dateTime(reversal?.created_at ?? match.resolved_at)] as const, ["撤销操作人", reversal?.actor_id ?? "未记录"] as const, ["撤销理由", reversal?.reason ?? "未记录"] as const] : []),
    ]} />
    {match.candidate && <CandidateEvidence candidate={match.candidate} ledger={match.ledger_entry} />}
    <div className="detail-record-footer"><div className="detail-actions"><ReverseMatchAction match={match} /></div>{embedded && <DetailLink to={"/reconciliation/matches/" + match.payment_match_id} />}</div>
    <TechnicalDetails data={match} identifiers={[["关联编号", match.payment_match_id], ["流水编号", match.ledger_entry_id], ["候选编号", match.candidate_id]]} label="关联技术详情" />
  </article>;
}
export function CandidateCard({ candidate, ledger, order: knownOrder, embedded = false }: { candidate: MatchCandidate; ledger?: ReconciliationLedgerEntry | undefined; order?: DetailOrder | undefined; embedded?: boolean }) {
  const { entry, query } = useRelatedLedger(candidate.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(candidate.order_id, knownOrder);
  const paymentStatus = order ? "payment" in order ? order.payment.status : order.payment_status : null;
  return <article className="detail-record" aria-label="匹配候选证据">
    <div className="detail-record-heading"><h3>金额推断候选</h3><Badge value={candidate.status} /></div>
    {order ? <OrderFacts order={order} /> : orderQuery.isPending ? <p className="detail-empty" role="status">正在读取关联订单…</p> : null}
    {!knownOrder && <ErrorNotice error={orderQuery.error} retry={() => { void orderQuery.refetch(); }} />}
    {entry ? <LedgerFacts entry={entry} /> : query.isPending ? <p className="detail-empty" role="status">正在读取流水…</p> : null}
    {!ledger && <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />}
    <CandidateEvidence candidate={candidate} ledger={entry} />
    <p className="detail-caution">候选{candidate.status === "SELECTED" ? "已选用，但这不代表当前订单仍为已付款。" : "不等于付款已确认。"}请以订单付款状态和收款关联记录为准。</p>
    <DetailFields items={[["形成时间", dateTime(candidate.created_at)], ...(candidate.decided_at ? [["决定时间", dateTime(candidate.decided_at)] as const] : [])]} />
    <div className="detail-record-footer"><div className="detail-actions">{candidate.status === "ELIGIBLE" && entry?.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state) && paymentStatus === "UNPAID" && <AssociateIncomeAction orderId={candidate.order_id} ledgerId={candidate.ledger_entry_id} orderLabel={order?.product_name} ledgerLabel={money(entry.amount_cents) + " · " + dateTime(entry.occurred_at)} />}</div>{embedded && <DetailLink to={"/reconciliation/candidates/" + candidate.candidate_id} />}</div>
    <TechnicalDetails data={candidate} identifiers={[["候选编号", candidate.candidate_id]]} label="查看推断规则与证据" />
  </article>;
}
export function ExceptionCard({ exception, ledger, order: knownOrder, candidate: knownCandidate, embedded = false }: { exception: FinancialException; ledger?: ReconciliationLedgerEntry | undefined; order?: DetailOrder | undefined; candidate?: MatchCandidate | undefined; embedded?: boolean }) {
  const { entry, query } = useRelatedLedger(exception.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(exception.order_id, knownOrder);
  const candidateQuery = useQuery({ queryKey: ["candidate", exception.candidate_id], enabled: !!exception.candidate_id && !knownCandidate, queryFn: ({ signal }) => result(api.getReconciliationCandidate({ path: { candidateId: exception.candidate_id! }, signal })) });
  const candidate = knownCandidate ?? candidateQuery.data?.data;
  const retired = ["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(exception.exception_type);
  const payment = order ? "payment" in order ? order.payment.status : order.payment_status : null;
  const resolution = exceptionResolution(exception);
  return <article className="detail-record" aria-label="账务异常记录">
    <div className="detail-record-heading"><h3>{label(exception.exception_type)}</h3><Badge value={exception.reminder_ignored ? "NONE" : exception.status} label={exceptionStateLabel(exception)} /></div>
    <p className="detail-explanation">{exceptionExplanation(exception)}</p>
    {!embedded && (order ? <OrderFacts order={order} /> : exception.order_id && orderQuery.isPending ? <p className="detail-empty" role="status">正在读取关联订单…</p> : !exception.order_id ? <p className="detail-empty">尚未关联订单</p> : null)}
    {!knownOrder && exception.order_id && <ErrorNotice error={orderQuery.error} retry={() => { void orderQuery.refetch(); }} />}
    {entry ? <LedgerFacts entry={entry} /> : exception.ledger_entry_id && query.isPending ? <p className="detail-empty" role="status">正在读取关联流水…</p> : null}
    {!ledger && exception.ledger_entry_id && <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />}
    <DetailFields items={[["发现时间", dateTime(exception.created_at)], ...(exception.resolved_at ? [["处理时间", dateTime(exception.resolved_at)] as const] : []), ...(resolution ? [["处理结果", resolution] as const] : [])]} />
    {candidate && <CandidateEvidence candidate={candidate} ledger={entry} />}
    {!knownCandidate && exception.candidate_id && <ErrorNotice error={candidateQuery.error} retry={() => { void candidateQuery.refetch(); }} />}
    {exception.reminder_ignored && exception.status === "OPEN" && !retired && <p className="detail-caution">已关闭提醒，原始异常尚未解决。</p>}
    <div className="detail-record-footer"><div className="detail-actions">{!retired && exception.status === "OPEN" && (!exception.order_id && !knownOrder || payment === "UNPAID") && (!exception.ledger_entry_id || (entry?.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state))) && <AssociateIncomeAction orderId={order?.order_id ?? exception.order_id ?? ""} ledgerId={exception.ledger_entry_id ?? ""} orderLabel={order?.product_name} ledgerLabel={entry ? money(entry.amount_cents) + " · " + dateTime(entry.occurred_at) : undefined} />}</div>{embedded && <DetailLink to={"/reconciliation/exceptions/" + exception.exception_id} />}</div>
    <TechnicalDetails data={exception} identifiers={[["异常编号", exception.exception_id]]} label="异常技术详情" />
  </article>;
}
