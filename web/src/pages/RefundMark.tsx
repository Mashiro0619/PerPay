import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { ApiError, api, refreshOperationalData, result, type AdminOrderDetail } from "../api/client";
import { Badge, Button, Dialog, ErrorNotice, Field } from "../components/ui";
import { DetailFields } from "../components/detail/DetailPrimitives";
import { dateTime } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

const disclaimer = "仅记录管理员已在外部完成退款，PerPay 不执行转账，也未验证退款。";

export function RefundMarkPanel({ order }: { order: AdminOrderDetail }) {
  const [draft, setDraft] = useState<{ version: number; marked: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const mark = order.refund_mark;
  const eligible = ["CONFIRMED", "DISPUTED"].includes(order.payment.status) && (order.received_amount_cents ?? 0) > 0;
  const hasHistory = order.refund_mark_history.length > 0;
  if (!eligible && !mark.marked && !hasHistory) return null;
  return <section className="detail-refund" aria-label="管理员退款标记">
    {(mark.marked || hasHistory) && <><div className="detail-record-heading"><h3>管理员退款标记</h3><Badge value={mark.marked ? "ADMIN_REFUND_MARK" : "NONE"} label={mark.marked ? "已退款（管理员标记）" : "标记已撤销"} /></div>
      <p className="detail-muted">仅为外部退款的管理员声明</p>
      <DetailFields items={[["操作人", mark.updated_by], ["操作时间", dateTime(mark.updated_at)], ...(mark.note ? [["标记备注", mark.note] as const] : [])]} /></>}
    {message && <p className="detail-feedback" role="status">{message}</p>}
    <div className="detail-actions"><Button disabled={!mark.marked && !eligible} onClick={() => setDraft({ version: mark.version, marked: !mark.marked })}>{mark.marked ? "撤销退款标记" : "标记已退款"}</Button></div>
    {!mark.marked && !eligible && <p className="detail-muted">当前订单不可重新标记；原修改记录仍保留。</p>}
    {hasHistory && <details className="detail-disclosure"><summary>查看标记修改历史</summary><ol className="detail-event-list">{order.refund_mark_history.map((event) => <li key={event.operation_id}>
      <strong>{event.marked ? "标记已退款" : "撤销退款标记"}</strong><time>{dateTime(event.updated_at)}</time><p>操作人 {event.updated_by}</p>{event.note && <p className="preserve-whitespace">{event.note}</p>}
    </li>)}</ol></details>}
    {draft && <RefundMarkDialog orderId={order.order_id} version={draft.version} marked={draft.marked} onClose={() => setDraft(null)} onSuccess={() => { setMessage(draft.marked ? "已保存管理员退款标记，订单资金状态未改变。" : "已撤销管理员退款标记，订单资金状态未改变。"); setDraft(null); void refreshOperationalData(); }} />}
  </section>;
}

export function RefundMarkDialog({ orderId, version, marked, onClose, onSuccess }: {
  orderId: string; version: number; marked: boolean; onClose: () => void; onSuccess: () => void;
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
      <p>{marked ? "请仅在你已自行完成外部退款后保存。此标记不会修改付款状态、实收金额或历史退款记录，也不会通知业务网站。" : "仅撤销管理员声明，不撤销真实退款，不修改任何资金记录，也不会通知业务网站。"}</p>
      <Field label="备注（可选）" hint={count + "/500 字；仅管理端可见。"} error={count > 500 ? "备注最多 500 字。" : undefined}><textarea name="refund-mark-note" rows={3} maxLength={1000} disabled={save.isPending} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <ErrorNotice error={save.error} />
      <div className="form-actions"><Button disabled={save.isPending} onClick={onClose}>取消</Button>{stale
        ? <Button onClick={() => { onClose(); void refreshOperationalData(); }}>关闭并刷新订单</Button>
        : <Button type="submit" variant="primary" pending={save.isPending} disabled={count > 500}>{marked ? "确认标记已退款" : "确认撤销标记"}</Button>}</div>
    </form>
  </Dialog>;
}
