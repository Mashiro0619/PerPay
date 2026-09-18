import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import {
  api,
  refreshOperationalData,
  result,
  type OrderWebhookDeliveryDetail,
  type WebhookDeliveryDetail,
  type WebhookAttempt,
} from "@/api/client";
import { useCursor } from "@/lib/cursor";
import {
  attemptResult,
  latestAttempt,
  notificationErrorName,
} from "@/lib/detail-summary";
import { dateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, Loading } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { ReasonDialog } from "@/components/ReasonDialog";
import { SuccessMessage } from "@/components/Feedback";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { DetailFields } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
type DeliveryContext = WebhookDeliveryDetail & {
  attempts: readonly WebhookAttempt[];
};
export function DeliveryCard({
  detail,
  embedded = false,
  attemptsAvailable = true,
  sectionTitle,
}: {
  detail: DeliveryContext;
  embedded?: boolean;
  attemptsAvailable?: boolean;
  sectionTitle?: string;
}) {
  const [snapshot, setSnapshot] = useState<DeliveryContext | null>(null);
  const [sent, setSent] = useState(false);
  const finalFocus = useRef<HTMLButtonElement | null>(null);
  const delivery = detail.delivery;
  const last = latestAttempt(detail.attempts);
  const terminal =
    delivery.status === "ACKNOWLEDGED" || delivery.status === "DEAD_LETTER";
  return (
    <Card size={embedded ? "sm" : "default"} aria-label="业务通知记录">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {sectionTitle ?? label(detail.event.event_type)}
          {!detail.is_latest && " · 历史投递"}
        </CardTitle>
        <CardDescription>
          {attemptsAvailable ? attemptResult(last) : "投递尝试尚未读取"} ·
          已尝试 {delivery.attempt_count} 次
        </CardDescription>
        <CardAction>
          <StatusBadge value={delivery.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <DetailFields
          wide={["通知地址", "重发理由"]}
          items={[
            [
              "通知地址",
              <CopyValue
                value={detail.target.target_url}
                label="复制通知地址"
              />,
            ],
            ...(delivery.next_attempt_at && !terminal
              ? [["下次重试", dateTime(delivery.next_attempt_at)] as const]
              : []),
            ...(delivery.acknowledged_at
              ? [["业务确认时间", dateTime(delivery.acknowledged_at)] as const]
              : []),
            ...(delivery.last_error_code &&
            delivery.last_error_code !== last?.error_code
              ? [
                  [
                    "最近错误",
                    notificationErrorName(delivery.last_error_code),
                  ] as const,
                ]
              : []),
            ...(delivery.requested_by_type === "ADMIN"
              ? [
                  [
                    "发起人",
                    delivery.requested_by_actor_id ?? "管理员",
                  ] as const,
                ]
              : []),
            ...(delivery.reason
              ? [["重发理由", delivery.reason] as const]
              : []),
          ]}
        />
        <SuccessMessage message={sent ? "已创建新投递，等待发送" : ""} />
        {detail.attempts.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" />
              投递尝试（{detail.attempts.length}）
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>次数 / 开始时间</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>HTTP / ACK</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.attempts.map((attempt) => (
                    <TableRow key={attempt.attempt_id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          第 {attempt.attempt_number} 次
                          <time
                            className="text-xs text-muted-foreground"
                            dateTime={attempt.started_at}
                          >
                            {dateTime(attempt.started_at)}
                          </time>
                        </div>
                      </TableCell>
                      <TableCell>{label(attempt.outcome)}</TableCell>
                      <TableCell className="whitespace-normal">
                        {attemptResult(attempt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CollapsibleContent>
          </Collapsible>
        )}
        <RecordTools
          label="通知记录操作"
          data={detail}
          identifiers={[
            ["投递编号", delivery.delivery_id],
            ["事件编号", detail.event.event_id],
          ]}
          to={embedded ? "/notifications/" + delivery.delivery_id : undefined}
          actions={
            terminal && detail.is_latest
              ? [
                  {
                    label: "重新投递",
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
      </CardContent>
      {snapshot && (
        <ReasonDialog
          finalFocus={() => finalFocus.current}
          title="重新投递业务通知"
          description="再次发送同一事件，业务方需避免重复处理。"
          action="确认重新投递"
          onClose={() => setSnapshot(null)}
          execute={(reason, operationId) =>
            result(
              api.redeliverWebhookDelivery({
                path: { deliveryId: snapshot.delivery.delivery_id },
                body: { reason, redelivery_id: operationId },
              }),
            )
          }
          onSuccess={() => {
            setSnapshot(null);
            setSent(true);
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
      )}
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
                  sectionTitle="业务通知"
                />
                {query.data.data.length > 1 && (
                  <Accordion>
                    {query.data.data
                      .slice(1)
                      .map((detail: OrderWebhookDeliveryDetail) => (
                        <AccordionItem
                          key={detail.delivery.delivery_id}
                          value={detail.delivery.delivery_id}
                        >
                          <AccordionTrigger>
                            {label(detail.event.event_type)} ·{" "}
                            {dateTime(detail.delivery.created_at)}
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
                    业务通知
                  </CardTitle>
                  <CardDescription>
                    {pagination.page > 1
                      ? "此页暂无投递记录"
                      : notifyUrl
                        ? "已配置通知，暂无投递记录"
                        : "未配置业务通知"}
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
