import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";

import { ApiError, api, refreshOperationalData, result, type AdminOrderDetail } from "../api/client";
import { Badge, Button, Details, Dialog, ErrorNotice, Field, Notice, Panel } from "../components/ui";
import { dateTime } from "../lib/format";
import { useOperationKey } from "../lib/idempotency";

const disclaimer = "仅记录管理员已在外部完成退款，PerPay 不执行转账，也未验证退款。";

export function RefundMarkPanel({ order }: { order: AdminOrderDetail }) {
  const [draft, setDraft] = useState<{ version: number; marked: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const mark = order.refund_mark;
  const eligible = ["CONFIRMED", "DISPUTED"].includes(order.payment.status) && (order.received_amount_cents ?? 0) > 0;
  if (!eligible && !mark.marked && order.refund_mark_history.length === 0) return null;
  return <Panel title="管理员退款标记" className="content-panel" action={<Badge value={mark.marked ? "ADMIN_REFUND_MARK" : "NONE"} label={mark.marked ? "已退款（管理员标记）" : "未标记"} />}>
    {message && <Notice tone="success">{message}</Notice>}
    <Notice>{disclaimer}</Notice>
    <Details items={[["最后操作人", mark.updated_by], ["最后操作时间", dateTime(mark.updated_at)], ["标记备注", mark.note ? <span className="preserve-whitespace">{mark.note}</span> : "无备注"]]} />
    <div className="form-actions"><Button disabled={!mark.marked && !eligible} onClick={() => setDraft({ version: mark.version, marked: !mark.marked })}>{mark.marked ? "撤销退款标记" : "标记已退款"}</Button></div>
    {!mark.marked && !eligible && <p className="muted">只有存在实收金额的已确认或争议订单可以标记。</p>}
    {order.refund_mark_history.length > 0 && <details><summary>查看标记修改历史</summary><ol className="timeline">{order.refund_mark_history.map((event) => <li key={event.operation_id}><span className="timeline-node" /><div>
      <strong>{event.marked ? "标记已退款" : "撤销退款标记"}</strong><time>{dateTime(event.updated_at)}</time><p>操作人 {event.updated_by}</p>{event.note && <p className="preserve-whitespace">{event.note}</p>}
    </div></li>)}</ol></details>}
    {draft && <RefundMarkDialog orderId={order.order_id} version={draft.version} marked={draft.marked} onClose={() => setDraft(null)} onSuccess={() => { setMessage(draft.marked ? "已保存管理员退款标记，订单资金状态未改变。" : "已撤销管理员退款标记，订单资金状态未改变。"); setDraft(null); void refreshOperationalData(); }} />}
  </Panel>;
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
