import { Link } from "@/navigation";
import type { AdminOrderDetail, ReconciliationLedgerEntry, ReconciliationOrder } from "@/api/client";
import { money } from "@/lib/format";
import { OrderStatusBadge, StatusBadge } from "@/components/business-status";
import { FieldList, type Field } from "@/components/record/FieldList";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime } from "@/components/record/Timeline";
import { Loading, ReadPausedNotice } from "@/components/request-state";

export type EvidenceOrder = AdminOrderDetail | ReconciliationOrder;

export const evidenceNoteClass = "text-[0.8125rem] leading-5 text-muted-foreground";
export const evidenceLinkClass = "text-[0.8125rem] leading-5 underline underline-offset-4";

/** What stands in for a part of the record while its own read is under way. */
export function PendingEvidence({ query, label }: { query: { isPending: boolean; isPaused: boolean }; label: string }) {
  if (!query.isPending) return null;
  return query.isPaused ? <ReadPausedNotice /> : <Loading label={label} />;
}

export function orderPaymentStatus(order: EvidenceOrder) {
  return "payment" in order ? order.payment.status : order.payment_status;
}

export function orderCheckoutEnd(order: EvidenceOrder): { closed: boolean; at: string } {
  const closedAt = "checkout" in order ? order.checkout.closed_at : order.closed_at;
  const expiresAt = "checkout" in order ? order.checkout.expires_at : order.expires_at;
  return { closed: !!closedAt, at: closedAt ?? expiresAt };
}

/**
 * The two facts reconciliation evidence turns on, order beside entry: what was due against what arrived,
 * and when the checkout stopped taking payment against when the payment was made.
 */
export function orderLedgerComparison(order: EvidenceOrder, entry: ReconciliationLedgerEntry) {
  const difference = entry.amount_cents - order.payable_amount_cents;
  const ended = orderCheckoutEnd(order);
  const late = Date.parse(entry.occurred_at) >= Date.parse(ended.at);
  return [
    {
      label: "金额",
      differs: difference !== 0,
      left: <>应付 {money(order.payable_amount_cents)}</>,
      right: <>流水 {money(entry.amount_cents)}{difference !== 0 && <span data-amount-difference>（{difference > 0 ? "多" : "少"} {money(Math.abs(difference))}）</span>}</>,
    },
    {
      label: "时间",
      differs: late,
      left: <>收银台{ended.closed ? "关闭" : "到期"} <RecordTime value={ended.at} /></>,
      right: <>付款 <RecordTime value={entry.occurred_at} />{late && "（已结束）"}</>,
    },
  ];
}

/** One related order presented as a sub-record with its business facts and an optional link to its full record. */
export function RelatedOrderRecord({ order, linked = true, showSiteId = false }: { order: EvidenceOrder; linked?: boolean; showSiteId?: boolean }) {
  const payment = orderPaymentStatus(order);
  const checkout = "checkout" in order ? order.checkout.status : order.checkout_status;
  const refundMarked = "refund_mark" in order && order.refund_mark.marked;
  const ended = orderCheckoutEnd(order);
  const siteName = order.site_name ?? "业务网站名称暂不可用";
  return <SubRecord title={order.product_name}
    status={<OrderStatusBadge payment={payment} checkout={checkout} refundMarked={refundMarked} />}
    {...(linked ? { href: "/orders/" + order.order_id, hrefLabel: "查看订单" } : {})}>
    <FieldList items={[
      { label: "商户订单号", kind: "id", value: order.merchant_order_no, copy: order.merchant_order_no },
      {
        label: "业务网站",
        value: linked ? <Link global className="underline underline-offset-4" to={"/sites/" + encodeURIComponent(order.api_client_id) + "/summary"}>{siteName}</Link> : siteName,
        ...(showSiteId ? { hint: "网站编号：" + order.api_client_id } : {}),
      },
      { label: "应付金额", kind: "money", value: money(order.payable_amount_cents) },
      order.received_amount_cents !== null && { label: "实收金额", kind: "money", value: money(order.received_amount_cents) },
      { label: "创建时间", kind: "time", value: <RecordTime value={order.created_at} /> },
      { label: ended.closed ? "收银台关闭" : "收银台到期", kind: "time", value: <RecordTime value={ended.at} /> },
    ]} />
  </SubRecord>;
}

/** Full Alipay entry facts for reconciliation evidence records. */
export function ledgerEntryFields(entry: ReconciliationLedgerEntry): Array<Field | false> {
  return [
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
  ];
}
