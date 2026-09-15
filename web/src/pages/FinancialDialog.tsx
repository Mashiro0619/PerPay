import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { api, refreshOperationalData, result } from "../api/client";
import { Badge, Button, Details, Dialog, ErrorNotice, Field, Notice } from "../components/ui";
import { dateTime, money, resourceIdPattern } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

export function FinancialDialog({ initialOrderId = "", initialLedgerId = "", lockContext = false, orderLabel, ledgerLabel, onClose, onSuccess }: {
  initialOrderId?: string; initialLedgerId?: string; lockContext?: boolean; orderLabel?: string | undefined; ledgerLabel?: string | undefined; onClose: () => void; onSuccess: () => void;
}) {
  const [orderId, setOrderId] = useState(initialOrderId);
  const [ledgerId, setLedgerId] = useState(initialLedgerId);
  const [reason, setReason] = useState("");
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
    await result(api.createManualSettlement({ body: { ...body, financial_operation_id: key(body) } }));
  }, onSuccess: () => { void refreshOperationalData(); onSuccess(); } });
  const automaticPreview = useRef(false);
  useEffect(() => {
    if (lockContext && initialOrderId && initialLedgerId && !automaticPreview.current) { automaticPreview.current = true; preview.mutate(); }
  }, [lockContext, initialOrderId, initialLedgerId, preview.mutate]);
  const busy = preview.isPending || save.isPending;
  const directionValid = preview.data?.ledger.direction === "CREDIT";
  const stateValid = preview.data?.order.payment.status === "UNPAID" && preview.data.order.payment.basis === "NONE" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(preview.data.ledger.state);
  function resetPreview() { preview.reset(); save.reset(); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!preview.data) { preview.mutate(); return; }
    if (directionValid && stateValid && reason.trim()) save.mutate();
  }
  return <Dialog title="人工关联收款" description="将这笔收入关联到订单并确认付款。请核对下方信息。" onClose={onClose} busy={busy}>
    <form className="form-stack" onSubmit={submit}>
      {lockContext && initialOrderId ? !preview.data && <p className="detail-context">关联订单：{orderLabel ?? "当前订单"}</p> : <Field label="内部订单编号"><input name="order-id" required pattern={resourceIdPattern.source} value={orderId} disabled={busy} onChange={(event) => { setOrderId(event.target.value); resetPreview(); }} placeholder="UUID 格式的订单编号" /></Field>}
      {lockContext && initialLedgerId ? !preview.data && <p className="detail-context">收入流水：{ledgerLabel ?? "当前流水"}</p> : <Field label="收入流水编号"><input name="ledger-entry-id" required pattern={resourceIdPattern.source} value={ledgerId} disabled={busy} onChange={(event) => { setLedgerId(event.target.value); resetPreview(); }} placeholder="UUID 格式的账本流水编号" /></Field>}
      <ErrorNotice error={preview.error} />
      {preview.data && <>
        <div className="evidence-preview"><h3>请核对这笔关联</h3><Details items={[["商品", preview.data.order.product_name], ["商户订单号", preview.data.order.merchant_order_no], ["订单应付", money(preview.data.order.payable_amount_cents)], ["付款状态", <Badge value={preview.data.order.payment.status} />], ["流水金额", money(preview.data.ledger.amount_cents)], ["收支方向", <Badge value={preview.data.ledger.direction} />], ["支付宝流水号", preview.data.ledger.provider_order_no], ["流水时间", dateTime(preview.data.ledger.occurred_at)]]} /></div>
        {!directionValid && <Notice tone="danger">只能关联收入流水，请更换流水编号。</Notice>}
        {!stateValid && <Notice tone="warning">订单或流水状态已变化，请关闭后刷新。</Notice>}
        {preview.data.order.payable_amount_cents !== preview.data.ledger.amount_cents && <Notice tone="warning">金额与订单应付不同，请在理由中说明。</Notice>}
        <Field label="操作理由" hint="简要说明关联依据。"><textarea name="reason" required maxLength={500} rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></Field>
        <ErrorNotice error={save.error} />
      </>}
      <div className="form-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button type="submit" variant={preview.data ? "danger" : "primary"} pending={busy} disabled={!!preview.data && (!directionValid || !stateValid || !reason.trim())}>{!preview.data ? "查看关联信息" : "确认关联收款"}</Button></div>
    </form>
  </Dialog>;
}
