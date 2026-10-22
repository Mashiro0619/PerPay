import { useQuery } from '@/lib/workspace-query';
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { Button } from "@/components/ui/button";
import { SiteIdentity } from "@/components/site-identity";
import { useRef, useState } from "react";
import { Info } from "lucide-react";
import { Link } from "@/navigation";

import { refreshOperationalData, result, type OrderWebhookDeliveryDetail, type WebhookDeliveryDetail, type WebhookAttempt } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import {
  attemptResult,
  latestAttempt,
  notificationErrorName,
  notificationRecoveryHint,
} from "@/lib/detail-summary";
import { dateTime } from "@/lib/format";
import { ListDateTime, ListIdentity } from "@/components/list-primitives";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, Loading } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
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
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { DetailFields } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
import { DeliveryAttempts } from "./DeliveryAttempts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
type DeliveryContext = WebhookDeliveryDetail & {
  attempts: readonly WebhookAttempt[];
};
export function DeliveryCard({
  detail,
  embedded = false,
  attemptsAvailable = true,
  sectionTitle,
  density = "default",
  attemptsError,
  retryAttempts,
}: {
  detail: DeliveryContext;
  embedded?: boolean;
  attemptsAvailable?: boolean;
  sectionTitle?: string;
  density?: "default" | "comfortable";
  attemptsError?: unknown;
  retryAttempts?: (() => void) | undefined;
}) {
  const api = useWorkspaceApi();
  const { clientId } = useWorkspace();
  const [snapshot, setSnapshot] = useState<DeliveryContext | null>(null);
  const [sent, setSent] = useState(false);
  const setMessage = useSuccessToast();
  const finalFocus = useRef<HTMLElement | null>(null);
  const delivery = detail.delivery;
  const last = latestAttempt(detail.attempts);
  const terminal =
    delivery.status === "ACKNOWLEDGED" || delivery.status === "DEAD_LETTER";
  const comfortable = density === "comfortable" && !embedded;
  const statusDescription = !detail.is_latest
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
      disabled={sent}
      onClick={(event) => {
        finalFocus.current = event.currentTarget;
        setSnapshot(detail);
      }}
    >
      重新发送
    </Button>
  );
  const tools = (
    <RecordTools
      inline={comfortable}
      label="通知记录操作"
      data={detail}
      identifiers={[
        ["客户端 ID", detail.target.api_client_id],
        ["投递编号", delivery.delivery_id],
        ["事件编号", detail.event.event_id],
        ...(comfortable ? [
          ["内部订单编号", detail.event.order_id],
          ["通知目标编号", detail.target.target_id],
          ["前次投递编号", delivery.predecessor_delivery_id],
        ] as const : []),
      ]}
      to={embedded ? "/notifications/" + delivery.delivery_id : undefined}
      actions={
        delivery.status === "ACKNOWLEDGED" && detail.is_latest
          ? [
              {
                label: "重新发送",
                disabled: sent,
                onSelect: (trigger) => {
                  finalFocus.current = trigger;
                  setSnapshot(detail);
                },
              },
            ]
          : []
      }
    />
  );
  const siteFields = !clientId
    ? [["所属网站", comfortable
      ? <Link to={"/sites/" + encodeURIComponent(detail.target.api_client_id)} aria-label={(detail.target.site_name ?? "业务网站名称暂不可用") + " · " + detail.target.api_client_id}>{detail.target.site_name ?? "业务网站名称暂不可用"}</Link>
      : <SiteIdentity clientId={detail.target.api_client_id} name={detail.target.site_name} />] as const]
    : [];
  const targetField = [
    "通知地址",
    <CopyValue value={detail.target.target_url} label="复制通知地址" />,
  ] as const;
  const deliveryFields = [
    ...(delivery.next_attempt_at && !terminal
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
  const recovery = detail.is_latest && ["DEAD_LETTER", "RETRY_WAIT"].includes(delivery.status) && (
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
  const confirmation = snapshot && (
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
          onSuccess={() => {
            // A successful redelivery creates a newer record and removes this
            // action. Restore focus to content that remains on the page.
            finalFocus.current = document.getElementById("main-content");
            setSnapshot(null);
            setSent(true);
            setMessage("已创建新投递，等待发送");
            void refreshOperationalData();
          }}
        >
          <DetailFields
            items={[
              ["事件", label(snapshot.event.event_type)],
              ["通知地址", snapshot.target.target_url],
            ]}
          />
        </ReasonDialog>
  );
  if (comfortable) return <>
    <Card aria-label="通知信息" data-notification-information>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <CardTitle role="heading" aria-level={2}>{sectionTitle ?? "通知信息"}</CardTitle>
          <CardDescription>{statusDescription}</CardDescription>
        </div>
        <CardAction className="flex max-w-full flex-wrap items-center justify-end gap-2">
          <StatusBadge value={delivery.status} />
          {resend}
          {tools}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        {recovery && <Alert><Info /><AlertTitle>通知投递建议</AlertTitle><AlertDescription>{recovery}</AlertDescription></Alert>}
        <DetailFields
          density="comfortable"
          layout="flow"
          wide={["通知地址", "重发理由"]}
          items={[
            ["通知事件", label(detail.event.event_type)],
            ["尝试次数", "已尝试 " + delivery.attempt_count + " 次"],
            ...siteFields,
            ...deliveryFields,
            targetField,
            ...reasonFields,
          ]}
        />
      </CardContent>
    </Card>
    <Card aria-label="投递历史" data-notification-history>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>投递历史</CardTitle>
        <CardDescription>{attemptDescription}{attemptsAvailable && detail.attempts.length > 0 ? " · 每页 10 条" : ""}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <ErrorNotice error={attemptsError} retry={retryAttempts} />
        <DeliveryAttempts key={delivery.delivery_id} attempts={detail.attempts} available={attemptsAvailable} readState={attemptsReadState} density="comfortable" />
      </CardContent>
    </Card>
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
        <CardAction><StatusBadge value={delivery.status} /></CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {recovery && <p className="text-sm text-muted-foreground">{recovery}</p>}
        {resend}
        <DetailFields wide={["所属网站", "通知地址", "重发理由"]} items={[...siteFields, targetField, ...deliveryFields, ...reasonFields]} />
        <DeliveryAttempts key={delivery.delivery_id} attempts={detail.attempts} available={attemptsAvailable} readState={attemptsReadState} />
        {tools}
      </CardContent>
      {confirmation}
    </Card>
  );
}
export function OrderNotifications({
  orderId,
  notifyUrl,
}: {
  orderId: string;
  notifyUrl: string | null;
}) {
  const api = useWorkspaceApi();
  const pagination = useCursor();
  const query = useQuery({
    queryKey: ["order-notifications", orderId, pagination.cursor],
    queryFn: ({ signal }) =>
      result(
        api.listAdministratorOrderWebhookDeliveries({
          path: { orderId },
          signal,
          query: {
            limit: 10,
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {query.isPending ? (
        <Loading label="正在读取通知结果…" />
      ) : (
        query.data && (
          <>
            {query.data.data.length ? (
              <>
                <DeliveryCard
                  detail={query.data.data[0]!}
                  embedded
                  sectionTitle="通知"
                />
                {query.data.data.length > 1 && (
                  <Accordion className="record-list" data-density="compact">
                    {query.data.data
                      .slice(1)
                      .map((detail: OrderWebhookDeliveryDetail) => (
                        <AccordionItem
                          className="record-list-row"
                          key={detail.delivery.delivery_id}
                          value={detail.delivery.delivery_id}
                        >
                          <AccordionTrigger className="items-center gap-3 py-0">
                            <div className="min-w-0 flex-1">
                              <ListIdentity meta={<ListDateTime value={detail.delivery.created_at} inline />}>
                                <span>{label(detail.event.event_type)}</span>
                              </ListIdentity>
                            </div>
                            <StatusBadge value={detail.delivery.status} />
                          </AccordionTrigger>
                          <AccordionContent>
                            <DeliveryCard detail={detail} embedded />
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                  </Accordion>
                )}
              </>
            ) : (
              <Card size="sm">
                <CardHeader>
                  <CardTitle role="heading" aria-level={2}>
                    通知
                  </CardTitle>
                  <CardDescription>
                    {pagination.page > 1
                      ? "此页暂无投递记录"
                      : notifyUrl
                        ? "此订单已设置通知地址，暂无发送记录"
                        : "此订单未设置通知地址"}
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
            <CursorPagination
              previousLabel={pagination.previousLabel}
              page={pagination.page}
              count={query.data.data.length}
              hasNext={!!query.data.page.next_cursor}
              pending={query.isFetching}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(query.data!.page.next_cursor)}
            />
          </>
        )
      )}
    </div>
  );
}
