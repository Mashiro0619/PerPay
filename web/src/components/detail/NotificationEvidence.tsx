import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { Button } from "@/components/ui/button";
import { SiteIdentity } from "@/components/site-identity";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Link, useNavigate } from "@/navigation";

import { result, type WebhookDeliveryDetail, type WebhookAttempt } from "@/api/client";
import { refreshNotificationRecords } from "@/lib/record-refresh";
import { useOverlayContext } from "@/lib/overlay-context";
import {
  attemptResult,
  latestAttempt,
  notificationErrorName,
  notificationRecoveryHint,
} from "@/lib/detail-summary";
import { dateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice } from "@/components/request-state";
import { ReasonDialog } from "@/components/ReasonDialog";
import { useSuccessToast } from "@/components/Feedback";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { DetailFields, TechnicalDetails } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
import { DeliveryAttempts } from "./DeliveryAttempts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Field } from "@/components/record/FieldList";
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
            setMessage("已创建新投递，等待发送");
            void refreshNotificationRecords(detail.event.order_id, detail.delivery.delivery_id);
          }}
        >
          <DetailFields
            wide={["通知地址"]}
            items={[
              ["事件", label(snapshot.event.event_type)],
              ["通知地址", snapshot.target.target_url],
            ]}
          />
        </ReasonDialog>
  );
  return { sent, open, dialog };
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
  if (!detail.is_latest) return status === "ACKNOWLEDGED" ? "历史投递 · 对方已返回有效确认回执" : "历史投递";
  if (status === "DEAD_LETTER") return "已停止重试，需要处理";
  if (status === "RETRY_WAIT") return "等待自动重试";
  if (status === "ACKNOWLEDGED") return "对方已返回有效确认回执";
  return "等待投递结果";
}

/** What to do about a delivery that failed or was ended; nothing when it needs no action. */
export function deliveryAdvice(detail: WebhookDeliveryDetail, attempts: readonly WebhookAttempt[]) {
  if (deliveryState(detail).confirmationRevoked) return notificationRecoveryHint("payment_confirmation_revoked");
  if (!detail.is_latest || !["DEAD_LETTER", "RETRY_WAIT"].includes(detail.delivery.status)) return null;
  return <>
    {notificationRecoveryHint(detail.delivery.last_error_code ?? latestAttempt(attempts)?.error_code ?? null)}{" "}
    <a data-external-link className="underline underline-offset-4" href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md#5-回调通知" target="_blank" rel="noopener noreferrer">通知接入说明</a>
  </>;
}

/** A delivery not attempted yet is scheduled; one that failed is waiting to be retried. */
export function nextAttemptLabel(detail: WebhookDeliveryDetail) {
  return detail.delivery.status === "RETRY_WAIT" ? "下次重试" : "计划投递";
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
    !!delivery.predecessor_delivery_id && { label: "原投递", value: <Link className="underline underline-offset-4" to={"/notifications/" + delivery.predecessor_delivery_id}>查看原投递</Link> },
    schedule && !!nextAttemptAt && { label: nextAttemptLabel(detail), kind: "time", value: <RecordTime value={nextAttemptAt} /> },
    !!delivery.acknowledged_at && { label: "通知确认时间（PerPay 记录）", kind: "time", value: <RecordTime value={delivery.acknowledged_at} /> },
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

export function DeliveryCard({
  detail,
  embedded = false,
  attemptsAvailable = true,
  sectionTitle,
  density = "default",
  attemptsError,
  retryAttempts,
  section = "all",
}: {
  detail: DeliveryContext;
  embedded?: boolean;
  attemptsAvailable?: boolean;
  sectionTitle?: string;
  density?: "default" | "comfortable";
  attemptsError?: unknown;
  retryAttempts?: (() => void) | undefined;
  section?: "all" | "overview" | "attempts";
}) {
  const { clientId } = useWorkspace();
  const overlay = useOverlayContext();
  const { sent, open, dialog: confirmation } = useRedelivery(detail);
  const delivery = detail.delivery;
  const last = latestAttempt(detail.attempts);
  const confirmationRevoked = detail.redelivery_blocked_reason === "payment_confirmation_revoked" ||
    delivery.last_error_code === "payment_confirmation_revoked";
  const terminal =
    delivery.status === "ACKNOWLEDGED" || delivery.status === "DEAD_LETTER";
  const terminated = confirmationRevoked && delivery.status !== "ACKNOWLEDGED";
  const comfortable = density === "comfortable" && !embedded;
  const statusDescription = confirmationRevoked
    ? delivery.status === "ACKNOWLEDGED"
      ? "对方已返回有效确认回执；原付款确认现已撤销"
      : "原付款确认已撤销，成功通知已终止"
    : !detail.is_latest
    ? delivery.status === "ACKNOWLEDGED" ? "历史投递 · 对方已返回有效确认回执" : "历史投递"
    : delivery.status === "DEAD_LETTER"
      ? "已停止重试，需要处理"
      : delivery.status === "RETRY_WAIT"
        ? "等待自动重试"
        : delivery.status === "ACKNOWLEDGED"
          ? "对方已返回有效确认回执"
          : "等待投递结果";
  const attemptDescription = attemptsAvailable
    ? delivery.attempt_count === 0
      ? attemptResult(undefined)
      : "投递尝试按时间倒序显示"
    : attemptsError ? "发送记录读取失败" : "正在读取发送记录";
  const attemptsReadState = attemptsError ? "failed" : "loading";
  const resend = detail.is_latest && delivery.status === "DEAD_LETTER" && (
    <Button
      variant="outline"
      className="w-fit"
      disabled={sent || confirmationRevoked}
      onClick={(event) => open(event.currentTarget)}
    >
      重新发送
    </Button>
  );
  const technicalIdentifiers = [
    ["网站编号", detail.target.api_client_id],
    ["投递编号", delivery.delivery_id],
    ["事件编号", detail.event.event_id],
    ...(comfortable ? [
      ["内部订单编号", detail.event.order_id],
      ["通知目标编号", detail.target.target_id],
      ["前次投递编号", delivery.predecessor_delivery_id],
    ] as const : []),
  ] as const;
  const technicalInformation = overlay && <TechnicalDetails title="通知技术信息" data={detail} identifiers={technicalIdentifiers} />;
  const tools = (
    <RecordTools
      inline={comfortable}
      label="通知记录操作"
      data={detail}
      technical={!overlay}
      identifiers={technicalIdentifiers}
      to={embedded ? "/notifications/" + delivery.delivery_id : undefined}
      actions={
        delivery.status === "ACKNOWLEDGED" && detail.is_latest
          ? [
              {
                label: "重新发送",
                disabled: sent || confirmationRevoked,
                onSelect: open,
              },
            ]
          : []
      }
    />
  );
  const siteFields = !clientId
    ? [["所属网站", comfortable
      ? <Link global to={"/sites/" + encodeURIComponent(detail.target.api_client_id) + "/summary"} aria-label={(detail.target.site_name ?? "业务网站名称暂不可用") + " · " + detail.target.api_client_id}>{detail.target.site_name ?? "业务网站名称暂不可用"}</Link>
      : <SiteIdentity clientId={detail.target.api_client_id} name={detail.target.site_name} />] as const]
    : [];
  const targetField = [
    "通知地址",
    <CopyValue value={detail.target.target_url} label="复制通知地址" />,
  ] as const;
  const deliveryFields = [
    ...(!detail.is_latest && detail.latest_delivery_id
      ? [["后续结果", <Link to={"/notifications/" + detail.latest_delivery_id}>已重新发送，查看最新结果</Link>] as const]
      : []),
    ...(delivery.predecessor_delivery_id
      ? [["原投递", <Link to={"/notifications/" + delivery.predecessor_delivery_id}>查看原投递</Link>] as const]
      : []),
    ...(delivery.next_attempt_at && !terminal && !confirmationRevoked
      ? [["下次重试", dateTime(delivery.next_attempt_at)] as const]
      : []),
    ...(delivery.acknowledged_at
      ? [["通知确认时间（PerPay 记录）", dateTime(delivery.acknowledged_at)] as const]
      : []),
    ...(delivery.last_error_code && delivery.last_error_code !== last?.error_code
      ? [["最近错误", notificationErrorName(delivery.last_error_code)] as const]
      : []),
    ...(delivery.requested_by_type === "ADMIN"
      ? [["发起人", delivery.requested_by_actor_id ?? "管理员"] as const]
      : []),
  ];
  const reasonFields = delivery.reason
    ? [["重发理由", delivery.reason] as const]
    : [];
  const recovery = confirmationRevoked ? (
    <>
      {notificationRecoveryHint("payment_confirmation_revoked")}{" "}
      <Link to={"/orders/" + detail.event.order_id}>查看订单当前状态</Link>
    </>
  ) : detail.is_latest && ["DEAD_LETTER", "RETRY_WAIT"].includes(delivery.status) && (
    <>
      {notificationRecoveryHint(delivery.last_error_code ?? last?.error_code ?? null)}{" "}
      <a
        data-external-link
        className="underline underline-offset-4"
        href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md#5-回调通知"
        target="_blank"
        rel="noopener noreferrer"
      >
        通知接入说明
      </a>
    </>
  );
  if (comfortable) return <>
    {section !== "attempts" && <Card aria-label="通知信息" className="detail-section" data-notification-information>
      <CardHeader className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-3 gap-y-1" data-notification-summary>
          <div className="flex min-w-0 flex-wrap items-center gap-2" data-detail-summary>
            <CardTitle role="heading" aria-level={2}>{sectionTitle ?? "通知信息"}</CardTitle>
            <StatusBadge value={terminated ? "REVERSED" : delivery.status} label={terminated ? "已终止" : undefined} />
          </div>
          <CardDescription>{statusDescription}</CardDescription>
          <CardDescription className="whitespace-nowrap">已尝试 {delivery.attempt_count} 次</CardDescription>
        </div>
        {(!overlay || (detail.is_latest && terminal)) && <CardAction className="flex max-w-full flex-wrap items-center justify-end gap-2">
          {resend}
          {tools}
        </CardAction>}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {recovery && <Alert><Info /><AlertTitle>通知投递建议</AlertTitle><AlertDescription>{recovery}</AlertDescription></Alert>}
        <DetailFields
          density="comfortable"
          layout="flow"
          wide={["通知地址", "重发理由"]}
          items={[
            ["通知事件", label(detail.event.event_type)],
            ...siteFields,
            ...deliveryFields,
            targetField,
            ...reasonFields,
          ]}
        />
        {technicalInformation}
      </CardContent>
    </Card>}
    {section !== "overview" && <Card aria-label="投递历史" className="detail-section" data-notification-history>
      <CardHeader className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-notification-history-heading>
        <CardTitle role="heading" aria-level={2}>投递历史</CardTitle>
        <CardDescription>{attemptDescription}{attemptsAvailable && detail.attempts.length > 0 ? " · 每页 10 条" : ""}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <ErrorNotice scope="page" error={attemptsError} retry={retryAttempts} />
        <DeliveryAttempts key={delivery.delivery_id} attempts={detail.attempts} available={attemptsAvailable} readState={attemptsReadState} density="comfortable" pageKey={"attempts_" + delivery.delivery_id} showHeading={false} />
      </CardContent>
    </Card>}
    {confirmation}
  </>;
  return (
    <Card size={embedded ? "sm" : "default"} data-density="compact" aria-label="通知记录">
      <CardHeader>
        <CardTitle className="record-list-title" role="heading" aria-level={2}>
          {sectionTitle ?? label(detail.event.event_type)}
        </CardTitle>
        <CardDescription className="record-list-meta">{statusDescription}</CardDescription>
        <CardDescription className="record-list-meta">{attemptDescription} · 已尝试 {delivery.attempt_count} 次</CardDescription>
        <CardAction><StatusBadge value={terminated ? "REVERSED" : delivery.status} label={terminated ? "已终止" : undefined} /></CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {recovery && <p className="text-sm text-muted-foreground">{recovery}</p>}
        {resend}
        <DetailFields wide={["所属网站", "通知地址", "重发理由"]} items={[...siteFields, targetField, ...deliveryFields, ...reasonFields]} />
        <DeliveryAttempts key={delivery.delivery_id} attempts={detail.attempts} available={attemptsAvailable} readState={attemptsReadState} pageKey={"attempts_" + delivery.delivery_id} />
        {tools}
        {technicalInformation}
      </CardContent>
      {confirmation}
    </Card>
  );
}
