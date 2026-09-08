import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, refreshOperationalData, result } from "../api/client";
import { Badge, Button, Details, Dialog, ErrorNotice, Field, Notice } from "../components/ui";
import { dateTime, money, resourceIdPattern } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

export function FinancialDialog({ mode, initialOrderId = "", initialLedgerId = "", onClose, onSuccess }: {
  mode: "settlement" | "refund"; initialOrderId?: string; initialLedgerId?: string; onClose: () => void; onSuccess: () => void;
}) {
  const [orderId, setOrderId] = useState(initialOrderId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  const key = useOperationKey();
  const preview = useMutation({ mutationFn: async () => {
    const [order, ledger] = await Promise.all([
      result(api.getAdministratorOrder({ path: { orderId: orderId.trim() } })),
      result(api.getReconciliationLedgerEntry({ path: { ledgerEntryId: ledgerId.trim() } })),
    ]);
    return { order: order.data, ledger: ledger.data };
  } });
  const save = useMutation({ mutationFn: async () => {
    if (!preview.data) throw new Error("请先读取并核对订单与流水证据。");
    const body = { order_id: preview.data.order.order_id, ledger_entry_id: preview.data.ledger.ledger_entry_id, reason: reason.trim() };
    const request = { body: { ...body, financial_operation_id: key({ mode, ...body }) } };
    if (mode === "refund") await result(api.recordCollectedRefundDebit(request));
    else await result(api.createManualSettlement(request));
  }, onSuccess: () => { void refreshOperationalData(); onSuccess(); } });
  const busy = preview.isPending || save.isPending;
  const expectedDirection = mode === "settlement" ? "CREDIT" : "DEBIT";
  const directionValid = preview.data?.ledger.direction === expectedDirection;
  function resetPreview() { preview.reset(); save.reset(); setAccepted(false); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview.data) { preview.mutate(); return; }
    if (directionValid && accepted && reason.trim()) save.mutate();
  }
  return <Dialog title={mode === "settlement" ? "人工关联收款" : "登记已发生退款"} description={mode === "settlement" ? "将已采集的一笔收入明确关联到订单。必须先核对订单及流水，不会自动推断你的决定。" : "仅登记已采集的退款支出流水，不会调用支付宝退款，也不会向付款人转账。"} onClose={onClose} busy={busy}>
    <form className="form-stack" onSubmit={submit}>
      <Field label="内部订单编号"><input name="order-id" required pattern={resourceIdPattern.source} value={orderId} disabled={busy} onChange={(event) => { setOrderId(event.target.value); resetPreview(); }} placeholder="UUID 格式的订单编号" /></Field>
      <Field label={mode === "settlement" ? "收入流水编号" : "退款支出流水编号"}><input name="ledger-entry-id" required pattern={resourceIdPattern.source} value={ledgerId} disabled={busy} onChange={(event) => { setLedgerId(event.target.value); resetPreview(); }} placeholder="UUID 格式的账本流水编号" /></Field>
      <ErrorNotice error={preview.error} />
      {preview.data && <>
        <div className="evidence-preview"><h3>请核对这笔关联</h3><Details items={[["商品", preview.data.order.product_name], ["商户订单号", preview.data.order.merchant_order_no], ["订单应付", money(preview.data.order.payable_amount_cents)], ["付款状态", <Badge value={preview.data.order.payment.status} />], ["流水金额", money(preview.data.ledger.amount_cents)], ["收支方向", <Badge value={preview.data.ledger.direction} />], ["支付宝流水号", preview.data.ledger.provider_order_no], ["流水时间", dateTime(preview.data.ledger.occurred_at)]]} /></div>
        {!directionValid && <Notice tone="danger">流水方向不匹配。{mode === "settlement" ? "收款关联只能选择收入流水。" : "退款登记只能选择支出流水。"}请更换流水编号。</Notice>}
        {mode === "settlement" && preview.data.order.payable_amount_cents !== preview.data.ledger.amount_cents && <Notice tone="warning">流水金额与订单应付金额不同。请再次核实，且在理由中说明差异。</Notice>}
        <Field label="操作理由" hint="请填写核对依据，不要在这里粘贴任何私钥或密码。"><textarea name="reason" required maxLength={500} rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></Field>
        <label className="checkbox-field"><input type="checkbox" required checked={accepted} disabled={busy} onChange={(event) => setAccepted(event.target.checked)} /><span>{mode === "settlement" ? "已核实订单和这笔收入确实属于同一交易。" : "已核实退款已实际发生，且这笔支出属于此订单。"}</span></label>
        <ErrorNotice error={save.error} />
      </>}
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant={preview.data ? "danger" : "primary"} pending={busy} disabled={!!preview.data && (!directionValid || !accepted || !reason.trim())}>{!preview.data ? "读取并核对证据" : mode === "settlement" ? "确认关联收款" : "确认登记退款"}</Button></div>
    </form>
  </Dialog>;
}
