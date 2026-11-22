import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { result, type WebhookAttempt, type WebhookDeliveryDetail, type WebhookDeliverySummary } from "@/api/client";
import { attemptResult, latestAttempt, notificationErrorName, notificationRecoveryHint } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { refreshNotificationRecords } from "@/lib/record-refresh";
import { Link, useNavigate } from "@/navigation";
import { useWorkspaceApi } from "@/workspace";
import { StatusBadge } from "@/components/business-status";
import { useErrorToast, useSuccessToast } from "@/components/Feedback";
import { ReasonDialog } from "@/components/ReasonDialog";
import { FieldList, type Field } from "@/components/record/FieldList";
import { RecordTime, type TimelineEntry } from "@/components/record/Timeline";

export const DEAD_LETTER_QUICK_REASONS = [
  "回调修复后手动重发",
  "网络恢复后手动补发",
] as const;

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

type DeliveryContext = WebhookDeliveryDetail & {
  attempts: readonly WebhookAttempt[];
};
/** The redelivery confirmation and the call that opens it; a created delivery is opened afterwards. */
export function useRedelivery(detail: DeliveryContext | null) {
  const api = useWorkspaceApi();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<DeliveryContext | null>(null);
  const [sent, setSent] = useState(false);
  const [newDeliveryId, setNewDeliveryId] = useState<string | null>(null);
  const deliveryId = detail?.delivery.delivery_id ?? null;
  useEffect(() => {
    setSent(false);
  }, [deliveryId]);
  useEffect(() => {
    if (!newDeliveryId) return;
    const target = "/notifications/" + newDeliveryId;
    setNewDeliveryId(null);
    navigate(target);
  }, [newDeliveryId, navigate]);
  const setMessage = useSuccessToast();
  const finalFocus = useRef<HTMLElement | null>(null);
  const open = (trigger: HTMLElement | null) => {
    if (!detail) return;
    finalFocus.current = trigger;
    setSnapshot(detail);
  };
  const dialog = snapshot && (
        <ReasonDialog
          key={snapshot.delivery.delivery_id}
          finalFocus={() => finalFocus.current}
          title="重新发送通知"
          description="再次发送同一事件，业务方需避免重复处理。"
          action="确认重新发送"
          quickReasons={snapshot.delivery.status === "DEAD_LETTER" ? DEAD_LETTER_QUICK_REASONS : undefined}
          onClose={() => setSnapshot(null)}
          execute={(reason, operationId, signal) =>
            result(
              api.redeliverWebhookDelivery({
                signal,
                path: { deliveryId: snapshot.delivery.delivery_id },
                body: { reason, redelivery_id: operationId },
              }),
            )
          }
          onSuccess={({ data }) => {
            // A successful redelivery creates a newer record and removes this
            // action. Restore focus to content that remains on the page.
            finalFocus.current = document.getElementById("main-content");
            setSnapshot(null);
            setSent(true);
            setNewDeliveryId(data.delivery.delivery_id);
            setMessage("已创建新通知，等待发送");
            void refreshNotificationRecords(snapshot.event.order_id, snapshot.delivery.delivery_id);
          }}
        >
          <FieldList
            items={[
              { label: "事件", value: label(snapshot.event.event_type) },
              { label: "通知地址", kind: "id", value: snapshot.target.target_url },
            ]}
          />
        </ReasonDialog>
  );
  return { sent, open, dialog };
}

/** Triggers an immediate retry attempt for a waiting delivery without creating a duplicate generation. */
export function useRetryDelivery(detail: WebhookDeliveryDetail | null) {
  const api = useWorkspaceApi();
  const [pending, setPending] = useState(false);
  const inflight = useRef(false);
  const mounted = useRef(true);
  const setSuccess = useSuccessToast();
  const setError = useErrorToast();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = () => {
    if (!detail || inflight.current) return;
    const deliveryId = detail.delivery.delivery_id;
    const orderId = detail.event.order_id;
    inflight.current = true;
    setPending(true);
    void result(
      api.retryWebhookDelivery({
        path: { deliveryId },
        body: {},
      }),
    ).then(
      () => {
        setSuccess("已发起立即重试");
        void refreshNotificationRecords(orderId, deliveryId);
      },
      (error: unknown) => {
        if (isAbortError(error)) return;
        setError(error instanceof Error && error.message ? error.message : "立即重试失败，请刷新后重试");
        void refreshNotificationRecords(orderId, deliveryId);
      },
    ).finally(() => {
      inflight.current = false;
      if (mounted.current) setPending(false);
    });
  };
  return { pending, run };
}

/** Shared immediate retry runner tracked per delivery ID so independent rows never block each other. */
export function useQuickRetryDelivery() {
  const api = useWorkspaceApi();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  const setSuccess = useSuccessToast();
  const setError = useErrorToast();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = (deliveryId: string, orderId: string | null) => {
    if (inflight.current.has(deliveryId)) return;
    inflight.current.add(deliveryId);
    setPendingIds((current) => {
      const next = new Set(current);
      next.add(deliveryId);
      return next;
    });
    void result(
      api.retryWebhookDelivery({
        path: { deliveryId },
        body: {},
      }),
    ).then(
      () => {
        setSuccess("已发起立即重试");
        void refreshNotificationRecords(orderId, deliveryId);
      },
      (error: unknown) => {
        if (isAbortError(error)) return;
        setError(error instanceof Error && error.message ? error.message : "立即重试失败，请刷新后重试");
        void refreshNotificationRecords(orderId, deliveryId);
      },
    ).finally(() => {
      inflight.current.delete(deliveryId);
      if (mounted.current) {
        setPendingIds((current) => {
          if (!current.has(deliveryId)) return current;
          const next = new Set(current);
          next.delete(deliveryId);
          return next;
        });
      }
    });
  };
  const isPending = (deliveryId: string) => pendingIds.has(deliveryId);
  return { pendingIds, isPending, run };
}

/** Shared redelivery dialog for dead-lettered rows in the notifications list without leaving the list. */
export function useSummaryRedelivery() {
  const api = useWorkspaceApi();
  const [snapshot, setSnapshot] = useState<WebhookDeliverySummary | null>(null);
  const [sentIds, setSentIds] = useState<ReadonlySet<string>>(() => new Set());
  const finalFocus = useRef<HTMLElement | null>(null);
  const setMessage = useSuccessToast();
  const open = (summary: WebhookDeliverySummary, trigger: HTMLElement | null) => {
    if (sentIds.has(summary.delivery_id)) return;
    finalFocus.current = trigger;
    setSnapshot(summary);
  };
  const dialog = snapshot && (
    <ReasonDialog
      key={snapshot.delivery_id}
      finalFocus={() => finalFocus.current}
      title="重新发送通知"
      description="再次发送同一事件，业务方需避免重复处理。"
      action="确认重新发送"
      quickReasons={snapshot.status === "DEAD_LETTER" ? DEAD_LETTER_QUICK_REASONS : undefined}
      onClose={() => setSnapshot(null)}
      execute={(reason, operationId, signal) =>
        result(
          api.redeliverWebhookDelivery({
            signal,
            path: { deliveryId: snapshot.delivery_id },
            body: { reason, redelivery_id: operationId },
          }),
        )
      }
      onSuccess={() => {
        finalFocus.current = document.getElementById("main-content");
        const orderId = snapshot.event.order_id;
        const deliveryId = snapshot.delivery_id;
        setSentIds((current) => {
          const next = new Set(current);
          next.add(deliveryId);
          return next;
        });
        setSnapshot(null);
        setMessage("已创建新通知，等待发送");
        void refreshNotificationRecords(orderId, deliveryId);
      }}
    >
      <FieldList
        items={[
          { label: "事件", value: label(snapshot.event.event_type) },
          snapshot.order_summary && { label: "商品", value: snapshot.order_summary.product_name },
          snapshot.order_summary && { label: "商户订单号", kind: "id", value: snapshot.order_summary.merchant_order_no },
        ]}
      />
    </ReasonDialog>
  );
  const isSent = (deliveryId: string) => sentIds.has(deliveryId);
  return { open, isSent, dialog };
}

/** Actionability state for a list-level delivery summary. */
export function summaryDeliveryState(summary: WebhookDeliverySummary) {
  const isLatest = summary.is_latest !== false;
  const confirmationRevoked =
    summary.redelivery_blocked_reason === "payment_confirmation_revoked" ||
    summary.last_error_code === "payment_confirmation_revoked";
  const terminal = summary.status === "ACKNOWLEDGED" || summary.status === "DEAD_LETTER";
  return {
    isLatest,
    confirmationRevoked,
    terminal,
    terminated: confirmationRevoked && summary.status !== "ACKNOWLEDGED",
    retryable: isLatest && summary.status === "RETRY_WAIT" && !confirmationRevoked,
    resendable: isLatest && terminal && !confirmationRevoked,
    nextAttemptAt: terminal || confirmationRevoked ? null : summary.next_attempt_at,
  };
}

/** A revoked payment confirmation ends a delivery whatever its own status says. */
export function deliveryState(detail: WebhookDeliveryDetail) {
  const status = detail.delivery.status;
  const confirmationRevoked = detail.redelivery_blocked_reason === "payment_confirmation_revoked" ||
    detail.delivery.last_error_code === "payment_confirmation_revoked";
  const terminal = status === "ACKNOWLEDGED" || status === "DEAD_LETTER";
  return {
    confirmationRevoked,
    /** No further attempt will be made on its own. */
    terminal,
    /** Ended by the revocation before the other side confirmed it. */
    terminated: confirmationRevoked && status !== "ACKNOWLEDGED",
    /** A waiting delivery can be retried immediately instead of waiting for backoff. */
    retryable: detail.is_latest && status === "RETRY_WAIT" && !confirmationRevoked,
    /** Only the current delivery can be sent again, once it has ended. The server refuses one whose confirmation was revoked. */
    resendable: detail.is_latest && terminal && !confirmationRevoked,
    /** When the next attempt is due, while one is still coming. */
    nextAttemptAt: terminal || confirmationRevoked ? null : detail.delivery.next_attempt_at,
  };
}

export function DeliveryStatus({ detail }: { detail: WebhookDeliveryDetail }) {
  const { terminated } = deliveryState(detail);
  return <StatusBadge value={terminated ? "REVERSED" : detail.delivery.status} label={terminated ? "已终止" : undefined} />;
}

/** One sentence on where the delivery stands, avoiding verbatim repetition of its status badge. */
export function deliveryPhrase(detail: WebhookDeliveryDetail, attempts: readonly WebhookAttempt[] = []): string {
  const status = detail.delivery.status;
  if (deliveryState(detail).confirmationRevoked) {
    return status === "ACKNOWLEDGED" ? "对方曾返回确认回执，但原付款确认已撤销" : "原付款确认已撤销，已停止发送";
  }
  if (!detail.is_latest) return status === "ACKNOWLEDGED" ? "历史发送 · 对方已返回确认回执" : "历史发送记录";
  if (status === "ACKNOWLEDGED") return "对方已返回有效确认回执";
  const last = latestAttempt(attempts);
  const errorCode = detail.delivery.last_error_code ?? last?.error_code ?? last?.ack_code ?? null;
  if (status === "DEAD_LETTER" || status === "RETRY_WAIT") {
    const lastErrorCode = last?.error_code ?? last?.ack_code ?? null;
    if (last?.http_status != null && lastErrorCode === "http_status_not_ack" && errorCode === "http_status_not_ack") {
      return `返回 HTTP ${last.http_status}，状态不符合确认要求`;
    }
    if (errorCode) return notificationErrorName(errorCode);
    if (last?.http_status != null) return `返回 HTTP ${last.http_status}，未收到有效确认回执`;
    return status === "DEAD_LETTER"
      ? detail.delivery.attempt_count > 1 ? "多次发送未确认，需人工处理" : "发送未确认，需人工处理"
      : "上次发送未确认，将自动重试";
  }
  if (status === "LEASED") return "正在向业务网站发送通知";
  return "已排入发送队列";
}

/** What to do about a delivery that failed or was ended; nothing when it needs no action. */
export function deliveryAdvice(detail: WebhookDeliveryDetail, attempts: readonly WebhookAttempt[]) {
  if (deliveryState(detail).confirmationRevoked) return notificationRecoveryHint("payment_confirmation_revoked");
  if (!detail.is_latest || !["DEAD_LETTER", "RETRY_WAIT"].includes(detail.delivery.status)) return null;
  return <span className="flex min-w-0 flex-col gap-1.5">
    <span>{notificationRecoveryHint(detail.delivery.last_error_code ?? latestAttempt(attempts)?.error_code ?? null)}</span>
    <a data-external-link className="inline-flex w-fit items-center gap-1 rounded-xs text-[0.8125rem] leading-5 font-medium text-foreground/90 underline decoration-current/40 underline-offset-4 transition-colors hover:text-foreground hover:decoration-current pointer-coarse:min-h-11" href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md#5-回调通知" target="_blank" rel="noopener noreferrer">
      通知接入说明<ExternalLink aria-hidden="true" className="size-3.5 shrink-0 opacity-75" />
    </a>
  </span>;
}

/** A delivery not attempted yet is scheduled; one that failed is waiting to be retried. */
export function nextAttemptLabel(detail: WebhookDeliveryDetail) {
  return detail.delivery.status === "RETRY_WAIT" ? "下次重试" : "计划发送";
}

/**
 * The facts of one delivery besides its event, status and attempts.
 * `schedule: false` leaves out the next attempt for a caller that states it elsewhere.
 */
export function deliveryFields(detail: WebhookDeliveryDetail, attempts: readonly WebhookAttempt[], { schedule = true, showLastError = true }: { schedule?: boolean; showLastError?: boolean } = {}): Array<Field | false> {
  const delivery = detail.delivery;
  const { nextAttemptAt } = deliveryState(detail);
  return [
    { label: "通知地址", kind: "id", value: detail.target.target_url, copy: detail.target.target_url },
    !detail.is_latest && !!detail.latest_delivery_id && { label: "后续结果", value: <Link className="underline underline-offset-4" to={"/notifications/" + detail.latest_delivery_id}>已重新发送，查看最新结果</Link> },
    !!delivery.predecessor_delivery_id && { label: "原通知", value: <Link className="underline underline-offset-4" to={"/notifications/" + delivery.predecessor_delivery_id}>查看原通知</Link> },
    schedule && !!nextAttemptAt && { label: nextAttemptLabel(detail), kind: "time", value: <RecordTime value={nextAttemptAt} /> },
    // The business website keeps its own time of delivery; this one is PerPay's.
    !!delivery.acknowledged_at && { label: "通知确认时间", kind: "time", value: <RecordTime value={delivery.acknowledged_at} />, hint: "PerPay 收到成功回执的时间" },
    showLastError && !!delivery.last_error_code && delivery.last_error_code !== latestAttempt(attempts)?.error_code && { label: "最近错误", value: notificationErrorName(delivery.last_error_code) },
    delivery.requested_by_type === "ADMIN" && { label: "发起人", value: delivery.requested_by_actor_id ?? "管理员" },
    !!delivery.reason && { label: "重发理由", value: delivery.reason },
  ];
}

const attemptTones = {
  ACKNOWLEDGED: "success",
  RETRYABLE_FAILURE: "danger",
  PERMANENT_FAILURE: "danger",
  STARTED: "muted",
  OUTCOME_UNKNOWN: "muted",
} as const;

/** Attempts newest first, each titled with its number and what came back. */
export function attemptEntries(attempts: readonly WebhookAttempt[]): TimelineEntry[] {
  return [...attempts]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.attempt_number - a.attempt_number || b.attempt_id.localeCompare(a.attempt_id))
    .map(attempt => ({
      id: attempt.attempt_id,
      title: "第 " + attempt.attempt_number + " 次 · " + attemptResult(attempt),
      time: attempt.started_at,
      tone: attemptTones[attempt.outcome],
      ...(attempt.outcome === "RETRYABLE_FAILURE" || attempt.outcome === "PERMANENT_FAILURE" ? { body: label(attempt.outcome) } : {}),
    }));
}
