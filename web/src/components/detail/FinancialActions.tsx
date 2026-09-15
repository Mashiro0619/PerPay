import { useState } from "react";
import { api, refreshOperationalData, result, type PaymentMatchDetail } from "../../api/client";
import { FinancialDialog } from "../../pages/FinancialDialog";
import { ReasonDialog } from "../ReasonDialog";
import { Button } from "../ui";
import { money } from "../../lib/format";
import { DetailFields } from "./DetailPrimitives";

export function AssociateIncomeAction({ orderId = "", ledgerId = "", orderLabel, ledgerLabel }: { orderId?: string; ledgerId?: string; orderLabel?: string; ledgerLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return <><Button disabled={saved} onClick={() => setOpen(true)}>人工关联收款</Button>{saved && <span className="detail-feedback" role="status">已保存，相关记录已刷新。</span>}
    {open && <FinancialDialog initialOrderId={orderId} initialLedgerId={ledgerId} lockContext orderLabel={orderLabel} ledgerLabel={ledgerLabel}
      onClose={() => setOpen(false)} onSuccess={() => { setOpen(false); setSaved(true); }} />}
  </>;
}

export function ReverseMatchAction({ match }: { match: PaymentMatchDetail }) {
  const [snapshot, setSnapshot] = useState<PaymentMatchDetail | null>(null);
  const [saved, setSaved] = useState(false);
  if (match.status !== "SETTLED" && !snapshot && !saved) return null;
  return <><Button variant="danger" disabled={saved || match.status !== "SETTLED"} onClick={() => setSnapshot(match)}>撤销错误关联</Button>{saved && <span className="detail-feedback" role="status">关联已撤销，订单状态已重新计算。</span>}
    {snapshot && <ReasonDialog title="撤销错误关联" description="这会撤销账务关联并更新订单付款状态，不会从支付宝转出资金。仅在确认关联错误时执行。" action="确认撤销关联" onClose={() => setSnapshot(null)}
      execute={(reason, operationId) => result(api.reversePaymentSettlement({ path: { paymentMatchId: snapshot.payment_match_id }, body: { reason, financial_operation_id: operationId } }))}
      onSuccess={() => { setSnapshot(null); setSaved(true); void refreshOperationalData(); }}>
      <DetailFields items={[["订单", snapshot.order.product_name], ["商户订单号", snapshot.order.merchant_order_no], ["流水金额", money(snapshot.ledger_entry.amount_cents)], ["支付宝订单号", snapshot.ledger_entry.provider_order_no]]} />
    </ReasonDialog>}
  </>;
}
