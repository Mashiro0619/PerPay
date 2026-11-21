import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { result, type WebhookAttempt, type WebhookDeliveryDetail } from "@/api/client";
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

type DeliveryContext = WebhookDeliveryDetail & {
  attempts: readonly WebhookAttempt[];
};
/** The redelivery confirmation and the call that opens it; a created delivery is opened afterwards. */
export function useRedelivery(detail: DeliveryContext) {
  const api = useWorkspaceApi();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<DeliveryContext | null>(null);
  const [sent, setSent] = useState(false);
  const [newDeliveryId, setNewDeliveryId] = useState<string | null>(null);
  useEffect(() => {
    if (newDeliveryId) navigate("/notifications/" + newDeliveryId);
  }, [newDeliveryId, navigate]);
  const setMessage = useSuccessToast();
  const finalFocus = useRef<HTMLElement | null>(null);
  const open = (trigger: HTMLElement | null) => {
    finalFocus.current = trigger;
    setSnapshot(detail);
  };
  const dialog = snapshot && (
        <ReasonDialog
          finalFocus={() => finalFocus.current}
          title="重新发送通知"
          description="再次发送同一事件，业务方需避免重复处理。"
          action="确认重新发送"
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
            void refreshNotificationRecords(detail.event.order_id, detail.delivery.delivery_id);
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
export function useRetryDelivery(detail: WebhookDeliveryDetail) {
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
    if (inflight.current) return;
    inflight.current = true;
    setPending(true);
    void result(
      api.retryWebhookDelivery({
        path: { deliveryId: detail.delivery.delivery_id },
        body: {},
      }),
    ).then(
      () => {
        setSuccess("已发起立即重试");
        void refreshNotificationRecords(detail.event.order_id, detail.delivery.delivery_id);
      },
      (error: unknown) => {
        setError(error instanceof Error && error.message ? error.message : "立即重试失败，请刷新后重试");
        void refreshNotificationRecords(detail.event.order_id, detail.delivery.delivery_id);
      },
    ).finally(() => {
      inflight.current = false;
      if (mounted.current) setPending(false);
    });
  };
  return { pending, run };
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

/** One sentence on where the delivery stands. */
export function deliveryPhrase(detail: WebhookDeliveryDetail): string {
  const status = detail.delivery.status;
  if (deliveryState(detail).confirmationRevoked) return status === "ACKNOWLEDGED" ? "对方已返回有效确认回执；原付款确认现已撤销" : "原付款确认已撤销，成功通知已终止";
  if (!detail.is_latest) return status === "ACKNOWLEDGED" ? "历史发送 · 对方已返回有效确认回执" : "历史发送";
  if (status === "DEAD_LETTER") return "已停止重试，需要处理";
  if (status === "RETRY_WAIT") return "等待自动重试";
  if (status === "ACKNOWLEDGED") return "对方已返回有效确认回执";
  return "等待发送结果";
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
export function deliveryFields(detail: WebhookDeliveryDetail, attempts: readonly WebhookAttempt[], { schedule = true }: { schedule?: boolean } = {}): Array<Field | false> {
  const delivery = detail.delivery;
  const { nextAttemptAt } = deliveryState(detail);
  return [
    { label: "通知地址", kind: "id", value: detail.target.target_url, copy: detail.target.target_url },
    !detail.is_latest && !!detail.latest_delivery_id && { label: "后续结果", value: <Link className="underline underline-offset-4" to={"/notifications/" + detail.latest_delivery_id}>已重新发送，查看最新结果</Link> },
    !!delivery.predecessor_delivery_id && { label: "原通知", value: <Link className="underline underline-offset-4" to={"/notifications/" + delivery.predecessor_delivery_id}>查看原通知</Link> },
    schedule && !!nextAttemptAt && { label: nextAttemptLabel(detail), kind: "time", value: <RecordTime value={nextAttemptAt} /> },
    // The business website keeps its own time of delivery; this one is PerPay's.
    !!delivery.acknowledged_at && { label: "通知确认时间", kind: "time", value: <RecordTime value={delivery.acknowledged_at} />, hint: "PerPay 收到成功回执的时间" },
    !!delivery.last_error_code && delivery.last_error_code !== latestAttempt(attempts)?.error_code && { label: "最近错误", value: notificationErrorName(delivery.last_error_code) },
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
