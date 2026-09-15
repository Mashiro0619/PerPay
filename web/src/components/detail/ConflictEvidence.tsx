import { useState } from "react";
import { api, refreshOperationalData, result, type LedgerConflictDetail } from "../../api/client";
import { Badge, Button } from "../ui";
import { ReasonDialog } from "../ReasonDialog";
import { dateTime } from "../../lib/format";
import { conflictComparison } from "../../lib/conflict-comparison";
import { label } from "../../lib/labels";
import { DetailFields } from "./DetailPrimitives";

import { SuccessMessage } from "../Feedback";
import { RecordTools } from "./RecordTools";

const explanations: Record<string, string> = {
  DUPLICATE_EXTERNAL_ID: "同一个外部流水号出现了不同交易内容，已有流水未被覆盖。请对照下面的差异。",
  RAW_PAGE_VARIANT: "同一采集窗口返回了不同原始页，采集流程会继续核实，不能仅关闭提醒就视为已确认。",
  MISSING_EXTERNAL_ID: "这笔记录缺少可识别的外部流水号，已被隔离，不能参与收款分配。",
  INVALID_AMOUNT: "流水金额格式无法安全解析，已被隔离；不会把无效金额计入收款。",
  INVALID_TIMESTAMP: "交易时间无法安全解析，已被隔离；不会用于订单时间窗口匹配。",
  INVALID_DIRECTION: "收支方向无法确认，已被隔离，不会用于自动收款匹配。",
  INVALID_SHAPE: "原始记录结构不符合账本要求，已被隔离。",
};
export function ConflictCard({ detail }: { detail: LedgerConflictDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const conflict = detail.conflict;
  const existing = detail.existing_ledger_entry;
  const operation = detail.resolution_operation;
  const action = conflict.conflict_type === "DUPLICATE_EXTERNAL_ID" ? "KEEP_EXISTING" : "ACKNOWLEDGE_ISOLATED";
  const rows = conflictComparison(detail);
  return <article className="detail-record" aria-label="账本冲突证据">
    <div className="detail-record-heading"><h3>{label(conflict.conflict_type)}</h3><Badge value={conflict.reminder_ignored ? "NONE" : conflict.status} label={conflict.status === "OPEN" ? conflict.reminder_ignored ? "已忽略提醒" : "待处理" : conflict.status === "IGNORED" ? "已隔离" : "已处理"} /></div>
    <p className="detail-explanation">{explanations[conflict.conflict_type]}</p>
    {conflict.reminder_ignored && conflict.status === "OPEN" && <p className="detail-caution">提醒已忽略，冲突仍有效。</p>}
    <DetailFields items={[["发现时间", dateTime(conflict.created_at)], ...(conflict.resolved_at ? [["处理时间", dateTime(conflict.resolved_at)] as const] : [])]} />
    {rows.length > 0 && <div className="detail-comparison"><table><caption>交易内容对照 · 差异或无效字段已标出</caption><thead><tr><th>字段</th><th>传入记录</th><th>已有流水</th></tr></thead><tbody>{rows.map(row => <tr key={row.name} data-different={row.differs || undefined}><th scope="row">{row.name}{row.differs && <span className="detail-difference">{existing ? "不同" : "异常"}</span>}</th><td>{row.incoming ?? "未提供"}</td><td>{row.existing ?? "无已有记录"}</td></tr>)}</tbody></table></div>}
    {detail.raw_page && <DetailFields items={[["采集时间", dateTime(detail.raw_page.received_at)], ["接口验签", detail.raw_page.signature_verified ? "已通过" : "未通过"], ["采集窗口", detail.raw_page.window_start + " 至 " + detail.raw_page.window_end], ["HTTP 响应", detail.raw_page.http_status]]} />}
    {operation && <DetailFields items={[["处理方式", label(operation.action)], ["操作人", operation.actor_type === "SYSTEM" ? "系统" : operation.actor_id ?? "未记录"], ["处理理由", operation.reason]]} />}
    <div className="detail-record-footer"><div className="detail-actions">{conflict.status === "OPEN" && conflict.conflict_type !== "RAW_PAGE_VARIANT" && <Button variant="danger" disabled={completed} onClick={() => setConfirm(true)}>{label(action)}</Button>}<SuccessMessage message={completed ? "处理已保存" : ""} /></div></div>
    <RecordTools label="冲突记录操作" data={detail} identifiers={[["冲突编号", conflict.conflict_id]]} actions={existing ? [{ label: "查看已有流水", to: "/reconciliation/ledger/" + existing.ledger_entry_id }] : []} />
    {confirm && <ReasonDialog title={label(action)} description={action === "KEEP_EXISTING" ? "保留已有流水，拒绝本次冲突记录。" : "保留隔离记录，不计入收款。"} action="确认处理冲突" onClose={() => setConfirm(false)}
      execute={(reason, operationId) => result(api.resolveLedgerConflict({ path: { conflictId: conflict.conflict_id }, body: { reason, action, conflict_operation_id: operationId } }))}
      onSuccess={() => { setConfirm(false); setCompleted(true); void refreshOperationalData(); }}><p>{label(conflict.conflict_type)} · {conflict.external_event_id ?? "无外部流水号"}</p></ReasonDialog>}
  </article>;
}
