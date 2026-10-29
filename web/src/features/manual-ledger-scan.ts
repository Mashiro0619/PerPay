import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, refreshOperationalData, result, type LedgerManualScanRequest, type SystemStatus } from "@/api/client";
import { isReadOnlyDemo } from "@/demo-mode";
import { isManualScanRequest, manualScanActive, manualScanSource, manualScanUnavailable } from "@/lib/manual-ledger-scan";

export function useManualLedgerScan(data: SystemStatus | undefined) {
  const mounted = useRef(false);
  const source = data ? manualScanSource(data) : null;
  const currentSource = useRef(source);
  const pending = useRef<AbortController | null>(null);
  const [accepted, setAccepted] = useState<{ source: string; request: LedgerManualScanRequest } | null>(null);
  const [failedAt, setFailedAt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const submission = useMutation({
    retry: false,
    networkMode: "always",
    mutationFn: async (input: { source: string; controller: AbortController; previousRequestId: string | null }) => {
      if (isReadOnlyDemo()) throw new Error("当前操作不可用。");
      if (!navigator.onLine) throw new Error("当前无法提交查账请求，请恢复连接后重试。");
      const response = await result(api.requestLedgerScan({ body: {}, signal: input.controller.signal }));
      if (!mounted.current || input.controller.signal.aborted || currentSource.current !== input.source) {
        throw new DOMException("查账来源已变化，已忽略旧请求结果。", "AbortError");
      }
      if (!isManualScanRequest(response?.data)) throw new Error("查账请求响应不完整，请刷新运行状态后核对。");
      return response.data;
    },
    onSuccess: (request, input) => {
      if (!mounted.current || currentSource.current !== input.source || input.controller.signal.aborted) return;
      setAccepted({ source: input.source, request });
      void refreshOperationalData().then(() => {
        if (!mounted.current || currentSource.current !== input.source || input.controller.signal.aborted) return;
        // Once the fresh status read has settled it is authoritative, including
        // after a runtime restart that no longer retains this in-memory request.
        setAccepted(current => current?.request.id === request.id ? null : current);
      });
    },
    onError: (error, input) => {
      if (!mounted.current || currentSource.current !== input.source || input.controller.signal.aborted || error.name === "AbortError") return;
      setFailedAt(Date.now());
    },
    onSettled: (_result, _error, input) => {
      if (pending.current === input.controller) pending.current = null;
    },
  });
  const { reset } = submission;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; };
  }, []);
  useEffect(() => {
    // A hidden/offline status epoch temporarily has no snapshot. Keep the request
    // until a fresh snapshot proves that the payment runtime itself has changed.
    if (source === null || source === currentSource.current) return;
    currentSource.current = source;
    pending.current?.abort();
    pending.current = null;
    setAccepted(null);
    setFailedAt(0);
    reset();
  }, [source, reset]);

  const serverRequest = data?.ledger.manual_scan?.request ?? null;
  const sameSource = submission.variables?.source === source && !submission.variables.controller.signal.aborted;
  const confirmedNewRequest = !!serverRequest && serverRequest.id !== submission.variables?.previousRequestId;
  const error = !sameSource || confirmedNewRequest || submission.error?.name === "AbortError" ? null : submission.error;
  const retrySeconds = error instanceof ApiError ? error.retryAfter : null;
  const retryAt = retrySeconds !== null && Number.isFinite(retrySeconds) ? failedAt + retrySeconds * 1000 : 0;
  const remaining = Math.max(0, Math.ceil((retryAt - Math.max(clock, failedAt)) / 1000));
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      window.clearTimeout(timer);
      const now = Date.now();
      setClock(now);
      if (now < retryAt) timer = window.setTimeout(tick, Math.min(1000, retryAt - now));
    };
    tick();
    window.addEventListener("focus", tick);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", tick); };
  }, [retryAt]);

  const localRequest = accepted?.source === source ? accepted.request : null;
  const request = localRequest && (!serverRequest || (serverRequest.id !== localRequest.id && Date.parse(serverRequest.requested_at) < Date.parse(localRequest.requested_at)))
    ? localRequest : serverRequest;
  const capability = data?.ledger.manual_scan;
  const demo = isReadOnlyDemo();
  const unavailableReason = demo ? null
    : (data?.alipay_accounts?.length ?? 0) > 1 ? "请在下方选择对应支付宝账号查账。"
    : !capability ? "手动查账状态暂不可用，请刷新。"
      : !capability.available ? manualScanUnavailable[capability.unavailable_reason ?? "stopped"] : null;
  const submitting = sameSource && submission.isPending;
  const disabled = demo || !capability?.available || submitting || manualScanActive(request) || remaining > 0;
  const submit = () => {
    if (disabled || pending.current || !source || Date.now() < retryAt) return;
    const controller = new AbortController();
    pending.current = controller;
    setAccepted(null);
    submission.mutate({ source, controller, previousRequestId: serverRequest?.id ?? null });
  };
  return { request, error, remaining, unavailableReason, disabled, pending: submitting, submit };
}
