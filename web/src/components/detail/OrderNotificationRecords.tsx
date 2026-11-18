import { useQuery } from "@/lib/workspace-query";
import { useWorkspaceApi } from "@/workspace";
import { Link } from "@/navigation";
import { result, type OrderWebhookDeliveryDetail } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { attemptResult, latestAttempt, notificationErrorName, notificationRecoveryHint } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { CursorPagination } from "@/components/cursor-pagination";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList } from "@/components/record/FieldList";
import { Section } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime, Timeline, type TimelineEntry } from "@/components/record/Timeline";
import { useRedelivery } from "./NotificationEvidence";
import type { DatedTechnicalEntry } from "./OrderPaymentRecords";

/** One page of the order's deliveries. The record reads it once for its section, navigation and technical data. */
export function useOrderNotifications(orderId: string) {
  const api = useWorkspaceApi();
  const pagination = useCursor("notifications_cursor");
  const query = useQuery({
    queryKey: ["order-notifications", orderId, pagination.cursor],
    queryFn: ({ signal }) => result(api.listAdministratorOrderWebhookDeliveries({
      path: { orderId },
      signal,
      query: { limit: 10, ...(pagination.cursor ? { cursor: pagination.cursor } : {}) },
    })),
  });
  // A count is only true when this page holds every delivery.
  const complete = !!query.data && pagination.page === 1 && !query.data.page.next_cursor;
  return { query, pagination, deliveries: query.data?.data ?? [], count: complete ? query.data!.data.length : undefined };
}

const attemptTones = {
  ACKNOWLEDGED: "success",
  RETRYABLE_FAILURE: "danger",
  PERMANENT_FAILURE: "danger",
  STARTED: "muted",
  OUTCOME_UNKNOWN: "muted",
} as const;

/** One delivery of an order event: its result once, in the badge, then the address and each attempt. */
function OrderDeliveryRecord({ detail }: { detail: OrderWebhookDeliveryDetail }) {
  const redelivery = useRedelivery(detail);
  const delivery = detail.delivery;
  const last = latestAttempt(detail.attempts);
  const confirmationRevoked = detail.redelivery_blocked_reason === "payment_confirmation_revoked" ||
    delivery.last_error_code === "payment_confirmation_revoked";
  const terminal = delivery.status === "ACKNOWLEDGED" || delivery.status === "DEAD_LETTER";
  const terminated = confirmationRevoked && delivery.status !== "ACKNOWLEDGED";
  const attempts: TimelineEntry[] = [...detail.attempts]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.attempt_number - a.attempt_number || b.attempt_id.localeCompare(a.attempt_id))
    .map(attempt => ({
      id: attempt.attempt_id,
      title: "第 " + attempt.attempt_number + " 次 · " + attemptResult(attempt),
      time: attempt.started_at,
      tone: attemptTones[attempt.outcome],
      ...(attempt.outcome === "RETRYABLE_FAILURE" || attempt.outcome === "PERMANENT_FAILURE" ? { body: label(attempt.outcome) } : {}),
    }));
  return <SubRecord title={label(detail.event.event_type)}
    status={<StatusBadge value={terminated ? "REVERSED" : delivery.status} label={terminated ? "已终止" : undefined} />}
    description={confirmationRevoked ? delivery.status === "ACKNOWLEDGED" ? "对方已返回有效确认回执；原付款确认现已撤销" : "原付款确认已撤销，成功通知已终止" : undefined}
    href={"/notifications/" + delivery.delivery_id}
    actions={detail.is_latest && terminal ? [{ label: "重新发送", disabled: redelivery.sent || confirmationRevoked, onSelect: redelivery.open }] : []}
    actionsLabel="更多操作，通知记录操作">
    {confirmationRevoked
      ? <p className="text-[0.8125rem] leading-5 text-muted-foreground">{notificationRecoveryHint("payment_confirmation_revoked")}</p>
      : detail.is_latest && ["DEAD_LETTER", "RETRY_WAIT"].includes(delivery.status) && <p className="text-[0.8125rem] leading-5 text-muted-foreground">
        {notificationRecoveryHint(delivery.last_error_code ?? last?.error_code ?? null)}{" "}
        <a data-external-link className="underline underline-offset-4" href="https://github.com/Mashiro0619/PerPay/blob/main/USAGE.md#5-回调通知" target="_blank" rel="noopener noreferrer">通知接入说明</a>
      </p>}
    <FieldList items={[
      { label: "通知地址", kind: "id", value: detail.target.target_url, copy: detail.target.target_url },
      !detail.is_latest && !!detail.latest_delivery_id && { label: "后续结果", value: <Link className="underline underline-offset-4" to={"/notifications/" + detail.latest_delivery_id}>已重新发送，查看最新结果</Link> },
      !!delivery.predecessor_delivery_id && { label: "原投递", value: <Link className="underline underline-offset-4" to={"/notifications/" + delivery.predecessor_delivery_id}>查看原投递</Link> },
      !!delivery.next_attempt_at && !terminal && !confirmationRevoked && { label: "下次重试", kind: "time", value: <RecordTime value={delivery.next_attempt_at} /> },
      !!delivery.acknowledged_at && { label: "通知确认时间（PerPay 记录）", kind: "time", value: <RecordTime value={delivery.acknowledged_at} /> },
      !!delivery.last_error_code && delivery.last_error_code !== last?.error_code && { label: "最近错误", value: notificationErrorName(delivery.last_error_code) },
      delivery.requested_by_type === "ADMIN" && { label: "发起人", value: delivery.requested_by_actor_id ?? "管理员" },
      !!delivery.reason && { label: "重发理由", value: delivery.reason },
    ]} />
    <Timeline label={"投递尝试（" + attempts.length + "）"} entries={attempts} initial={3} empty={attemptResult(undefined)} />
    {redelivery.dialog}
  </SubRecord>;
}

/**
 * The order's notification section. The current delivery of each event stays
 * in view; deliveries replaced by a resend are collapsed.
 */
export function OrderNotificationsSection({ notifications, notifyUrl }: {
  notifications: ReturnType<typeof useOrderNotifications>;
  notifyUrl: string | null;
}) {
  const { query, pagination, deliveries, count } = notifications;
  const current = deliveries.filter(detail => detail.is_latest);
  const superseded = deliveries.filter(detail => !detail.is_latest);
  const none = pagination.page > 1 ? "此页暂无投递记录" : notifyUrl ? "此订单已设置通知地址，暂无发送记录" : "此订单未设置通知地址";
  return <Section id="notifications" title="通知" {...(count ? { count } : {})} empty={count === 0 && !query.error ? none : undefined}>
    <ErrorNotice scope="page" error={query.error} retry={() => { void query.refetch(); }} />
    {query.isPending ? <Loading label="正在读取通知结果…" /> : query.data && <>
      {current.map(detail => <OrderDeliveryRecord key={detail.delivery.delivery_id} detail={detail} />)}
      {!deliveries.length && <p className="text-[0.8125rem] leading-5 text-muted-foreground">{none}</p>}
      {superseded.length > 0 && <Disclosure label="历史投递" count={superseded.length}>
        {superseded.map(detail => <OrderDeliveryRecord key={detail.delivery.delivery_id} detail={detail} />)}
      </Disclosure>}
      <CursorPagination
        previousLabel={pagination.previousLabel}
        page={pagination.page}
        count={deliveries.length}
        hasNext={!!query.data.page.next_cursor}
        pending={query.isFetching}
        onPrevious={pagination.previous}
        onNext={() => pagination.next(query.data.page.next_cursor)}
      />
    </>}
  </Section>;
}

/** Raw data of the deliveries on the page being shown. */
export function notificationTechnical(deliveries: readonly OrderWebhookDeliveryDetail[]): DatedTechnicalEntry[] {
  return deliveries.map(detail => ({
    id: "delivery-" + detail.delivery.delivery_id, title: "通知技术信息", created: detail.delivery.created_at, data: detail,
    identifiers: [["网站编号", detail.target.api_client_id], ["投递编号", detail.delivery.delivery_id], ["事件编号", detail.event.event_id]],
  }));
}
