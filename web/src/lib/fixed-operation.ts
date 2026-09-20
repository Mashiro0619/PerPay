import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/api/client";

type Command<Input> = {
  input: Input;
  execute: (input: Input, signal: AbortSignal) => Promise<unknown>;
};
const rejectedBeforeExecution: Readonly<Record<string, number>> = {
  validation_failed: 422,
  csrf_invalid: 403,
  origin_not_allowed: 403,
  auth_rate_limited: 429,
};
const isConflict = (error: unknown) =>
  error instanceof ApiError && error.status === 409;
const isRejected = (error: unknown) =>
  error instanceof ApiError &&
  rejectedBeforeExecution[error.code] === error.status;

/** Keeps a fixed command after an uncertain response; caller owns its evidence and close/refresh policy. */
export function useFixedOperation<Input>({
  execute,
  onSuccess,
}: {
  execute: Command<Input>["execute"];
  onSuccess: () => void;
}) {
  const [recovery, setRecovery] = useState<Command<Input> | null>(null);
  const unresolved = useRef<Command<Input> | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const mutation = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async (command: Command<Input>) => {
      const operation = new AbortController();
      controller.current = operation;
      let detach = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(operation.signal.reason);
        operation.signal.addEventListener("abort", abort, { once: true });
        detach = () => operation.signal.removeEventListener("abort", abort);
      });
      const timer = window.setTimeout(
        () =>
          operation.abort(new DOMException("等待操作结果超时", "TimeoutError")),
        20_000,
      );
      try {
        const value = await Promise.race([
          Promise.resolve().then(() =>
            command.execute(command.input, operation.signal),
          ),
          aborted,
        ]);
        operation.signal.throwIfAborted();
        return value;
      } catch (error) {
        if (
          operation.signal.reason instanceof DOMException &&
          operation.signal.reason.name === "TimeoutError"
        )
          throw new Error("等待操作结果超时。停止等待不代表服务端已取消操作。");
        throw error;
      } finally {
        window.clearTimeout(timer);
        detach();
        if (controller.current === operation) controller.current = null;
      }
    },
    onError: (error, command) => {
      if (!alive.current) return;
      // A later rejection never proves what happened to an earlier lost response.
      if (unresolved.current || (!isConflict(error) && !isRejected(error))) {
        unresolved.current = command;
        setRecovery(command);
      }
    },
    onSuccess: () => {
      if (!alive.current) return;
      unresolved.current = null;
      setRecovery(null);
      onSuccess();
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const conflict = isConflict(mutation.error);
  useEffect(() => {
    if (!mutation.isPending && !recovery) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [mutation.isPending, recovery]);
  return {
    error: mutation.error,
    isPending: mutation.isPending,
    conflict,
    recovery: recovery?.input ?? null,
    isBusy: () => sending.current || mutation.isPending,
    submit(input: Input) {
      if (
        sending.current ||
        mutation.isPending ||
        conflict ||
        mutation.isSuccess
      )
        return;
      sending.current = true;
      mutation.mutate(unresolved.current ?? { input, execute });
    },
    reset() {
      if (sending.current || mutation.isPending || unresolved.current)
        return false;
      mutation.reset();
      return true;
    },
  };
}

export function operationReasonError(value: string): string | null {
  const reason = value.trim();
  if (!reason) return "请填写操作理由。";
  if (/\p{Cc}/u.test(reason))
    return "操作理由不能包含换行或控制字符，请使用一行完整说明。";
  if (reason.length > 500) return "操作理由最多 500 个字符。";
  return null;
}
