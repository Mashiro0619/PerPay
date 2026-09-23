import { useId, useState } from "react";
import {
  api,
  refreshOperationalData,
  result,
  type LedgerConflictDetail,
} from "@/api/client";
import { dateTime } from "@/lib/format";
import { ConflictComparison } from "./ConflictComparison";
import { label } from "@/lib/labels";
import { ReasonDialog } from "@/components/ReasonDialog";
import { StatusBadge } from "@/components/business-status";
import { SuccessMessage } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { DetailFields } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
const explanations: Record<string, string> = {
  DUPLICATE_EXTERNAL_ID: "同一外部流水号对应不同交易内容，已有流水未被覆盖。",
  RAW_PAGE_VARIANT: "同一采集窗口返回了不同内容。",
  MISSING_EXTERNAL_ID:
    "这笔记录缺少可识别的外部流水号，已被隔离，不能参与收款分配。",
  INVALID_AMOUNT:
    "流水金额格式无法安全解析，已被隔离；不会把无效金额计入收款。",
  INVALID_TIMESTAMP:
    "交易时间无法安全解析，已被隔离；不会用于订单时间窗口匹配。",
  INVALID_DIRECTION: "收支方向无法确认，已被隔离，不会用于自动收款匹配。",
  INVALID_SHAPE: "原始记录结构不符合账本要求，已被隔离。",
};

export function ConflictCard({ detail }: { detail: LedgerConflictDetail }) {
  const [confirm, setConfirm] = useState(false);
  const [completed, setCompleted] = useState(false);
  const conflict = detail.conflict;
  const existing = detail.existing_ledger_entry;
  const operation = detail.resolution_operation;
  const action =
    conflict.conflict_type === "DUPLICATE_EXTERNAL_ID"
      ? "KEEP_EXISTING"
      : "ACKNOWLEDGE_ISOLATED";
  const collectionId = useId();
  return (
    <Card aria-label="账本冲突证据">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {label(conflict.conflict_type)}
        </CardTitle>
        <CardDescription>
          {explanations[conflict.conflict_type]}
        </CardDescription>
        <CardAction>
          <StatusBadge
            value={conflict.reminder_ignored ? "NONE" : conflict.status}
            label={
              conflict.status === "OPEN"
                ? conflict.reminder_ignored
                  ? "未处理 · 已忽略"
                  : "待处理"
                : conflict.status === "IGNORED"
                  ? "已隔离"
                  : "已处理"
            }
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <DetailFields
          items={[
            ["发现时间", dateTime(conflict.created_at)],
            ...(conflict.resolved_at
              ? [["处理时间", dateTime(conflict.resolved_at)] as const]
              : []),
          ]}
        />
        <ConflictComparison detail={detail} />
        {detail.raw_page && (
          <section
            className="flex min-w-0 flex-col gap-3"
            aria-labelledby={collectionId}
          >
            <h3 id={collectionId} className="text-sm font-medium">
              采集摘要
            </h3>
            <DetailFields
              wide={["采集窗口"]}
              items={[
                ["采集时间", dateTime(detail.raw_page.received_at)],
                [
                  "接口验签",
                  detail.raw_page.signature_verified ? "已通过" : "未通过",
                ],
                [
                  "采集窗口",
                  detail.raw_page.window_start +
                    " 至 " +
                    detail.raw_page.window_end,
                ],
                ["HTTP 响应", detail.raw_page.http_status],
              ]}
            />
          </section>
        )}
        {operation && (
          <DetailFields
            wide={["处理理由"]}
            items={[
              ["处理方式", label(operation.action)],
              [
                "操作人",
                operation.actor_type === "SYSTEM"
                  ? "系统"
                  : (operation.actor_id ?? "未记录"),
              ],
              ["处理理由", operation.reason],
            ]}
          />
        )}
        <SuccessMessage message={completed ? "处理已保存" : ""} />
        <RecordTools
          label="冲突记录操作"
          data={detail}
          identifiers={[["冲突编号", conflict.conflict_id]]}
          actions={
            existing
              ? [
                  {
                    label: "查看已有流水",
                    to: "/reconciliation/ledger/" + existing.ledger_entry_id,
                  },
                ]
              : []
          }
        />
      </CardContent>
      {conflict.status === "OPEN" &&
        conflict.conflict_type !== "RAW_PAGE_VARIANT" && (
          <CardFooter>
            <Button disabled={completed} onClick={() => setConfirm(true)}>
              {label(action)}
            </Button>
          </CardFooter>
        )}
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
            setConfirm(false);
            setCompleted(true);
            void refreshOperationalData();
          }}
        >
          <p className="text-sm break-all">
            {label(conflict.conflict_type)} ·{" "}
            {conflict.external_event_id ?? "无外部流水号"}
          </p>
        </ReasonDialog>
      )}
    </Card>
  );
}
