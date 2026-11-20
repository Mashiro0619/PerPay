import { Link } from "@/navigation";
import type { MatchCandidate, ReconciliationLedgerEntry } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger, candidateGuidance } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { OverlaySummary } from "@/components/overlay-actions";
import { ActionBar } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAssociateIncome } from "./FinancialActions";
import { useRelatedOrder } from "./DetailPrimitives";
import {
  evidenceLinkClass,
  evidenceNoteClass,
  ledgerEntryFields,
  orderLedgerComparison,
  orderPaymentStatus,
  PendingEvidence,
  RelatedOrderRecord,
  useRelatedLedger,
  type EvidenceOrder,
} from "./EvidenceParts";

/**
 * A match candidate record: why PerPay paired an order with an entry by amount and time,
 * how their amounts and timestamps compare, and whether an administrator may confirm it.
 */
export function CandidateRecord({
  candidate,
  ledger,
  order: knownOrder,
}: {
  candidate: MatchCandidate;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: EvidenceOrder | undefined;
}) {
  const { entry, query: ledgerQuery } = useRelatedLedger(candidate.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(candidate.order_id, knownOrder);
  const paymentStatus = order ? orderPaymentStatus(order) : null;
  const { canAssociate, guidance } = candidateGuidance(candidate, entry, paymentStatus);
  const associate = useAssociateIncome({
    orderId: candidate.order_id,
    ledgerId: candidate.ledger_entry_id,
    orderLabel: order?.product_name,
    ledgerLabel: entry ? money(entry.amount_cents) + " · " + dateTime(entry.occurred_at) : undefined,
  });
  const facts = candidateFactsBeyondLedger(candidate, entry);
  const incomplete = candidateFacts(candidate).length < 3;
  const history: TimelineEntry[] = [
    ...(candidate.decided_at ? [{
      id: "decided",
      title: candidate.status === "SELECTED" ? "已选用为收款关联" : "已被替代",
      time: candidate.decided_at,
      tone: candidate.status === "SELECTED" ? "success" as const : "muted" as const,
    }] : []),
    { id: "created", title: "形成匹配建议", time: candidate.created_at },
  ];

  return <>
    <OverlaySummary>
      <RecordSummary label="匹配概况"
        status={<StatusBadge value={candidate.status} />}
        meta={[guidance]}
        compare={order && entry ? orderLedgerComparison(order, entry) : []}
        nav={[
          { id: "order", label: "关联订单" },
          { id: "ledger", label: "支付宝流水" },
          { id: "evidence", label: "匹配依据" },
          { id: "history", label: "处理记录" },
        ]} />
    </OverlaySummary>
    <Sections label="可能匹配详情内容">
      <Section id="order" title="关联订单">
        {order && <RelatedOrderRecord order={order} />}
        {!order && <PendingEvidence query={orderQuery} label="正在读取关联订单…" />}
        {!knownOrder && <ErrorNotice scope="page" error={orderQuery.error} retainedData={!!order} retry={() => { void orderQuery.refetch(); }} placeholder="关联订单读取失败，请刷新重试。" />}
      </Section>
      <Section id="ledger" title="支付宝流水"
        actions={<Link to={"/reconciliation/ledger/" + candidate.ledger_entry_id} className={evidenceLinkClass}>查看流水<span aria-hidden="true"> ›</span></Link>}>
        {entry && <FieldList items={ledgerEntryFields(entry)} />}
        {!entry && <PendingEvidence query={ledgerQuery} label="正在读取关联流水…" />}
        {!ledger && <ErrorNotice scope="page" error={ledgerQuery.error} retainedData={!!entry} retry={() => { void ledgerQuery.refetch(); }} placeholder="关联流水读取失败，请刷新重试。" />}
      </Section>
      <Section id="evidence" title="匹配依据">
        {incomplete && <p className={evidenceNoteClass}>匹配信息不完整</p>}
        <FieldList items={facts.map(([label, value]) => ({ label, value }))} />
      </Section>
      <Section id="history" title="处理记录">
        <Timeline label="处理记录" entries={history} />
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，可能匹配记录操作"
      primary={canAssociate && entry && (associate.action.to
        ? <Link global to={associate.action.to} className={buttonVariants()}>{associate.action.label}</Link>
        : <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={associate.action.disabled}
          onClick={event => associate.action.onSelect?.(event.currentTarget)}>{associate.action.label}</Button>)}
      technical={[{ title: "匹配记录技术信息", data: candidate, identifiers: [
        ["可能匹配记录编号", candidate.candidate_id],
        ["内部订单编号", candidate.order_id],
        ["内部流水编号（PerPay）", candidate.ledger_entry_id],
      ] }]} />
    {associate.dialog}
  </>;
}
