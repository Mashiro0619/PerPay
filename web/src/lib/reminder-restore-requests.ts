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
  status: "pending" | "refreshing" | "success" | "error";
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
  onSuccess: (outcome: RestoreOutcome) => void | Promise<void>;
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
  function remove(key: string) {
    if (!current.current.has(key)) return;
    const next = new Map(current.current);
    next.delete(key);
    current.current = next;
    setStates(current.current);
  }
  const mutation = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async ({ command }: Attempt) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      let detach = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        detach = () => controller.signal.removeEventListener("abort", abort);
      });
      // Keep an explicit timer because this deadline supplies a localized custom TimeoutError reason before expiry.
      const timer = window.setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "等待恢复结果超时，请重试上一次操作或刷新列表核查。",
              "TimeoutError",
            ),
          ),
        20_000,
      );
      try {
        if (!alive.current) controller.abort();
        const outcome = await Promise.race([
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return restoreReminder(command, controller.signal);
          }),
          aborted,
        ]);
        controller.signal.throwIfAborted();
        return outcome;
      } finally {
        window.clearTimeout(timer);
        detach();
        controllers.current.delete(controller);
      }
    },
    onSuccess: (outcome, attempt) => {
      if (!alive.current) return;
      update(attempt.key, {
        command: attempt.command,
        status: "refreshing",
        error: null,
      });
      void Promise.resolve(attempt.onSuccess(outcome)).finally(() => {
        if (!alive.current) return;
        const latest = current.current.get(attempt.key);
        if (latest?.status === "refreshing" && latest.command === attempt.command) {
          update(attempt.key, {
            command: attempt.command,
            status: "success",
            error: null,
          });
        }
      });
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
    clear: (item: AdminWorkItem) => remove(keyOf(item)),
    markRefreshing(item: AdminWorkItem) {
      const key = keyOf(item);
      const previous = current.current.get(key);
      if (!previous) return;
      update(key, { command: previous.command, status: "refreshing", error: null });
    },
    pendingCount: [...states.values()].filter(
      (state) => state.status === "pending" || state.status === "refreshing",
    ).length,
    submit(item: AdminWorkItem, onSuccess: Attempt["onSuccess"]) {
      const key = keyOf(item);
      const previous = current.current.get(key);
      if (
        item.ended ||
        previous?.status === "pending" ||
        previous?.status === "refreshing" ||
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
