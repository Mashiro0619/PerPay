import { useState } from "react";
import { result, type AdminOrderDetail } from "@/api/client";
import { useWorkspaceApi } from "@/workspace";
import { useOperationKey } from "@/lib/idempotency";
import { useFixedOperation } from "@/lib/fixed-operation";
import { refreshFinancialRecords } from "@/lib/record-refresh";
import { useSuccessToast } from "@/components/Feedback";
import type { RecordAction } from "./RecordTools";

/** What a disputed order still needs: who may act on it, and on which of its records. */
export function disputeState(order: AdminOrderDetail) {
  const refunded = order.refund_mark.marked || order.refund.status !== "NONE";
  /** Open reversal reminders; once a refund is on record they can be dismissed one by one. */
  const dismissible = new Set(refunded ? order.reconciliation.exceptions.filter(exception => exception.status === "OPEN" &&
    !exception.reminder_ignored && exception.exception_type === "RECONCILIATION_CONFLICT" && exception.details.reason === "settlement_reversed")
    .map(exception => exception.exception_id) : []);
  /** Reversed associations whose ledger entry is free again, one per entry, for moving it to the right order. */
  const released = new Set(refunded ? [] : [...new Map(order.reconciliation.matches.filter(match => match.status === "REVERSED" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(match.ledger_entry.state)).map(match => [match.ledger_entry_id, match.payment_match_id])).values()]);
  return {
    refunded,
    dismissible,
    released,
    guidance: refunded
      ? "已登记退款。核对完成后可忽略本次争议提醒，处理记录保留在订单历史中。"
      : "核对付款人、交易凭证和金额；确认属于本订单后重新关联收款。暂不能确认时保留争议，补齐凭证后继续。",
  };
}

/** Dismisses one dispute reminder by its exact exception; the action reports its own progress. */
export function useIgnoreDisputeReminder(exceptionId: string) {
  const api = useWorkspaceApi();
  const key = useOperationKey();
  const message = useSuccessToast();
  const [saved, setSaved] = useState(false);
  const save = useFixedOperation({
    execute: (body: { operation_id: string; type: "FINANCIAL_EXCEPTION"; resource_id: string }, signal) =>
      result(api.ignoreAllAdministratorWorkItems({ body, signal })),
    onSuccess: () => { setSaved(true); message("本条争议提醒已忽略"); void refreshFinancialRecords(); },
  });
  const action: RecordAction = {
    label: saved ? "已忽略" : save.recovery ? "重试忽略此提醒" : "忽略此提醒",
    disabled: save.isPending || saved,
    onSelect: () => {
      if (save.recovery) save.submit(save.recovery);
      else save.submit({ operation_id: key(exceptionId), type: "FINANCIAL_EXCEPTION", resource_id: exceptionId });
    },
  };
  return { action, error: save.error };
}
