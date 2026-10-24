import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { SiteIdentity } from "@/components/site-identity";
import { PageHeaderActions } from "@/components/page-header-actions";
import { RefreshButton } from "@/components/refresh-button";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { money } from "@/lib/format";
import { useListQuery, DELIVERY_SORT_FIELDS } from "@/lib/list-query";
import { ListQueryToolbar } from "@/components/list-query-toolbar";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { ListColumnsProvider } from "@/components/list-columns";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import {
  ListDateTime,
  ListIdentity,
  ListMeta,
  ListSummary,
  ListSummaryField,
} from "@/components/list-primitives";
import type { ReactNode } from "react";

import { RefreshCw, Settings2 } from "lucide-react";
import { useParams, useSearchParams } from "react-router";
import { PageHeading } from "@/components/page-heading";
import { Link, useDetailBack } from "@/navigation";
import { refreshOperationalData, result, type WebhookDeliveryStatus, type WebhookDeliverySummary } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { notificationErrorName } from "@/lib/detail-summary";
import { label } from "@/lib/labels";
import { DeliveryCard } from "@/components/detail/NotificationEvidence";
import { DetailNavigation, DetailPage, RelatedOrder } from "@/components/detail/DetailPrimitives";
import { StatusBadge } from "@/components/business-status";
import { QueryView } from "@/components/request-state";
import { notificationStatus, notificationsQuery } from "@/api/workspace-queries";
import { CursorPagination } from "@/components/cursor-pagination";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
const statuses = [
  { value: "", label: "全部状态" },
  { value: "PENDING", label: "等待投递" },
  { value: "LEASED", label: "投递中" },
  { value: "RETRY_WAIT", label: "等待重试" },
  { value: "ACKNOWLEDGED", label: "通知已确认" },
  { value: "DEAD_LETTER", label: "已停止重试" },
] as const;
export default function Notifications() {
  const [search, setSearch] = useSearchParams();
  const status = notificationStatus(search) ?? "";
  function changeStatus(value: string | null) {
    const next = new URLSearchParams(search);
    if (value) next.set("status", value);
    else next.delete("status");
    next.delete("cursor");
    next.delete("page");
    setSearch(next, { replace: true });
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ToggleGroup
        variant="outline"
        value={[status || "ALL"]}
        onValueChange={(values) => changeStatus(values[0] === "ALL" ? null : values[0] ?? null)}
        aria-label="通知快捷筛选"
        className="max-w-full flex-wrap"
        data-notification-shortcuts
      >
        <ToggleGroupItem value="ALL">全部</ToggleGroupItem>
        <ToggleGroupItem value="RETRY_WAIT">等待重试</ToggleGroupItem>
        <ToggleGroupItem value="DEAD_LETTER">已停止重试</ToggleGroupItem>
      </ToggleGroup>
      <DeliveryPage
        status={status || undefined}
        filters={
          <>
            <Select
              items={statuses}
              value={status}
              onValueChange={changeStatus}
            >
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
    </div>
  );
}
function DeliveryPage({
  status,
  filters,
}: {
  status: WebhookDeliveryStatus | undefined;
  filters: ReactNode;
}) {
  const { clientId } = useWorkspace();
  const pagination = useCursor();
  const listQuery = useListQuery(
    DELIVERY_SORT_FIELDS,
    "created_at",
    "desc",
    true,
  );
  const deliveries = useQuery(notificationsQuery(clientId, listQuery, pagination.cursor, status));
  const columns: BusinessColumn<WebhookDeliverySummary>[] = [
    {
      id: "identity",
      label: "商品 / 通知",
      hideable: false,
      layout: "identity",
      summaryDefault: true,
      cell: (delivery, context) => (
        <ListIdentity
          meta={
            <ListMeta>
              {delivery.order_summary && context.showInSummary("order") && <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1">
                <span>商户订单号（业务网站）：</span>
                <Link className="list-secondary-link list-code" title={delivery.order_summary.merchant_order_no} to={"/orders/" + delivery.event.order_id}>{delivery.order_summary.merchant_order_no}</Link>
              </span>}
              {delivery.order_summary && (
                <span className="whitespace-nowrap tabular-nums">
                  应付 {money(delivery.order_summary.payable_amount_cents)}
                </span>
              )}
              {!clientId && (
                <SiteIdentity
                  clientId={delivery.order_summary?.api_client_id}
                  name={delivery.order_summary?.site_name}
                />
              )}
            </ListMeta>
          }
          description={<>
            <ListMeta><span>通知类型：{label(delivery.event.event_type)}</span></ListMeta>
            {(context.showInSummary("created_at") || context.showInSummary("attempt_count")) && <ListMeta>
              {context.showInSummary("created_at") && <ListDateTime value={delivery.created_at} inline />}
              {context.showInSummary("attempt_count") && <span>已尝试 {delivery.attempt_count} 次</span>}
            </ListMeta>}
          </>}
        >
          <Link
            data-row-link
            className="list-primary-link"
            title={delivery.order_summary?.product_name ?? label(delivery.event.event_type)}
            to={"/notifications/" + delivery.delivery_id}
          >
            {delivery.order_summary?.product_name ?? label(delivery.event.event_type)}
          </Link>
        </ListIdentity>
      ),
    },
    {
      id: "order",
      label: "关联商户订单号（业务网站）",
      layout: "text",
      summaryDefault: true,
      responsive: { minWidthRem: 75, basis: "container" },
      cell: (delivery) => (
        <Link
          className="list-secondary-link list-code"
          to={"/orders/" + delivery.event.order_id}
        >
          {delivery.order_summary?.merchant_order_no ?? "查看订单"}
        </Link>
      ),
    },
    {
      id: "status",
      label: "送达结果",
      align: "center",
      layout: "status",
      summaryDefault: true,
      cell: (delivery, context) => (
        <div className="business-cell-stack flex flex-col items-start gap-1.5">
          <StatusBadge value={delivery.status} />
          {delivery.last_error_code && (
            <span className="text-xs text-muted-foreground">
              {notificationErrorName(delivery.last_error_code)}
            </span>
          )}
          {delivery.next_attempt_at && context.showInSummary("next_attempt_at") && (
            <ListMeta>
              <span>下次 <ListDateTime value={delivery.next_attempt_at} inline /></span>
            </ListMeta>
          )}
        </div>
      ),
    },
    {
      id: "attempt_count",
      sortBy: "attempt_count",
      label: "尝试次数",
      align: "center",
      layout: "number",
      summaryDefault: true,
      responsive: { minWidthRem: 40, basis: "container" },
      cell: (delivery) => <span className="tabular-nums">{delivery.attempt_count}</span>,
    },
    {
      id: "created_at",
      sortBy: "created_at",
      label: "创建时间",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 56, basis: "container" },
      cell: (delivery) => <ListDateTime value={delivery.created_at} />,
    },
    {
      id: "next_attempt_at",
      sortBy: "next_attempt_at",
      label: "下次尝试",
      align: "center",
      layout: "datetime",
      summaryDefault: true,
      responsive: { minWidthRem: 56, basis: "container" },
      cell: (delivery) => <ListDateTime value={delivery.next_attempt_at} />,
    },
  ];
  return (
    <ListColumnsProvider>
    <ListLayout
      className="w-full"
      data-business-list="notifications"
    >
      <ListToolbarPart>
      <ListQueryToolbar
        control={listQuery}
        label="通知关键词搜索"
        desktopFilters={filters}
        desktopFilterContent={<CreatedDateFilter control={listQuery} />}
        mobileFilterContent={draft => <CreatedDateFilter control={draft} />}
        mobileFilterSummary={listQuery.query.createdFrom || listQuery.query.createdTo ? ["创建日期：" + (listQuery.query.createdFrom ?? "不限") + " 至 " + (listQuery.query.createdTo ?? "不限")] : []}
        mobileFilterReset={{ created_from: null, created_to: null }}
        desktopActions={
          <>
            <Link
              to={clientId ? "/sites/" + encodeURIComponent(clientId) + "/settings/integration" : "/sites"}
              className={buttonVariants({ variant: "outline" })}
            >
              通知设置
            </Link>
            <RefreshButton disabled={deliveries.isFetching} onClick={() => {
                void deliveries.refetch();
              }} busy={deliveries.isFetching} />
          </>
        }
        filters={[
          {
            key: "status",
            label: "通知状态",
            value: status ?? "",
            options: statuses,
          },
        ]}
        mobileActions={
          <ListActionsMenu label="更多通知操作">
            {() => (
              <>
                <DropdownMenuItem
                  render={<Link to={clientId ? "/sites/" + encodeURIComponent(clientId) + "/settings/integration" : "/sites"} />}
                >
                  <Settings2 />
                  通知设置
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={deliveries.isFetching}
                  onClick={() => {
                    void deliveries.refetch();
                  }}
                >
                  <RefreshCw />
                  刷新
                </DropdownMenuItem>
              </>
            )}
          </ListActionsMenu>
        }
        sorts={[
          { value: "created_at", label: "创建时间" },
          { value: "attempt_count", label: "尝试次数" },
          { value: "next_attempt_at", label: "下次重试时间" },
        ]}
      />
      </ListToolbarPart>
      <QueryView query={deliveries}>
        {(page) => (
          <>
            <div className="min-w-0" aria-busy={deliveries.isFetching || deliveries.isPlaceholderData}>
              {page.data.length ? (
                <BusinessTable
                  id="notifications"
                  aria-label="通知列表"
                  items={page.data}
                  rowId={(item) => item.delivery_id}
                  control={listQuery}
                  columns={columns}
                  renderSummary={(delivery, context) => (
                    <ListSummary
                      identity={columns[0]!.cell(delivery, context)}
                      details={columns.filter((column) =>
                        context.isColumnVisible(column.id) && !context.isSummaryPrimary(column.id),
                      ).map((column) => (
                        <ListSummaryField key={column.id} label={column.label}>
                          {column.cell(delivery, context)}
                        </ListSummaryField>
                      ))}
                    >
                      {columns.filter((column) =>
                        column.id !== "identity" && context.isSummaryPrimary(column.id),
                      ).map((column) => (
                        <ListSummaryField key={column.id} label={column.label}>
                          {column.cell(delivery, context)}
                        </ListSummaryField>
                      ))}
                    </ListSummary>
                  )}
                />
              ) : (
                <Empty kind="filtered">
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
              pending={deliveries.isFetching || deliveries.isPlaceholderData}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </ListLayout>
    </ListColumnsProvider>
  );
}
export function NotificationDetail() {
  const { deliveryId = "" } = useParams();
  return <DeliveryDetail key={deliveryId} deliveryId={deliveryId} />;
}
function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const api = useWorkspaceApi();
  const back = useDetailBack("/notifications", "通知");
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
    <DetailPage>
      <PageHeading title="通知详情" />
      <DetailNavigation back={back}>
        <PageHeaderActions><RefreshButton disabled={delivery.isFetching || attempts.isFetching} onClick={() => {
            void refreshOperationalData();
          }} busy={delivery.isFetching || attempts.isFetching} /></PageHeaderActions>
      </DetailNavigation>
      <QueryView query={delivery}>
        {({ data }) => (
          <>
            <Card aria-label="关联订单">
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>关联订单</CardTitle>
              </CardHeader>
              <CardContent>
                <RelatedOrder orderId={data.event.order_id} density="comfortable" layout="flow" />
              </CardContent>
            </Card>
            <DeliveryCard
              detail={{ ...data, attempts: attempts.data?.data ?? [] }}
              attemptsAvailable={!!attempts.data}
              attemptsError={attempts.error}
              retryAttempts={() => { void attempts.refetch(); }}
              density="comfortable"
            />
          </>
        )}
      </QueryView>
    </DetailPage>
  );
}
