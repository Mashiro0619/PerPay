import { useRef, useState } from "react";
import { useWorkspaceApi } from "@/workspace";
import { Link } from "@/navigation";
import { result, type LedgerConflictDetail } from "@/api/client";
import { refreshFinancialRecords } from "@/lib/record-refresh";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { useSuccessToast } from "@/components/Feedback";
import { OverlaySummary } from "@/components/overlay-actions";
import { ReasonDialog } from "@/components/ReasonDialog";
import { ActionBar } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { RecordTime, Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { Button } from "@/components/ui/button";
import { ConflictComparison, conflictAttentionCount } from "./ConflictComparison";

const link = "text-[0.8125rem] leading-5 underline underline-offset-4";

const explanations: Record<string, string> = {
  DUPLICATE_EXTERNAL_ID: "同一支付宝流水号对应不同交易内容，已有流水未被覆盖。",
  RAW_PAGE_VARIANT: "同一查账窗口返回了不同内容。",
  MISSING_EXTERNAL_ID: "缺少支付宝流水号，已隔离，不参与收款分配。",
  INVALID_AMOUNT: "交易金额格式无效，已隔离，不计入收款。",
  INVALID_TIMESTAMP: "交易时间无效，已隔离，不参与订单时间窗口匹配。",
  INVALID_DIRECTION: "收支方向未知，已隔离，不参与自动收款匹配。",
  INVALID_SHAPE: "原始记录结构不符合账本要求，已被隔离。",
};

function conflictStateLabel(conflict: LedgerConflictDetail["conflict"]) {
  if (conflict.status === "OPEN") return conflict.reminder_ignored ? "未处理 · 已忽略" : "待处理";
  return conflict.status === "IGNORED" ? "已隔离" : "已处理";
}

/** A ledger conflict: what differed or failed validation, the poll summary, and how it was resolved. */
export function ConflictRecord({ detail }: { detail: LedgerConflictDetail }) {
  const api = useWorkspaceApi();
  const [confirm, setConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const finalFocus = useRef<HTMLElement | null>(null);
  const setMessage = useSuccessToast();
  const conflict = detail.conflict;
  const existing = detail.existing_ledger_entry;
  const operation = detail.resolution_operation;
  const action =
    conflict.conflict_type === "DUPLICATE_EXTERNAL_ID"
      ? "KEEP_EXISTING"
      : "ACKNOWLEDGE_ISOLATED";
  const hasComparison = !!detail.incoming_event || !!existing;
  const attention = conflictAttentionCount(detail);
  const canResolve = conflict.status === "OPEN" && conflict.conflict_type !== "RAW_PAGE_VARIANT";
  const actor = operation ? (operation.actor_type === "SYSTEM" ? "系统" : (operation.actor_id ?? "未记录")) : null;
  const history: TimelineEntry[] = [
    ...(conflict.resolved_at || operation ? [{
      id: "resolved",
      title: operation ? label(operation.action) : "冲突已处理",
      time: operation?.created_at ?? conflict.resolved_at!,
      tone: "success" as const,
      ...(operation ? { body: <p className="text-foreground">{actor}：{operation.reason}</p> } : {}),
    }] : []),
    { id: "created", title: "发现冲突", time: conflict.created_at },
  ];

  return <>
    <OverlaySummary>
      <RecordSummary label="冲突概况"
        status={<StatusBadge value={conflict.reminder_ignored ? "NONE" : conflict.status} label={conflictStateLabel(conflict)} />}
        meta={[explanations[conflict.conflict_type]]}
        nav={[
          ...(hasComparison ? [{ id: "comparison", label: "交易对照", ...(attention ? { count: attention } : {}) }] : []),
          ...(detail.raw_page ? [{ id: "collection", label: "查账摘要" }] : []),
          { id: "history", label: "处理记录" },
        ]} />
    </OverlaySummary>
    <Sections label="账本冲突详情内容">
      {hasComparison && <Section id="comparison" title="交易对照" {...(attention ? { count: attention } : {})}
        actions={existing && <Link to={"/reconciliation/ledger/" + existing.ledger_entry_id} className={link}>查看已有流水<span aria-hidden="true"> ›</span></Link>}>
        <ConflictComparison detail={detail} />
      </Section>}
      {detail.raw_page && <Section id="collection" title="查账摘要">
        <FieldList items={[
          { label: "查账时间", kind: "time", value: <RecordTime value={detail.raw_page.received_at} /> },
          { label: "支付宝响应验签", value: detail.raw_page.signature_verified ? "验签通过" : "验签未通过" },
          { label: "查账窗口", value: detail.raw_page.window_start + " 至 " + detail.raw_page.window_end },
          { label: "HTTP 响应", value: String(detail.raw_page.http_status) },
        ]} />
      </Section>}
      <Section id="history" title="处理记录">
        <Timeline label="处理记录" entries={history} />
      </Section>
    </Sections>
    <ActionBar menuLabel="更多操作，冲突记录操作"
      primary={canResolve && <Button className="h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5" disabled={completed}
        onClick={event => { finalFocus.current = event.currentTarget; setConfirm(true); }}>{label(action)}</Button>}
      technical={[{ title: "冲突记录技术信息", data: detail, identifiers: [
        ["冲突编号", conflict.conflict_id],
        ["关联内部流水编号（PerPay）", existing?.ledger_entry_id ?? null],
        ["原始查账页编号", conflict.raw_page_id],
        ["原始事件编号", conflict.raw_event_id],
      ] }]} />
    {confirm && (
      <ReasonDialog
        title={label(action)}
        description={
          action === "KEEP_EXISTING"
            ? "保留已有流水，拒绝本次冲突记录。"
            : "保留隔离记录，不计入收款。"
        }
        action="确认处理冲突"
        onClose={() => setConfirm(false)}
        finalFocus={() => finalFocus.current}
        execute={(reason, operationId, signal) =>
          result(
            api.resolveLedgerConflict({
              signal,
              path: { conflictId: conflict.conflict_id },
              body: { reason, action, conflict_operation_id: operationId },
            }),
          )
        }
        onSuccess={() => {
          // The action button disappears after the conflict refreshes.
          // Move focus to the stable page content before closing the dialog.
          finalFocus.current = document.getElementById("main-content");
          setConfirm(false);
          setCompleted(true);
          setMessage("处理已保存");
          void refreshFinancialRecords();
        }}
      >
        <p className="text-sm break-all">
          {label(conflict.conflict_type)} ·{" "}
          {conflict.external_event_id ?? "无支付宝流水号"}
        </p>
      </ReasonDialog>
    )}
  </>;
}
