import { CreatedDateFilter } from "@/components/created-date-filter";
import { OrderExport } from "@/components/order-export";
import { useListQuery, ORDER_SORT_FIELDS } from "@/lib/list-query";
import {
  ListQueryToolbar,
  type ListQueryLookup,
} from "@/components/list-query-toolbar";
import { ListActionsMenu } from "@/components/list-actions-menu";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useNavigate } from "@/navigation";
import {
  api,
  result,
  type CheckoutStatus,
  type PaymentStatus,
} from "@/api/client";
import { useCursor } from "@/lib/cursor";
import {
  TestPaymentButton,
  TestPaymentMenuItem,
} from "@/components/test-payment-provider";
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
  { value: "merchant", label: "商户订单号" },
  { value: "internal", label: "内部订单编号" },
];
export default function Orders() {
  const lookup = useOrderLookup();
  const [search, setSearch] = useSearchParams();
  const paymentValue = search.get("payment");
  const checkoutValue = search.get("checkout");
  const payment = ["UNPAID", "CONFIRMED", "DISPUTED"].includes(
    paymentValue ?? "",
  )
    ? (paymentValue as PaymentStatus)
    : undefined;
  const checkout = ["OPEN", "CLOSED", "EXPIRED"].includes(checkoutValue ?? "")
    ? (checkoutValue as CheckoutStatus)
    : undefined;
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
    <div
      className="flex w-full min-w-0 flex-col gap-3"
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
    </div>
  );
}
function useOrderLookup() {
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
  const pagination = useCursor();
  const listQuery = useListQuery(ORDER_SORT_FIELDS, "created_at", "desc", true);
  const orders = useQuery({
    queryKey: ["orders", payment, checkout, pagination.cursor, listQuery.scope],
    queryFn: ({ signal }) =>
      result(
        api.listAdministratorOrders({
          signal,
          query: {
            limit: 20,
            ...listQuery.apiQuery,
            ...(payment ? { payment_status: payment } : {}),
            ...(checkout ? { checkout_status: checkout } : {}),
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  return (
    <>
      <ListQueryToolbar
        control={listQuery}
        label="订单关键词搜索"
        desktopFilters={desktopFilters}
        desktopActions={<TestPaymentButton />}
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
        mobileActions={
          <ListActionsMenu label="更多订单操作">
            {(trigger) => <TestPaymentMenuItem returnFocus={trigger} />}
          </ListActionsMenu>
        }
        sorts={[
          { value: "created_at", label: "创建时间" },
          { value: "payable_amount_cents", label: "应付金额" },
          { value: "received_amount_cents", label: "实收金额" },
        ]}
      />
      <CreatedDateFilter control={listQuery}><OrderExport query={listQuery.apiQuery} payment={payment} checkout={checkout} /></CreatedDateFilter>
      <QueryView query={orders}>
        {(page) => (
          <>
            <div className="min-w-0">
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
              pending={orders.isFetching}
              onPrevious={pagination.previous}
              onNext={() => pagination.next(page.page.next_cursor)}
            />
          </>
        )}
      </QueryView>
    </>
  );
}
export { OrderDetail } from "./OrderDetail";
