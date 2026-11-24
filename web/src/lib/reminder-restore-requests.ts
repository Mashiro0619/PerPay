import { useWorkspace } from "@/workspace";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, type AdminWorkItem } from "@/api/client";
import {
  restoreReminder,
  type RestoreCommand,
  type RestoreOutcome,
} from "@/lib/reminder-restore";

export type ReminderRestoreState = {
  command: RestoreCommand;
  status: "pending" | "success" | "error";
  error: unknown;
};
const keyOf = (item: AdminWorkItem) =>
  JSON.stringify([item.type, item.resource_id, item.ignored_at]);
export const needsReminderRefresh = (state: ReminderRestoreState | undefined) =>
  state?.status === "success" ||
  (state?.error instanceof ApiError && state.error.status === 409);

type Attempt = {
  key: string;
  command: RestoreCommand;
  onSuccess: (outcome: RestoreOutcome) => void;
};

/** A refreshed row may disappear before its receipt arrives; the list owns the requests. */
export function useReminderRestores() {
  const { clientId } = useWorkspace();
  const [states, setStates] = useState(new Map<string, ReminderRestoreState>());
  const current = useRef(states);
  const alive = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    alive.current = true;
    const active = controllers.current;
    return () => {
      alive.current = false;
      for (const controller of active) controller.abort();
    };
  }, []);
  function update(key: string, state: ReminderRestoreState) {
    current.current = new Map(current.current).set(key, state);
    setStates(current.current);
  }
  const mutation = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async ({ command }: Attempt) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(20_000),
      ]);
      let detach = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        detach = () => signal.removeEventListener("abort", abort);
      });
      try {
        if (!alive.current) controller.abort();
        const outcome = await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return restoreReminder(command, signal);
          }),
          aborted,
        ]);
        signal.throwIfAborted();
        return outcome;
      } catch (error) {
        if (
          (signal.aborted &&
            signal.reason instanceof DOMException &&
            signal.reason.name === "TimeoutError") ||
          (error instanceof DOMException && error.name === "TimeoutError")
        ) {
          throw new DOMException(
            "等待恢复结果超时，请重试上一次操作或刷新列表核查。",
            "TimeoutError",
          );
        }
        throw error;
      } finally {
        detach();
        controllers.current.delete(controller);
      }
    },
    onSuccess: (outcome, attempt) => {
      if (!alive.current) return;
      update(attempt.key, {
        command: attempt.command,
        status: "success",
        error: null,
      });
      attempt.onSuccess(outcome);
    },
    onError: (error, attempt) => {
      if (alive.current)
        update(attempt.key, {
          command: attempt.command,
          status: "error",
          error,
        });
    },
  });
  return {
    get: (item: AdminWorkItem) => states.get(keyOf(item)),
    pendingCount: [...states.values()].filter(
      (state) => state.status === "pending",
    ).length,
    submit(item: AdminWorkItem, onSuccess: Attempt["onSuccess"]) {
      const key = keyOf(item);
      const previous = current.current.get(key);
      if (
        item.ended ||
        previous?.status === "pending" ||
        needsReminderRefresh(previous)
      )
        return false;
      const command = previous?.command ?? {
        ...(clientId ? { clientId } : {}),
        type: item.type,
        resourceId: item.resource_id,
        operationId: crypto.randomUUID(),
      };
      update(key, { command, status: "pending", error: null });
      mutation.mutate({ key, command, onSuccess });
      return true;
    },
  };
}
