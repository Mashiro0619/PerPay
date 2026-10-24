import { ListLayout, ListToolbarPart } from "@/components/list-layout";
import { useState } from "react";
import { SitePicker } from "@/components/site-picker";
import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { CreatedDateFilter } from "@/components/created-date-filter";
import { OrderExport } from "@/components/order-export";
import { useListQuery, ORDER_SORT_FIELDS } from "@/lib/list-query";
import { orderFilters, ordersQuery } from "@/api/workspace-queries";
import {
  ListQueryToolbar,
  type ListQueryLookup,
} from "@/components/list-query-toolbar";
import { ListColumnsProvider } from "@/components/list-columns";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from "react-router";
import { useNavigate } from "@/navigation";
import { result, type CheckoutStatus, type PaymentStatus } from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { DataTable } from "@/components/data-table";
import { CursorPagination } from "@/components/cursor-pagination";
import { QueryView } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyContent,
} from "@/components/admin-empty";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
const paymentOptions = [
  { value: "", label: "全部付款状态" },
  { value: "UNPAID", label: "未付款" },
  { value: "CONFIRMED", label: "已确认" },
  { value: "DISPUTED", label: "有争议" },
];
const checkoutOptions = [
  { value: "", label: "全部收银台状态" },
  { value: "OPEN", label: "开放中" },
  { value: "CLOSED", label: "已关闭" },
  { value: "EXPIRED", label: "已过期" },
];
const searchOptions = [
  { value: "merchant", label: "商户订单号（业务网站）" },
  { value: "internal", label: "内部订单编号（PerPay）" },
];
export default function Orders() {
  const { clientId } = useWorkspace();
  const [lookupSite, setLookupSite] = useState("");
  const lookup = useOrderLookup(clientId ?? lookupSite);
  const [search, setSearch] = useSearchParams();
  const { payment, checkout } = orderFilters(search);
  function filter(key: string, value: string | null) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    next.delete("page");
    setSearch(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams(search);
    [
      "api_client_id",
      "payment",
      "checkout",
      "cursor",
      "page",
      "q",
      "sort_by",
      "sort_order",
      "created_from",
      "created_to",
    ].forEach((key) => next.delete(key));
    setSearch(next, { replace: true });
  }
  return (
    <ListLayout
      className="w-full"
      data-business-list="orders"
    >
      <OrderPage
        desktopFilters={
          <>
            <Select
              items={paymentOptions}
              value={payment ?? ""}
              onValueChange={(value) => filter("payment", value)}
            >
              <SelectTrigger aria-label="付款状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {paymentOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              items={checkoutOptions}
              value={checkout ?? ""}
              onValueChange={(value) => filter("checkout", value)}
            >
              <SelectTrigger aria-label="收银台状态筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {checkoutOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {(payment || checkout) && (
              <Button variant="ghost" onClick={clearFilters}>
                清除筛选
              </Button>
            )}
          </>
        }
        lookup={{
          context: mode => !clientId && mode === "merchant" ? (
            <SitePicker
              value={lookupSite}
              onChange={(next) => {
                // Invalidate the old request before changing its search context.
                lookup.reset();
                setLookupSite(next);
              }}
            />
          ) : null,
          modes: searchOptions.map((option) => ({
            ...option,
            placeholder:
              option.value === "merchant"
                ? "输入完整商户订单号"
                : "输入完整内部订单编号",
          })),
          inputLabel: "订单号",
          inputName: "order-query",
          maxLength: 128,
          pending: lookup.isPending,
          error: lookup.error,
          onReset: () => lookup.reset(),
          onSubmit: (kind, value) => lookup.mutate({ kind, value }),
        }}
        payment={payment}
        checkout={checkout}
        onClearFilters={clearFilters}
      />
    </ListLayout>
  );
}
function useOrderLookup(clientId: string) {
  const api = useWorkspaceApi();
  const navigate = useNavigate();
  const active = useRef<AbortController | null>(null);
  function cancel() {
    active.current?.abort();
    active.current = null;
  }
  useLayoutEffect(() => cancel, []);
  const lookup = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: ({
      kind,
      value,
      operation,
    }: {
      kind: string;
      value: string;
      operation: AbortController;
      originUrl: string;
    }) => {
      const { signal } = operation;
      signal.throwIfAborted();
      return kind === "merchant"
        ? result(
            api.getAdministratorOrderByMerchantNumber({
              path: { merchantOrderNo: value },
              query: { api_client_id: clientId },
              signal,
            }),
          )
        : result(
            api.getAdministratorOrder({ path: { orderId: value }, signal }),
          );
    },
    onSuccess: ({ data }, { operation, originUrl }) => {
      // View transitions can keep this route mounted after browser history commits.
      if (
        active.current === operation &&
        !operation.signal.aborted &&
        window.location.href === originUrl
      )
        navigate("/orders/" + data.order_id);
    },
    onSettled: (_data, _error, { operation }) => {
      if (active.current === operation) active.current = null;
    },
  });
  return {
    ...lookup,
    mutate({ kind, value }: { kind: string; value: string }) {
      cancel();
      const operation = new AbortController();
      active.current = operation;
      lookup.mutate({
        kind,
        value,
        operation,
        originUrl: window.location.href,
      });
    },
    reset() {
      cancel();
      lookup.reset();
    },
  };
}
function OrderPage({
  lookup,
  desktopFilters,
  payment,
  checkout,
  onClearFilters,
}: {
  lookup: ListQueryLookup;
  desktopFilters: ReactNode;
  payment: PaymentStatus | undefined;
  checkout: CheckoutStatus | undefined;
  onClearFilters: () => void;
}) {
  const { clientId } = useWorkspace();
  const pagination = useCursor();
  const listQuery = useListQuery(ORDER_SORT_FIELDS, "created_at", "desc", true);
  const orders = useQuery(ordersQuery(clientId, listQuery, pagination.cursor, payment, checkout));
  return (
    <ListColumnsProvider>
      <ListToolbarPart>
      <ListQueryToolbar
        control={listQuery}
        label="订单关键词搜索"
        desktopFilters={desktopFilters}
        desktopFilterContent={<CreatedDateFilter control={listQuery}><OrderExport clientId={clientId} query={listQuery.apiQuery} payment={payment} checkout={checkout} /></CreatedDateFilter>}
        mobileFilterContent={draft => <CreatedDateFilter control={draft} />}
        mobileFilterSummary={listQuery.query.createdFrom || listQuery.query.createdTo ? ["创建日期：" + (listQuery.query.createdFrom ?? "不限") + " 至 " + (listQuery.query.createdTo ?? "不限")] : []}
        mobileFilterReset={{ created_from: null, created_to: null }}
        mobileActions={<OrderExport menu clientId={clientId} query={listQuery.apiQuery} payment={payment} checkout={checkout} />}
        lookup={lookup}
        filters={[
          {
            key: "payment",
            label: "付款状态",
            value: payment ?? "",
            options: paymentOptions,
          },
          {
            key: "checkout",
            label: "收银台状态",
            value: checkout ?? "",
            options: checkoutOptions,
          },
        ]}
        sorts={[
          { value: "created_at", label: "创建时间" },
          { value: "payable_amount_cents", label: "应付金额" },
          { value: "received_amount_cents", label: "实收金额" },
        ]}
      />
      </ListToolbarPart>
      <QueryView query={orders}>
        {(page) => (
          <>
            <div className="min-w-0" aria-busy={orders.isFetching || orders.isPlaceholderData}>
              {!page.data.length &&
              (pagination.page > 1 ||
                payment ||
                checkout ||
                listQuery.query.q || listQuery.query.createdFrom) ? (
                <Empty kind="filtered">
                  <EmptyHeader>
                    <EmptyTitle role="heading" aria-level={2}>
                      {pagination.page > 1
                        ? "这一页暂无订单"
                        : "没有符合条件的订单"}
                    </EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      variant="outline"
                      onClick={
                        pagination.page > 1
                          ? pagination.previous
                          : onClearFilters
                      }
                    >
                      {pagination.page > 1
                        ? pagination.previousLabel === "返回首页"
                          ? "返回首页"
                          : "返回上一页"
                        : "查看全部订单"}
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <DataTable data={page.data} control={listQuery} />
              )}
            </div>
            <CursorPagination
              previousLabel={pagination.previousLabel}
              page={pagination.page}
              count={page.data.length}
              hasNext={!!page.page.next_cursor}
              pending={orders.isFetching || orders.isPlaceholderData}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </ListColumnsProvider>
  );
}
export { OrderDetail } from "./OrderDetail";
