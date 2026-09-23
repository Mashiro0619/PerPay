import { useListQuery, DELIVERY_SORT_FIELDS } from "@/lib/list-query";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { BusinessTable } from "@/components/business-table";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useParams, useSearchParams } from "react-router";
import { Link, useDetailBack } from "@/navigation";
import {
  api,
  refreshOperationalData,
  result,
  type WebhookDeliveryStatus,
} from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { dateTime, shortId } from "@/lib/format";
import { notificationErrorName } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { DeliveryCard } from "@/components/detail/NotificationEvidence";
import { RelatedOrder } from "@/components/detail/DetailPrimitives";
import { StatusBadge } from "@/components/business-status";
import { QueryView, ErrorNotice } from "@/components/request-state";
import { CursorPagination } from "@/components/cursor-pagination";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
const statuses = [
  { value: "", label: "全部状态" },
  { value: "PENDING", label: "等待投递" },
  { value: "LEASED", label: "投递中" },
  { value: "RETRY_WAIT", label: "等待重试" },
  { value: "ACKNOWLEDGED", label: "已确认送达" },
  { value: "DEAD_LETTER", label: "投递失败" },
] as const;
export default function Notifications() {
  const [search, setSearch] = useSearchParams();
  const status =
    statuses.find((item) => item.value === search.get("status"))?.value ?? "";
  function changeStatus(value: string | null) {
    const next = new URLSearchParams(search);
    if (value) next.set("status", value);
    else next.delete("status");
    next.delete("cursor");
    next.delete("page");
    setSearch(next, { replace: true });
  }
  return (
    <DeliveryPage
      status={status || undefined}
      filters={
        <>
          <Select items={statuses} value={status} onValueChange={changeStatus}>
            <SelectTrigger aria-label="通知状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {statuses.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {status && (
            <Button variant="ghost" onClick={() => changeStatus(null)}>
              清除筛选
            </Button>
          )}
        </>
      }
    />
  );
}
function DeliveryPage({
  status,
  filters,
}: {
  status: WebhookDeliveryStatus | undefined;
  filters: ReactNode;
}) {
  const pagination = useCursor();
  const listQuery = useListQuery(DELIVERY_SORT_FIELDS, "created_at", "asc");
  const deliveries = useQuery({
    queryKey: ["notifications", status, pagination.cursor, listQuery.scope],
    queryFn: ({ signal }) =>
      result(
        api.listWebhookDeliveries({
          signal,
          query: {
            limit: 20,
            ...listQuery.apiQuery,
            ...(status ? { status } : {}),
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {filters}
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/settings/notifications"
            className={buttonVariants({ variant: "outline" })}
          >
            通知设置
          </Link>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新"
            disabled={deliveries.isFetching}
            onClick={() => {
              void deliveries.refetch();
            }}
          >
            {deliveries.isFetching ? (
              <Spinner aria-hidden="true" />
            ) : (
              <RefreshCw />
            )}
          </Button>
        </div>
      </div>
      <ListQueryToolbar
        control={listQuery}
        label="通知关键词搜索"
        sorts={[
          { value: "created_at", label: "创建时间" },
          { value: "attempt_count", label: "尝试次数" },
          { value: "next_attempt_at", label: "下次重试时间" },
        ]}
      />
      <QueryView query={deliveries}>
        {(page) => (
          <>
            <div className="min-w-0">
              {page.data.length ? (
                <BusinessTable
                  id="notifications"
                  items={page.data}
                  rowId={(item) => item.delivery_id}
                  control={listQuery}
                  columns={[
                    {
                      id: "identity",
                      label: "通知事件",
                      hideable: false,
                      className: "w-full max-w-md whitespace-normal py-3",
                      cell: (delivery) => (
                        <div className="flex flex-col gap-1">
                          <Link
                            data-row-link
                            className="font-medium hover:underline"
                            to={"/notifications/" + delivery.delivery_id}
                          >
                            {label(delivery.event.event_type)}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {shortId(delivery.delivery_id)}
                          </span>
                          <time
                            className="text-xs text-muted-foreground md:hidden"
                            dateTime={delivery.created_at}
                          >
                            {dateTime(delivery.created_at)}
                          </time>
                          <span className="text-xs text-muted-foreground sm:hidden">
                            已尝试 {delivery.attempt_count} 次
                          </span>
                        </div>
                      ),
                    },
                    {
                      id: "status",
                      label: "送达结果",
                      className: "max-w-xs whitespace-normal",
                      cell: (delivery) => (
                        <div className="flex flex-col gap-1">
                          <StatusBadge value={delivery.status} />
                          {delivery.last_error_code && (
                            <span className="text-xs text-muted-foreground">
                              {notificationErrorName(delivery.last_error_code)}
                            </span>
                          )}
                          {delivery.next_attempt_at && (
                            <span className="text-xs text-muted-foreground md:hidden">
                              下次 {dateTime(delivery.next_attempt_at)}
                            </span>
                          )}
                        </div>
                      ),
                    },
                    {
                      id: "attempt_count",
                      sortBy: "attempt_count",
                      label: "尝试次数",
                      align: "right",
                      className: "hidden sm:table-cell",
                      cell: (delivery) => delivery.attempt_count,
                    },
                    {
                      id: "order",
                      label: "关联订单",
                      className: "hidden lg:table-cell",
                      cell: (delivery) => (
                        <Link
                          className="underline underline-offset-4"
                          to={"/orders/" + delivery.event.order_id}
                        >
                          {shortId(delivery.event.order_id)}
                        </Link>
                      ),
                    },
                    {
                      id: "created_at",
                      sortBy: "created_at",
                      label: "创建时间",
                      className: "hidden md:table-cell",
                      cell: (delivery) => dateTime(delivery.created_at),
                    },
                    {
                      id: "next_attempt_at",
                      sortBy: "next_attempt_at",
                      label: "下次尝试",
                      className: "hidden md:table-cell",
                      cell: (delivery) => dateTime(delivery.next_attempt_at),
                    },
                  ]}
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle role="heading" aria-level={2}>
                      暂无符合条件的通知
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
            <CursorPagination
              previousLabel={pagination.previousLabel}
              page={pagination.page}
              count={page.data.length}
              hasNext={!!page.page.next_cursor}
              pending={deliveries.isFetching}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </div>
  );
}
export function NotificationDetail() {
  const { deliveryId = "" } = useParams();
  return <DeliveryDetail key={deliveryId} deliveryId={deliveryId} />;
}
function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const back = useDetailBack("/notifications", "业务通知");
  const delivery = useQuery({
    queryKey: ["notification", deliveryId],
    queryFn: ({ signal }) =>
      result(api.getWebhookDelivery({ path: { deliveryId }, signal })),
  });
  const attempts = useQuery({
    queryKey: ["notification-attempts", deliveryId],
    queryFn: ({ signal }) =>
      result(api.listWebhookDeliveryAttempts({ path: { deliveryId }, signal })),
  });
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <Link
          to={back.to}
          state={back.state}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeft data-icon="inline-start" />
          {back.label}
        </Link>
        <Button
          variant="outline"
          disabled={delivery.isFetching || attempts.isFetching}
          onClick={() => {
            void refreshOperationalData();
          }}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
      </div>
      <QueryView query={delivery}>
        {({ data }) => (
          <>
            <RelatedOrder orderId={data.event.order_id} />
            <ErrorNotice
              error={attempts.error}
              retry={() => {
                void attempts.refetch();
              }}
            />
            <DeliveryCard
              detail={{ ...data, attempts: attempts.data?.data ?? [] }}
              attemptsAvailable={!!attempts.data}
            />
          </>
        )}
      </QueryView>
    </>
  );
}
