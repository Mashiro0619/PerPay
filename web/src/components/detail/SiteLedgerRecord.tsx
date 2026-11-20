import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@/navigation";
import type { MatchCandidate, MatchCandidateListEnvelope, ReconciliationLedgerEntry } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger, candidateGuidance } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { AlipayAccountIdentity } from "@/components/alipay-account-identity";
import { OrderStatusBadge, StatusBadge } from "@/components/business-status";
import { LedgerState } from "@/components/ledger-record";
import { OverlaySummary } from "@/components/overlay-actions";
import { ActionBar, technicalEntries } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime } from "@/components/record/Timeline";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { useRelatedOrder } from "./DetailPrimitives";
import { useAssociateIncome } from "./FinancialActions";
import { evidenceNoteClass, orderPaymentStatus, PendingEvidence } from "./EvidenceParts";

/** "支付宝收款 · 对方" / "支付宝支出 · 对方", matching the global transaction record title. */
export function siteLedgerTitle(entry: ReconciliationLedgerEntry) {
  const kind = entry.direction === "CREDIT" ? "支付宝收款" : "支付宝支出";
  return entry.other_account ? kind + " · " + entry.other_account : kind;
}

/** A single ledger entry viewed inside a website workspace. */
export function SiteLedgerRecord({
  entry,
  candidates,
}: {
  entry: ReconciliationLedgerEntry;
  candidates: UseQueryResult<MatchCandidateListEnvelope, Error>;
}) {
  const isCredit = entry.direction === "CREDIT";
  const canAssociate = isCredit && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state);
  const associate = useAssociateIncome({
    ledgerId: entry.ledger_entry_id,
    ledgerLabel: money(entry.amount_cents) + " · " + dateTime(entry.occurred_at),
  });
  const records = isCredit ? candidates.data?.data ?? [] : [];
  const hasAccount = !!(entry.alipay_account_name || entry.alipay_account_id);

  return <>
    <OverlaySummary>
      <RecordSummary label="流水概况"
        value={(isCredit ? "+" : "−") + money(entry.amount_cents)}
        status={<><StatusBadge value={entry.direction} /><LedgerState value={entry.state} /></>}
        meta={[<>
          <RecordTime value={entry.occurred_at} />
          {hasAccount && <>{" · "}<AlipayAccountIdentity id={entry.alipay_account_id ?? null} name={entry.alipay_account_name ?? null} /></>}
        </>]}
        nav={[
          { id: "transaction", label: "交易信息" },
          ...(isCredit ? [{ id: "candidates", label: "可能匹配的订单", ...(records.length ? { count: records.length } : {}) }] : []),
          { id: "record", label: "PerPay 记录" },
        ]} />
    </OverlaySummary>
    <Sections label="支付宝流水详情内容">
      <Section id="transaction" title="交易信息">
        <FieldList items={[
          { label: "对方", value: entry.other_account ?? "未提供" },
          !!entry.memo && { label: "支付宝备注", value: entry.memo },
          { label: "支付宝流水号", kind: "id", value: entry.external_event_id, copy: entry.external_event_id },
          entry.provider_order_no
            ? { label: "支付宝订单号", kind: "id", value: entry.provider_order_no, copy: entry.provider_order_no }
            : { label: "支付宝订单号", value: "未提供" },
          !!entry.merchant_order_no && { label: "支付宝商户单号", kind: "id", value: entry.merchant_order_no, copy: entry.merchant_order_no },
        ]} />
      </Section>
      {isCredit && <Section id="candidates" title="可能匹配的订单" anchorPrefixes={["candidate-"]}
        {...(records.length ? { count: records.length } : {})}
        empty={candidates.data && !records.length ? "暂无可能匹配的订单。" : undefined}>
        <PendingEvidence query={candidates} label="正在读取可能匹配的订单…" />
        <ErrorNotice scope="page" error={candidates.error} retainedData={!!candidates.data}
          retry={() => { void candidates.refetch(); }} placeholder="可能匹配的订单读取失败，请刷新重试。" />
        {records.map(candidate => <SiteLedgerCandidate key={candidate.candidate_id} candidate={candidate} entry={entry} />)}
      </Section>}
      <Section id="record" title="PerPay 记录">
        <FieldList items={[
          { label: "PerPay 记录状态", value: <LedgerState value={entry.state} /> },
          { label: "PerPay 流水编号", kind: "id", value: entry.ledger_entry_id, copy: entry.ledger_entry_id },
          { label: "保存时间", kind: "time", value: <RecordTime value={entry.created_at} /> },
        ]} />
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，流水记录操作"
      primary={canAssociate && (associate.action.to
        ? <Link global to={associate.action.to} className={buttonVariants()}>{associate.action.label}</Link>
        : <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={associate.action.disabled}
          onClick={event => associate.action.onSelect?.(event.currentTarget)}>{associate.action.label}</Button>)}
      technical={technicalEntries([
        { title: "流水技术信息", created: entry.created_at, data: entry, identifiers: [
          ["PerPay 流水编号", entry.ledger_entry_id],
          ["支付宝流水号", entry.external_event_id],
        ] },
        ...records.map(candidate => ({
          id: "candidate-" + candidate.candidate_id,
          title: "匹配记录技术信息",
          created: candidate.created_at,
          data: candidate,
          identifiers: [["可能匹配记录编号", candidate.candidate_id]] as const,
        })),
      ])} />
    {associate.dialog}
  </>;
}

function SiteLedgerCandidate({ candidate, entry }: { candidate: MatchCandidate; entry: ReconciliationLedgerEntry }) {
  const { order, query } = useRelatedOrder(candidate.order_id);
  const paymentStatus = order ? orderPaymentStatus(order) : null;
  const { canAssociate, guidance } = candidateGuidance(candidate, entry, paymentStatus);
  const associate = useAssociateIncome({
    orderId: candidate.order_id,
    ledgerId: candidate.ledger_entry_id,
    orderLabel: order?.product_name,
    ledgerLabel: money(entry.amount_cents) + " · " + dateTime(entry.occurred_at),
    actionLabel: "关联到此订单",
  });
  const difference = order ? entry.amount_cents - order.payable_amount_cents : 0;
  return <SubRecord id={"candidate-" + candidate.candidate_id}
    title={order?.product_name ?? "可能匹配的订单"}
    status={<StatusBadge value={candidate.status} />}
    description={guidance}
    href={"/orders/" + candidate.order_id} hrefLabel="查看订单"
    actions={[
      ...(canAssociate ? [associate.action] : []),
      { label: "查看匹配详情", to: "/reconciliation/candidates/" + candidate.candidate_id },
    ]}
    actionsLabel="更多操作，匹配建议操作">
    <PendingEvidence query={query} label="正在读取关联订单…" />
    <ErrorNotice scope="page" error={query.error} retainedData={!!order}
      retry={() => { void query.refetch(); }} placeholder="关联订单读取失败，请刷新重试。" />
    <FieldList items={[
      ...(order ? [
        { label: "商户订单号", kind: "id" as const, value: order.merchant_order_no, copy: order.merchant_order_no },
        { label: "应付金额", kind: "money" as const, value: <>
          {money(order.payable_amount_cents)}
          {difference !== 0 && <span className="ml-1 font-normal text-destructive" data-amount-difference>（流水{difference > 0 ? "多" : "少"} {money(Math.abs(difference))}）</span>}
        </> },
        order.received_amount_cents !== null && { label: "实收金额", kind: "money" as const, value: money(order.received_amount_cents) },
        { label: "订单收款状态", value: <OrderStatusBadge payment={orderPaymentStatus(order)} checkout={"checkout" in order ? order.checkout.status : order.checkout_status} refundMarked={"refund_mark" in order && order.refund_mark.marked} /> },
      ] : []),
      ...candidateFactsBeyondLedger(candidate, entry).map(([name, value]) => ({ label: name, value })),
      { label: "形成时间", kind: "time", value: <RecordTime value={candidate.created_at} /> },
      !!candidate.decided_at && { label: "决定时间", kind: "time", value: <RecordTime value={candidate.decided_at} /> },
    ]} />
    {candidateFacts(candidate).length < 3 && <p className={evidenceNoteClass}>匹配信息不完整</p>}
    {associate.dialog}
  </SubRecord>;
}
