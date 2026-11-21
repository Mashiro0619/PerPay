import { useEffect, useRef } from "react";
import { useQuery } from "@/lib/workspace-query";
import { useWorkspaceApi } from "@/workspace";
import { result, type OrderWebhookDeliveryDetail } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { attemptResult } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { refreshNotificationProjections } from "@/lib/record-refresh";
import { CursorPagination } from "@/components/cursor-pagination";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList } from "@/components/record/FieldList";
import { Section } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { Timeline } from "@/components/record/Timeline";
import { attemptEntries, deliveryAdvice, deliveryFields, deliveryPhrase, deliveryState, DeliveryStatus, useRedelivery, useRetryDelivery } from "./NotificationEvidence";
import type { DatedTechnicalEntry } from "@/components/record/ActionBar";

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
    refetchInterval: state => state.state.data?.data.some(item => item.delivery.status === "LEASED") ? 1_500 : false,
  });
  const deliveries = query.data?.data ?? [];
  const statusSignature = deliveries.map(item => `${item.delivery.delivery_id}:${item.delivery.status}`).join(",");
  const previousStatuses = useRef<{ orderId: string; statuses: Map<string, string> }>({ orderId, statuses: new Map() });
  useEffect(() => {
    const prior = previousStatuses.current.orderId === orderId ? previousStatuses.current.statuses : new Map<string, string>();
    const next = new Map<string, string>();
    const changed: string[] = [];
    for (const item of deliveries) {
      const id = item.delivery.delivery_id;
      const status = item.delivery.status;
      next.set(id, status);
      const oldStatus = prior.get(id);
      if (oldStatus && oldStatus !== status) changed.push(id);
    }
    previousStatuses.current = { orderId, statuses: next };
    if (changed.length > 0) {
      void refreshNotificationProjections(orderId, { excludeOrderNotifications: true, deliveryIds: changed });
    }
  }, [orderId, statusSignature]);
  // A count is only true when this page holds every delivery.
  const complete = !!query.data && pagination.page === 1 && !query.data.page.next_cursor;
  return { query, pagination, deliveries, count: complete ? query.data!.data.length : undefined };
}

/** One delivery of an order event: its result once, in the badge, then the address and each attempt. */
function OrderDeliveryRecord({ detail }: { detail: OrderWebhookDeliveryDetail }) {
  const redelivery = useRedelivery(detail);
  const retry = useRetryDelivery(detail);
  const { confirmationRevoked, retryable, resendable } = deliveryState(detail);
  const advice = deliveryAdvice(detail, detail.attempts);
  const actions = retryable
    ? [{ label: retry.pending ? "正在重试…" : "立即重试", disabled: retry.pending, onSelect: retry.run }]
    : resendable
      ? [{ label: "重新发送", disabled: redelivery.sent, onSelect: redelivery.open }]
      : [];
  return <SubRecord title={label(detail.event.event_type)}
    status={<DeliveryStatus detail={detail} />}
    description={confirmationRevoked ? deliveryPhrase(detail) : undefined}
    href={"/notifications/" + detail.delivery.delivery_id}
    actions={actions}
    actionsLabel="更多操作，通知记录操作">
    {advice && <div className="text-[0.8125rem] leading-5 text-muted-foreground">{advice}</div>}
    <FieldList items={deliveryFields(detail, detail.attempts)} />
    <Timeline label={"发送记录（" + detail.attempts.length + "）"} entries={attemptEntries(detail.attempts)} initial={3} empty={attemptResult(undefined)} />
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
  const none = pagination.page > 1 ? "此页暂无发送记录" : notifyUrl ? "此订单已设置通知地址，暂无发送记录" : "此订单未设置通知地址";
  return <Section id="notifications" title="通知" {...(count ? { count } : {})} empty={count === 0 && !query.error ? none : undefined}>
    <ErrorNotice scope="page" error={query.error} retainedData={!!query.data} retry={() => { void query.refetch(); }}
      placeholder="通知结果读取失败，请刷新重试。" />
    {query.isPending ? <Loading label="正在读取通知结果…" /> : query.data && <>
      {current.map(detail => <OrderDeliveryRecord key={detail.delivery.delivery_id} detail={detail} />)}
      {!deliveries.length && <p className="text-[0.8125rem] leading-5 text-muted-foreground">{none}</p>}
      {superseded.length > 0 && <Disclosure label="历史发送记录" count={superseded.length}>
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
    identifiers: [["网站 ID", detail.target.api_client_id], ["通知编号", detail.delivery.delivery_id], ["事件编号", detail.event.event_id]],
  }));
}
