import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { ApiError, api, refreshOperationalData, result, type AdminOrderDetail } from "../api/client";
import { Badge, Button, Dialog, ErrorNotice, Field } from "../components/ui";
import { RecordTools } from "../components/detail/RecordTools";
import { SuccessMessage, useFeedback } from "../components/Feedback";
import { DetailFields } from "../components/detail/DetailPrimitives";
import { dateTime, money } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

const disclaimer = "仅记录外部已完成的退款。PerPay 不执行转账，也未验证退款。";

export function RefundMarkPanel({ order, includeOrderTools = false }: { order: AdminOrderDetail; includeOrderTools?: boolean }) {
  const [draft, setDraft] = useState<{ version: number; marked: boolean } | null>(null);
  const [message, setMessage] = useFeedback();
  const mark = order.refund_mark;
  const eligible = ["CONFIRMED", "DISPUTED"].includes(order.payment.status) && (order.received_amount_cents ?? 0) > 0;
  const hasHistory = order.refund_mark_history.length > 0;
  if (!eligible && !mark.marked && !hasHistory && !includeOrderTools) return null;
  return <div className="order-tools">{(mark.marked || hasHistory) && <section className="detail-refund" aria-label="管理员退款标记">
    <div className="detail-record-heading"><h3>管理员退款标记</h3><Badge value={mark.marked ? "ADMIN_REFUND_MARK" : "NONE"} label={mark.marked ? "已退款（管理员标记）" : "标记已撤销"} /></div>
      <DetailFields items={[["操作人", mark.updated_by], ["操作时间", dateTime(mark.updated_at)], ...(mark.note ? [["标记备注", mark.note] as const] : []) ]} />

    {!mark.marked && !eligible && <p className="detail-muted">当前订单不可重新标记；原修改记录仍保留。</p>}
    {hasHistory && <details className="detail-disclosure"><summary>查看标记修改历史</summary><ol className="detail-event-list">{order.refund_mark_history.map((event) => <li key={event.operation_id}>
      <strong>{event.marked ? "标记已退款" : "撤销退款标记"}</strong><time>{dateTime(event.updated_at)}</time><p>操作人 {event.updated_by}</p>{event.note && <p className="preserve-whitespace">{event.note}</p>}
    </li>)}</ol></details>}
    </section>}
    <SuccessMessage message={message} />
    <RecordTools label="订单操作" data={order} identifiers={[["内部订单编号", order.order_id]]} actions={mark.marked || eligible ? [{ label: mark.marked ? "撤销退款标记" : "标记已退款", onSelect: () => setDraft({ version: mark.version, marked: !mark.marked }) }] : []} />
    {draft && <RefundMarkDialog order={order} orderId={order.order_id} version={draft.version} marked={draft.marked} onClose={() => setDraft(null)} onSuccess={() => { setMessage(draft.marked ? "退款标记已保存" : "退款标记已撤销"); setDraft(null); void refreshOperationalData(); }} />}
  </div>;
}

export function RefundMarkDialog({ order, orderId, version, marked, onClose, onSuccess }: {
  order?: AdminOrderDetail; orderId: string; version: number; marked: boolean; onClose: () => void; onSuccess: () => void;
}) {
  const [note, setNote] = useState("");
  const key = useOperationKey();
  const count = Array.from(note).length;
  const save = useMutation({ mutationFn: () => {
    const input = { version, marked, ...(note.trim() ? { note: note.trim() } : {}) };
    return result(api.setAdministratorRefundMark({ path: { orderId }, body: { ...input, operation_id: key({ orderId, ...input }) } }));
  }, onSuccess });
  const stale = save.error instanceof ApiError && save.error.code === "refund_mark_version_conflict";
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (count <= 500 && !stale && !save.isPending) save.mutate(); }
  return <Dialog title={marked ? "标记已退款" : "撤销退款标记"} description={disclaimer} onClose={onClose} busy={save.isPending}>
    <form className="form-stack" onSubmit={submit}>
      {order && <div className="dialog-object"><strong>{order.product_name}</strong><span>实收 {money(order.received_amount_cents)}</span><span className="field-hint">商户订单号：{order.merchant_order_no}</span></div>}
      <p className="field-hint">{marked ? "不改变订单资金状态，也不会通知业务网站。" : "只撤销标记，不改变实际退款或订单资金。"}</p>
      <Field label="备注（可选）" hint={count + "/500 · 仅管理员可见"} error={count > 500 ? "备注最多 500 字。" : undefined}><textarea name="refund-mark-note" rows={3} maxLength={1000} disabled={save.isPending} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <ErrorNotice error={save.error} />
      <div className="form-actions"><Button disabled={save.isPending} onClick={onClose}>取消</Button>{stale
        ? <Button onClick={() => { onClose(); void refreshOperationalData(); }}>关闭并刷新订单</Button>
        : <Button type="submit" variant="primary" pending={save.isPending} disabled={count > 500}>{marked ? "确认标记已退款" : "确认撤销标记"}</Button>}</div>
    </form>
  </Dialog>;
}
