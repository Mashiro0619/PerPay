import { useCallback, useEffect, useRef } from "react";
import { ApiError } from "@/api/client";
import { OperationTimeoutError, waitForOperation } from "@/lib/operation-timeout";

export function isOperationResultUnknown(error: unknown): boolean {
  return error instanceof OperationTimeoutError ||
    (error instanceof ApiError && (
      (error.status === 0 && error.code === "request_failed") ||
      error.code === "invalid_response"
    ));
}

export function useOperationWait() {
  const pending = useRef(new Set<AbortController>());
  useEffect(() => () => {
    for (const operation of pending.current) operation.abort();
    pending.current.clear();
  }, []);

  return useCallback(async <T>(
    execute: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const operation = new AbortController();
    const abort = () => operation.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    pending.current.add(operation);
    try {
      return await waitForOperation(operation, execute);
    } finally {
      signal?.removeEventListener("abort", abort);
      pending.current.delete(operation);
    }
  }, []);
}
