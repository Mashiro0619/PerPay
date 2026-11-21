import { useEffect, useRef } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useParams } from "react-router";
import { queryClient, result, type AdminOrderDetailEnvelope, type WebhookAttemptListEnvelope, type WebhookDeliveryDetail } from "@/api/client";
import { attemptResult } from "@/lib/detail-summary";
import { money } from "@/lib/format";
import { label } from "@/lib/labels";
import { refreshNotificationProjections } from "@/lib/record-refresh";
import { useQuery } from "@/lib/workspace-query";
import { Link, useDetailBack } from "@/navigation";
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { OrderStatusBadge } from "@/components/business-status";
import { DetailNavigation, DetailPage } from "@/components/detail/DetailPrimitives";
import { attemptEntries, deliveryAdvice, deliveryFields, deliveryPhrase, deliveryState, DeliveryStatus, nextAttemptLabel, useRedelivery, useRetryDelivery } from "@/components/detail/NotificationEvidence";
import { OverlaySummary } from "@/components/overlay-actions";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { ActionBar } from "@/components/record/ActionBar";
import { FieldList } from "@/components/record/FieldList";
import { RecordNotice, RecordSummary } from "@/components/record/RecordSummary";
import { Section, Sections } from "@/components/record/Sections";
import { SubRecord } from "@/components/record/SubRecord";
import { RecordTime, Timeline } from "@/components/record/Timeline";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading, QueryView } from "@/components/request-state";

export default function NotificationDetail() {
  const { deliveryId = "" } = useParams();
  return <DeliveryDetail key={deliveryId} deliveryId={deliveryId} />;
}

function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const api = useWorkspaceApi();
  const back = useDetailBack("/notifications", "通知");
  const delivery = useQuery({
    queryKey: ["notification", deliveryId],
    queryFn: ({ signal }) => result(api.getWebhookDelivery({ path: { deliveryId }, signal })),
    refetchInterval: query => {
      const status = query.state.data?.data.delivery.status;
      return status === "LEASED" ? 1_500 : status && ["PENDING", "RETRY_WAIT"].includes(status) ? 5_000 : false;
    },
  });
  // Read again whenever the delivery reports another attempt or a new status.
  const attempts = useQuery({
    queryKey: ["notification-attempts", deliveryId, delivery.data?.data.delivery.attempt_count, delivery.data?.data.delivery.status],
    enabled: delivery.isSuccess,
    queryFn: ({ signal }) => result(api.listWebhookDeliveryAttempts({ path: { deliveryId }, signal })),
  });
  const orderId = delivery.data?.data.event.order_id;
  const deliveryStatus = delivery.data?.data.delivery.status;
  const previousStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!deliveryStatus || !orderId) return;
    const prior = previousStatus.current;
    previousStatus.current = deliveryStatus;
    if (prior && prior !== deliveryStatus) {
      void refreshNotificationProjections(orderId);
    }
  }, [deliveryStatus, orderId]);
  // The order the notification reports on is read separately: when that fails, the delivery and its attempts stay readable.
  const order = useQuery({
    queryKey: ["order", orderId],
    enabled: !!orderId,
    queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId: orderId! }, signal })),
  });
  const refreshing = delivery.isFetching || attempts.isFetching || order.isFetching;
  return <DetailPage>
    <PageHeading title={delivery.data ? label(delivery.data.data.event.event_type) : "通知详情"} />
    <DetailNavigation back={back}>
      <PageHeaderActions><RefreshButton disabled={refreshing} busy={refreshing} onClick={() => {
        void delivery.refetch();
        void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes("notification-attempts") && query.queryKey.includes(deliveryId) });
        if (orderId) void order.refetch();
      }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={delivery}>{({ data }) => <DeliveryRecord detail={data} attempts={attempts} order={order} />}</QueryView>
  </DetailPage>;
}

function DeliveryRecord({ detail, attempts, order }: {
  detail: WebhookDeliveryDetail;
  attempts: UseQueryResult<WebhookAttemptListEnvelope, Error>;
  order: UseQueryResult<AdminOrderDetailEnvelope, Error>;
}) {
  const { clientId } = useWorkspace();
  const delivery = detail.delivery;
  const made = attempts.data?.data ?? [];
  const redelivery = useRedelivery({ ...detail, attempts: made });
  const retry = useRetryDelivery(detail);
  const { confirmationRevoked, retryable, resendable, nextAttemptAt } = deliveryState(detail);
  const advice = deliveryAdvice(detail, made);
  const site = detail.target.site_name ?? "业务网站名称暂不可用";
  // Until the attempts are read, the delivery's own counter says how many there are.
  const total = attempts.data ? made.length : delivery.attempt_count;
  const count = total > 0 ? { count: total } : {};
  return <>
    <OverlaySummary>
      <RecordSummary label="通知状态" size="phrase" value={deliveryPhrase(detail, made)} status={<DeliveryStatus detail={detail} />}
        meta={[<>
          已尝试 {delivery.attempt_count} 次
          {!!nextAttemptAt && <> · {nextAttemptLabel(detail)} <RecordTime value={nextAttemptAt} /></>}
        </>]}
        nav={[
          { id: "overview", label: "通知信息" },
          { id: "attempts", label: "发送记录", ...count },
          { id: "order", label: "关联订单" },
        ]} />
    </OverlaySummary>
    {advice && <RecordNotice tone={delivery.status === "DEAD_LETTER" && !confirmationRevoked ? "danger" : "warning"}
      {...(confirmationRevoked ? { jump: { to: "/orders/" + detail.event.order_id, label: "查看订单当前状态" } } : {})}>
      {advice}
    </RecordNotice>}
    <Sections label="通知详情内容">
      <Section id="overview" title="通知信息">
        <FieldList items={[
          !clientId && { label: "业务网站", value: <Link global className="underline underline-offset-4" aria-label={site + " · " + detail.target.api_client_id}
            to={"/sites/" + encodeURIComponent(detail.target.api_client_id) + "/summary"}>{site}</Link> },
          // The summary already states when the next attempt is due.
          ...deliveryFields(detail, made, { schedule: false }),
          { label: "创建时间", kind: "time", value: <RecordTime value={delivery.created_at} /> },
        ]} />
      </Section>
      <Section id="attempts" title="发送记录" {...count} empty={attempts.data && !made.length ? attemptResult(undefined) : undefined}>
        <ErrorNotice scope="page" error={attempts.error} retainedData={!!attempts.data} retry={() => { void attempts.refetch(); }}
          placeholder="发送记录读取失败，请刷新重试。" />
        {attempts.data
          ? <Timeline label="发送记录" entries={attemptEntries(made)} initial={10} moreLabel="更早的记录" />
          : !attempts.error && <Loading label="正在读取发送记录…" />}
      </Section>
      <RelatedOrder query={order} />
    </Sections>
    <ActionBar menuLabel="更多操作，通知记录操作"
      primary={
        (retryable && { label: retry.pending ? "正在重试…" : "立即重试", disabled: retry.pending, onSelect: retry.run }) ||
        (resendable && delivery.status === "DEAD_LETTER" && { label: "重新发送", disabled: redelivery.sent, onSelect: redelivery.open })
      }
      // Sending a confirmed notification again is rare, so it stays out of the way.
      menu={resendable && delivery.status === "ACKNOWLEDGED" ? [{ label: "重新发送", disabled: redelivery.sent, onSelect: redelivery.open }] : []}
      technical={[{ title: "通知技术信息", data: { ...detail, attempts: made }, identifiers: [
        ["网站 ID", detail.target.api_client_id], ["通知编号", delivery.delivery_id], ["事件编号", detail.event.event_id],
        ["内部订单编号", detail.event.order_id], ["回调地址编号", detail.target.target_id], ["原通知编号", delivery.predecessor_delivery_id],
      ] }]} />
    {redelivery.dialog}
  </>;
}

/** The order the notification reports on. */
function RelatedOrder({ query }: { query: UseQueryResult<AdminOrderDetailEnvelope, Error> }) {
  const order = query.data?.data;
  return <Section id="order" title="关联订单">
    {query.isPending && <Loading label="正在读取关联订单…" />}
    <ErrorNotice scope="page" error={query.error} retainedData={!!order} retry={() => { void query.refetch(); }}
      placeholder="关联订单读取失败，请刷新重试。" />
    {order && <SubRecord title={order.product_name} href={"/orders/" + order.order_id} hrefLabel="查看订单"
      status={<OrderStatusBadge payment={order.payment.status} checkout={order.checkout.status} refundMarked={order.refund_mark.marked} />}>
      <FieldList items={[
        { label: "商户订单号", kind: "id", value: order.merchant_order_no, copy: order.merchant_order_no },
        { label: "应付金额", kind: "money", value: money(order.payable_amount_cents) },
        { label: "实收金额", kind: "money", value: money(order.received_amount_cents) },
        { label: "创建时间", kind: "time", value: <RecordTime value={order.created_at} /> },
      ]} />
    </SubRecord>}
  </Section>;
}
