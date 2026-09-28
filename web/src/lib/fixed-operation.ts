import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { waitForOperation } from "./operation-timeout";

type Command<Input, Output> = {
  input: Input;
  execute: (input: Input, signal: AbortSignal) => Promise<Output>;
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
export function useFixedOperation<Input, Output = unknown>({
  execute,
  onSuccess,
  warnBeforeUnload = true,
  isSafeRejection,
  confirmsNotApplied,
}: {
  execute: Command<Input, Output>["execute"];
  onSuccess: (value: Output) => void;
  warnBeforeUnload?: boolean;
  isSafeRejection?: (error: unknown) => boolean;
  /** Only for responses that prove this operation, including previous attempts, never committed. */
  confirmsNotApplied?: (error: unknown, input: Input) => boolean;
}) {
  const [recovery, setRecovery] = useState<Command<Input, Output> | null>(null);
  const unresolved = useRef<Command<Input, Output> | null>(null);
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
    mutationFn: async (command: Command<Input, Output>) => {
      const operation = new AbortController();
      controller.current = operation;
      try {
        return await waitForOperation(operation, (signal) =>
          command.execute(command.input, signal),
        );
      } finally {
        if (controller.current === operation) controller.current = null;
      }
    },
    onError: (error, command) => {
      if (!alive.current) return;
      if (confirmsNotApplied?.(error, command.input)) {
        unresolved.current = null;
        setRecovery(null);
        return;
      }
      // Ordinary validation/authentication errors do not resolve an earlier lost response.
      if (
        unresolved.current ||
        (!isConflict(error) && !isRejected(error) && !isSafeRejection?.(error))
      ) {
        unresolved.current = command;
        setRecovery(command);
      }
    },
    onSuccess: (value) => {
      if (!alive.current) return;
      unresolved.current = null;
      setRecovery(null);
      onSuccess(value);
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const conflict = isConflict(mutation.error);
  useEffect(() => {
    if (!warnBeforeUnload || (!mutation.isPending && !recovery)) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [mutation.isPending, recovery, warnBeforeUnload]);
  return {
    error: mutation.error,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    conflict,
    recovery: recovery?.input ?? null,
    submitted: mutation.variables?.input ?? null,
    stopWaiting() {
      alive.current = false;
      controller.current?.abort();
    },
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

export function operationReasonError(
  value: string,
  { required = true } = {},
): string | null {
  const reason = value.trim();
  if (!reason) return required ? "请填写操作理由。" : null;
  if (/\p{Cc}/u.test(reason))
    return "操作理由不能包含换行或控制字符，请使用一行完整说明。";
  if (reason.length > 500) return "操作理由最多 500 个字符。";
  return null;
}
