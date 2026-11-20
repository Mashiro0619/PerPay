import { Link } from "@/navigation";
import type { PaymentMatchDetail } from "@/api/client";
import { candidateFacts, candidateFactsBeyondLedger } from "@/lib/detail-summary";
import { money } from "@/lib/format";
import { StatusBadge } from "@/components/business-status";
import { OverlaySummary } from "@/components/overlay-actions";
import { ActionBar } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { RecordTime, Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { useReverseMatch } from "./FinancialActions";
import { evidenceLinkClass, evidenceNoteClass, ledgerEntryFields, RelatedOrderRecord } from "./EvidenceParts";

/**
 * A scoped payment association record: how an order and an Alipay entry were paired,
 * the evidence behind it, and its reversal history if reversed.
 */
export function MatchRecord({ match }: { match: PaymentMatchDetail }) {
  const manual = match.evidence_type === "MANUAL";
  const operation = match.creation_operation;
  const reversal = match.status === "REVERSED" ? match.resolution_operation : null;
  const reverse = useReverseMatch(match, false);
  const difference = match.ledger_entry.amount_cents - match.order.payable_amount_cents;
  const facts = match.candidate ? candidateFactsBeyondLedger(match.candidate, match.ledger_entry) : [];
  const incomplete = !!match.candidate && candidateFacts(match.candidate).length < 3;
  const evidence = !!match.candidate && (facts.length > 0 || incomplete);

  const createdBody = operation?.reason
    ? <p className="text-foreground">{manual ? (operation.actor_id ?? "未记录") + "：" : ""}{operation.reason}</p>
    : manual
      ? <p>{operation?.actor_id ?? "未记录"}</p>
      : undefined;
  const history: TimelineEntry[] = [
    ...(match.status === "REVERSED" ? [{
      id: "reversed",
      title: "撤销收款关联",
      time: reversal?.created_at ?? match.resolved_at ?? match.updated_at,
      tone: "danger" as const,
      body: <p className="text-foreground">{reversal?.actor_id ?? "未记录"}：{reversal?.reason ?? "未记录"}</p>,
    }] : []),
    {
      id: "created",
      title: manual ? "管理员人工关联" : "按金额和付款时间推断",
      time: operation?.created_at ?? match.created_at,
      tone: "success",
      ...(createdBody ? { body: createdBody } : {}),
    },
  ];

  return <>
    <OverlaySummary>
      <RecordSummary label="关联概况"
        value={money(match.ledger_entry.amount_cents)}
        status={<StatusBadge value={match.status} />}
        meta={[<>
          {manual ? "管理员人工关联 · " + (operation?.actor_id ?? "未记录") : "PerPay 按金额和付款时间推断"}
          {" · "}<RecordTime value={operation?.created_at ?? match.created_at} />
        </>]}
        compare={difference !== 0 ? [{
          label: "金额",
          differs: true,
          left: <>应付 {money(match.order.payable_amount_cents)}</>,
          right: <>流水 {money(match.ledger_entry.amount_cents)}<span data-amount-difference>（{difference > 0 ? "多" : "少"} {money(Math.abs(difference))}）</span></>,
        }] : []}
        nav={[
          { id: "order", label: "关联订单" },
          { id: "ledger", label: "支付宝流水" },
          ...(evidence ? [{ id: "evidence", label: "匹配依据" }] : []),
          { id: "history", label: "处理记录" },
        ]} />
    </OverlaySummary>
    <Sections label="收款关联详情内容">
      <Section id="order" title="关联订单">
        <RelatedOrderRecord order={match.order} />
      </Section>
      <Section id="ledger" title="支付宝流水"
        actions={<Link to={"/reconciliation/ledger/" + match.ledger_entry_id} className={evidenceLinkClass}>查看流水<span aria-hidden="true"> ›</span></Link>}>
        <FieldList items={ledgerEntryFields(match.ledger_entry)} />
      </Section>
      {evidence && <Section id="evidence" title="匹配依据">
        {incomplete && <p className={evidenceNoteClass}>匹配信息不完整</p>}
        <FieldList items={facts.map(([label, value]) => ({ label, value }))} />
      </Section>}
      <Section id="history" title="处理记录">
        <Timeline label="处理记录" entries={history} />
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，收款关联记录操作"
      menu={reverse.action ? [reverse.action] : []}
      technical={[{ title: "收款关联技术信息", data: match, identifiers: [
        ["关联编号", match.payment_match_id],
        ["PerPay 流水编号", match.ledger_entry_id],
        ["可能匹配记录编号", match.candidate_id],
        ["内部订单编号", match.order.order_id],
        ["网站编号", match.order.api_client_id],
      ] }]} />
    {reverse.dialog}
  </>;
}
