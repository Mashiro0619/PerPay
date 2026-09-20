import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ApiError,
  api,
  refreshOperationalData,
  result,
  type AdminTestPaymentRequest,
} from "@/api/client";
import { parseAmount } from "@/lib/format";
import { createOperationKey } from "@/lib/idempotency";

const creationTimeout = 20_000;
// Only these documented pre-creation rejections prove a first request did not create an order.
const rejectedBeforeCreation: Readonly<Record<string, number>> = {
  validation_failed: 422,
  csrf_invalid: 403,
  origin_not_allowed: 403,
  auth_rate_limited: 429,
  reconciliation_not_ready: 503,
  system_not_configured: 503,
  amount_slots_exhausted: 503,
};
function definitelyRejected(error: unknown) {
  return (
    error instanceof ApiError &&
    rejectedBeforeCreation[error.code] === error.status
  );
}

export function useTestPaymentRequest(active: boolean) {
  const [amount, setAmount] = useState("0.01");
  const [validation, setValidation] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);
  const [recovery, setRecovery] = useState<AdminTestPaymentRequest | null>(
    null,
  );
  const unresolved = useRef<AdminTestPaymentRequest | null>(null);
  const key = useRef(createOperationKey());
  const sending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const create = useMutation({
    // Financial commands must not silently resume from an offline queue.
    networkMode: "always",
    mutationFn: async (body: AdminTestPaymentRequest) => {
      const operation = new AbortController();
      controller.current = operation;
      const timer = window.setTimeout(
        () =>
          operation.abort(new DOMException("等待创建结果超时", "TimeoutError")),
        creationTimeout,
      );
      try {
        const response = await result(
          api.createAdministratorTestPayment({
            body,
            signal: operation.signal,
          }),
        );
        const order = response?.data;
        if (
          !order ||
          typeof order.order_id !== "string" ||
          !order.order_id ||
          typeof order.merchant_order_no !== "string" ||
          !Number.isSafeInteger(order.requested_amount_cents) ||
          !Number.isSafeInteger(order.payable_amount_cents) ||
          (order.received_amount_cents !== null &&
            !Number.isSafeInteger(order.received_amount_cents)) ||
          typeof order.checkout?.checkout_url !== "string" ||
          !["UNPAID", "CONFIRMED", "DISPUTED"].includes(order.payment?.status)
        ) {
          throw new Error("服务未返回完整的订单结果，请使用原请求重试。");
        }
        return response;
      } catch (error) {
        if (
          operation.signal.reason instanceof DOMException &&
          operation.signal.reason.name === "TimeoutError"
        )
          throw new Error(
            "等待创建结果超时。停止等待并不代表服务端已取消创建。",
          );
        throw error;
      } finally {
        window.clearTimeout(timer);
        if (controller.current === operation) controller.current = null;
      }
    },
    onError: (error, body) => {
      // A later rejection cannot settle the outcome of an earlier lost response.
      if (unresolved.current || !definitelyRejected(error)) {
        unresolved.current = body;
        setRecovery(body);
      }
    },
    onSuccess: () => {
      unresolved.current = null;
      setRecovery(null);
      void refreshOperationalData();
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: active && !create.data && !recovery,
    staleTime: 0,
  });
  const canCreate =
    !!status.data &&
    !status.isError &&
    !status.isFetching &&
    status.data.data.status !== "not_ready";
  const pending = create.isPending;
  useEffect(() => {
    if (!pending && !recovery) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [pending, recovery]);
  function submit(): "submitted" | "blocked" | "invalid" {
    if (
      sending.current ||
      pending ||
      create.data ||
      (!unresolved.current && !canCreate)
    )
      return "blocked";
    let body = unresolved.current;
    if (!body) {
      try {
        const cents = parseAmount(amount);
        body = { amount_cents: cents, test_payment_id: key.current(cents) };
      } catch (error) {
        setValidation(error as Error);
        return "invalid";
      }
    }
    setValidation(null);
    sending.current = true;
    create.mutate(body);
    return "submitted";
  }
  function editAmount(value: string) {
    if (sending.current || pending || unresolved.current || create.data) return;
    setAmount(value);
    setValidation(null);
    create.reset();
  }
  function startNew() {
    if (sending.current || pending || unresolved.current || !create.data)
      return;
    key.current = createOperationKey();
    setAmount("0.01");
    setValidation(null);
    create.reset();
    setGeneration((value) => value + 1);
  }
  return {
    amount,
    validation,
    generation,
    recovery,
    create,
    status,
    pending,
    canCreate,
    submit,
    editAmount,
    startNew,
    isSubmitting: () => sending.current || pending,
  };
}

export const TestPaymentRequestContext = createContext<ReturnType<
  typeof useTestPaymentRequest
> | null>(null);
export function useCurrentTestPayment() {
  const value = useContext(TestPaymentRequestContext);
  if (!value) throw new Error("Test payment requires TestPaymentProvider");
  return value;
}
