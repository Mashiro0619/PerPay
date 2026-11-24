import { useEffect, useRef, useState } from "react";
import { ApiError, result, type AdminWorkItem } from "@/api/client";
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { waitForOperation } from "@/lib/operation-timeout";
import { restoreMessages, restoreReminder } from "@/lib/reminder-restore";
import { useErrorToast, useSuccessToast } from "@/components/Feedback";
import type { RecordAction } from "@/components/record/ActionMenu";

type ReminderKind = AdminWorkItem["type"];
type ReminderCommand = {
  readonly kind: "ignore" | "restore";
  readonly operation_id: string;
};

const safeRejectionCodes: Readonly<Record<string, number>> = {
  validation_failed: 422,
  csrf_invalid: 403,
  origin_not_allowed: 403,
  auth_rate_limited: 429,
  work_item_not_found: 404,
  order_not_found: 404,
  work_item_ended: 409,
};

function isSafeRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    safeRejectionCodes[error.code] === error.status
  );
}

/**
 * Symmetric ignore / restore reminder action for detail drawers (exceptions,
 * conflicts, notifications). Uses idempotent operation IDs, 20s timeout, and
 * receipt verification without altering the underlying financial or webhook state.
 */
export function useReminderVisibilityAction({
  type,
  resourceId,
  ignored,
  enabled,
  onRefresh,
}: {
  type: ReminderKind;
  resourceId: string;
  ignored: boolean;
  enabled: boolean;
  onRefresh: () => void | Promise<void>;
}) {
  const api = useWorkspaceApi();
  const { clientId } = useWorkspace();
  const successToast = useSuccessToast();
  const errorToast = useErrorToast();
  const [optimisticIgnored, setOptimisticIgnored] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [recovery, setRecovery] = useState<ReminderCommand | null>(null);
  const [error, setError] = useState<unknown>(null);
  const inflight = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    setOptimisticIgnored(null);
    setRecovery(null);
    setError(null);
  }, [resourceId, ignored]);

  const effectiveIgnored = optimisticIgnored ?? ignored;

  async function run(command: ReminderCommand) {
    if (inflight.current) return;
    inflight.current = true;
    setPending(true);
    setError(null);
    const abortController = new AbortController();
    controller.current = abortController;
    try {
      const outcome = await waitForOperation(abortController, async (signal) => {
        if (command.kind === "ignore") {
          const response = await result(
            api.ignoreAllAdministratorWorkItems({
              body: {
                operation_id: command.operation_id,
                type,
                resource_id: resourceId,
              },
              signal,
            }),
          );
          const data = response?.data;
          if (
            !data ||
            data.operation_id !== command.operation_id ||
            typeof data.ignored_count !== "number"
          ) {
            throw new Error(
              "操作结果未完整返回，暂时无法确认是否成功。请重试上一次操作或刷新核查。",
            );
          }
          return {
            ignored: true,
            message:
              data.ignored_count > 0 ? "本条提醒已忽略" : "这条提醒已处于忽略状态",
          };
        }
        const restored = await restoreReminder(
          {
            ...(clientId ? { clientId } : {}),
            type,
            resourceId,
            operationId: command.operation_id,
          },
          signal,
        );
        return {
          ignored: false,
          message: restoreMessages[restored],
        };
      });
      if (!alive.current) return;
      setRecovery(null);
      setOptimisticIgnored(outcome.ignored);
      successToast(outcome.message);
      void onRefresh();
    } catch (reason) {
      if (!alive.current) return;
      setError(reason);
      if (reason instanceof ApiError && reason.status === 409) {
        setRecovery(null);
        errorToast(reason.message || "提醒状态已更新，请刷新核查。");
        void onRefresh();
      } else {
        if (!isSafeRejection(reason)) {
          setRecovery(command);
        }
        const message =
          reason instanceof Error && reason.message
            ? reason.message
            : "操作失败，请重试或刷新核查。";
        errorToast(message);
      }
    } finally {
      if (controller.current === abortController) controller.current = null;
      inflight.current = false;
      if (alive.current) setPending(false);
    }
  }

  if (!enabled) return { action: null as RecordAction | null, error };

  const retryLabel =
    recovery?.kind === "restore"
      ? "重试恢复提醒"
      : recovery?.kind === "ignore"
        ? "重试忽略此提醒"
        : null;

  const action: RecordAction = {
    label: pending
      ? effectiveIgnored
        ? "正在恢复…"
        : "正在忽略…"
      : retryLabel ?? (effectiveIgnored ? "恢复提醒" : "忽略此提醒"),
    disabled: pending,
    onSelect: () => {
      if (pending) return;
      const command: ReminderCommand = recovery ?? {
        kind: effectiveIgnored ? "restore" : "ignore",
        operation_id: crypto.randomUUID(),
      };
      void run(command);
    },
  };

  return { action, error };
}
