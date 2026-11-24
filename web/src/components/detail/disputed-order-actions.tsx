import { useState } from "react";
import { ApiError, result, type AdminOrderDetail } from "@/api/client";
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { useOperationKey } from "@/lib/idempotency";
import { useFixedOperation } from "@/lib/fixed-operation";
import { refreshFinancialRecords } from "@/lib/record-refresh";
import { restoreMessages, restoreReminder } from "@/lib/reminder-restore";
import { useSuccessToast } from "@/components/Feedback";
import type { RecordAction } from "@/components/record/ActionMenu";

/** What a disputed order still needs: who may act on it, and on which of its records. */
export function disputeState(order: AdminOrderDetail) {
  const refundMarked = order.refund_mark.marked;
  const refunded = refundMarked || order.refund.status !== "NONE";
  const refundPhrase = refundMarked ? "已标记退款" : "已有退款记录";
  const openReversalExceptions = order.reconciliation.exceptions.filter(
    (exception) =>
      exception.status === "OPEN" &&
      exception.exception_type === "RECONCILIATION_CONFLICT" &&
      exception.details.reason === "settlement_reversed",
  );
  /** Open reversal reminders; once a refund is on record they can be dismissed one by one. */
  const dismissible = new Set(
    refunded
      ? openReversalExceptions
          .filter((exception) => !exception.reminder_ignored)
          .map((exception) => exception.exception_id)
      : [],
  );
  /** Open reversal reminders already ignored; allow restoring them from the order page. */
  const restorable = new Set(
    openReversalExceptions
      .filter((exception) => exception.reminder_ignored)
      .map((exception) => exception.exception_id),
  );
  const allDismissed =
    refunded && dismissible.size === 0 && restorable.size > 0;
  const baseGuidance = refunded
    ? allDismissed
      ? `${refundPhrase}，本次争议提醒已忽略，处理记录保留在订单历史中。`
      : `${refundPhrase}。核对完成后可忽略本次争议提醒，处理记录保留在订单历史中。`
    : "核对付款人、交易凭证和金额；确认属于本订单后重新关联收款。暂不能确认时保留争议，补齐凭证后继续。";
  /** Reversed associations whose ledger entry is free again, one per entry, for moving it to the right order. */
  const released = new Set(
    refunded
      ? []
      : [
          ...new Map(
            order.reconciliation.matches
              .filter(
                (match) =>
                  match.status === "REVERSED" &&
                  ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(
                    match.ledger_entry.state,
                  ),
              )
              .map((match) => [match.ledger_entry_id, match.payment_match_id]),
          ).values(),
        ],
  );
  return {
    refunded,
    dismissible,
    restorable,
    allDismissed,
    released,
    guidance: baseGuidance,
    notice(reversedOnly: boolean) {
      if (!reversedOnly) return baseGuidance;
      if (!refunded) {
        return "原收款关联已撤销，请核对付款人、交易凭证和金额；确认属于本订单后重新关联收款。暂不能确认时保留争议，补齐凭证后继续。";
      }
      return allDismissed
        ? `原收款关联已撤销，${refundPhrase}，本次争议提醒已忽略，处理记录保留在订单历史中。`
        : `原收款关联已撤销，${refundPhrase}。核对完成后可忽略本次争议提醒，处理记录保留在订单历史中。`;
    },
  };
}

/** Dismisses one dispute reminder by its exact exception; the action reports its own progress. */
export function useIgnoreDisputeReminder(exceptionId: string) {
  const api = useWorkspaceApi();
  const key = useOperationKey();
  const message = useSuccessToast();
  const [saved, setSaved] = useState(false);
  const save = useFixedOperation({
    execute: async (
      body: {
        operation_id: string;
        type: "FINANCIAL_EXCEPTION";
        resource_id: string;
      },
      signal,
    ) => {
      const response = await result(
        api.ignoreAllAdministratorWorkItems({ body, signal }),
      );
      const data = response?.data;
      if (
        !data ||
        data.operation_id !== body.operation_id ||
        typeof data.ignored_count !== "number"
      ) {
        throw new Error(
          "操作结果未完整返回，暂时无法确认是否成功。请重试或刷新核查。",
        );
      }
      return response;
    },
    onSuccess: () => {
      setSaved(true);
      message("本条争议提醒已忽略");
      void refreshFinancialRecords();
    },
    isSafeRejection: (error) =>
      error instanceof ApiError && (error.status === 404 || error.status === 409),
  });
  const action: RecordAction = {
    label: saved
      ? "已忽略"
      : save.conflict
        ? "刷新核查"
        : save.recovery
          ? "重试忽略此提醒"
          : "忽略此提醒",
    disabled: save.isPending || saved,
    onSelect: () => {
      if (save.conflict) {
        save.reset();
        void refreshFinancialRecords();
        return;
      }
      if (save.recovery) save.submit(save.recovery);
      else
        save.submit({
          operation_id: key(exceptionId),
          type: "FINANCIAL_EXCEPTION",
          resource_id: exceptionId,
        });
    },
  };
  return { action, error: save.error };
}

/** Restores a previously ignored dispute reminder directly from the order detail view. */
export function useRestoreDisputeReminder(exceptionId: string) {
  const { clientId } = useWorkspace();
  const key = useOperationKey();
  const message = useSuccessToast();
  const [restored, setRestored] = useState(false);
  const save = useFixedOperation({
    execute: (operationId: string, signal) =>
      restoreReminder(
        {
          ...(clientId ? { clientId } : {}),
          type: "FINANCIAL_EXCEPTION",
          resourceId: exceptionId,
          operationId,
        },
        signal,
      ),
    onSuccess: (outcome) => {
      setRestored(true);
      message(restoreMessages[outcome]);
      void refreshFinancialRecords();
    },
    isSafeRejection: (error) =>
      error instanceof ApiError && (error.status === 404 || error.status === 409),
  });
  const action: RecordAction = {
    label: restored
      ? "已恢复提醒"
      : save.conflict
        ? "刷新核查"
        : save.recovery
          ? "重试恢复提醒"
          : "恢复提醒",
    disabled: save.isPending || restored,
    onSelect: () => {
      if (save.conflict) {
        save.reset();
        void refreshFinancialRecords();
        return;
      }
      if (save.recovery) save.submit(save.recovery);
      else save.submit(key(`restore:${exceptionId}`));
    },
  };
  return { action, error: save.error };
}
