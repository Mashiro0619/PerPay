import { useState } from "react";
import { api, refreshOperationalData, result, type PaymentMatchDetail } from "../../api/client";
import { FinancialDialog } from "../../pages/FinancialDialog";
import { ReasonDialog } from "../ReasonDialog";
import { SuccessMessage } from "../Feedback";
import { Button } from "../ui";
import { money } from "../../lib/format";
import { DetailFields } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";

export function AssociateIncomeAction({ orderId = "", ledgerId = "", orderLabel, ledgerLabel }: { orderId?: string; ledgerId?: string; orderLabel?: string; ledgerLabel?: string }) {
  const [open, setOpen] = useState(false); const [saved, setSaved] = useState(false);
  return <><Button disabled={saved} onClick={() => setOpen(true)}>人工关联收款</Button><SuccessMessage message={saved ? "关联已保存" : ""} />
    {open && <FinancialDialog initialOrderId={orderId} initialLedgerId={ledgerId} lockContext orderLabel={orderLabel} ledgerLabel={ledgerLabel} onClose={() => setOpen(false)} onSuccess={() => { setOpen(false); setSaved(true); }} />}
  </>;
}
export function ReverseMatchAction({ match, embedded = false }: { match: PaymentMatchDetail; embedded?: boolean }) {
  const [snapshot, setSnapshot] = useState<PaymentMatchDetail | null>(null); const [saved, setSaved] = useState(false);
  return <><SuccessMessage message={saved ? "关联已撤销" : ""} />
    <RecordTools label="收款记录操作" data={match} identifiers={[["关联编号", match.payment_match_id], ["流水编号", match.ledger_entry_id], ["候选编号", match.candidate_id]]}
      to={embedded ? "/reconciliation/matches/" + match.payment_match_id : undefined}
      actions={match.status === "SETTLED" ? [{ label: "撤销错误关联", danger: true, disabled: saved, onSelect: () => setSnapshot(match) }] : []} />
    {snapshot && <ReasonDialog title="撤销收款关联？" description="订单将进入争议状态。仅撤销账务关联，不会转出资金。" action="确认撤销关联" onClose={() => setSnapshot(null)}
      execute={(reason, operationId) => result(api.reversePaymentSettlement({ path: { paymentMatchId: snapshot.payment_match_id }, body: { reason, financial_operation_id: operationId } }))}
      onSuccess={() => { setSnapshot(null); setSaved(true); void refreshOperationalData(); }}>
      <DetailFields items={[["商品", snapshot.order.product_name], ["商户订单号", snapshot.order.merchant_order_no], ["流水金额", money(snapshot.ledger_entry.amount_cents)], ["支付宝订单号", snapshot.ledger_entry.provider_order_no]]} />
    </ReasonDialog>}
  </>;
}
