import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router";
import { useNavigate } from "@/navigation";
import {
  api,
  result,
  type CheckoutStatus,
  type PaymentStatus,
} from "@/api/client";
import { useCursor } from "@/lib/cursor";
import { TestPaymentButton } from "@/components/test-payment-provider";
import { DataTable } from "@/components/data-table";
import { CursorPagination } from "@/components/cursor-pagination";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyContent,
} from "@/components/ui/empty";
import { FieldGroup } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
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
    ["payment", "checkout", "cursor", "page"].forEach((key) =>
      next.delete(key),
    );
    setSearch(next, { replace: true });
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <OrderSearch />
        <TestPaymentButton />
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
      </div>
      <OrderPage
        key={payment + ":" + checkout}
        payment={payment}
        checkout={checkout}
        onClearFilters={clearFilters}
      />
    </div>
  );
}
function OrderSearch() {
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("merchant");
  const navigate = useNavigate();
  const lookup = useMutation({
    mutationFn: () =>
      kind === "merchant"
        ? result(
            api.getAdministratorOrderByMerchantNumber({
              path: { merchantOrderNo: value.trim() },
            }),
          )
        : result(
            api.getAdministratorOrder({ path: { orderId: value.trim() } }),
          ),
    onSuccess: ({ data }) => navigate("/orders/" + data.order_id),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim() && !lookup.isPending) lookup.mutate();
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <form role="search" onSubmit={submit}>
        <FieldGroup className="flex-row flex-wrap items-center gap-2">
          <Select
            items={searchOptions}
            value={kind}
            disabled={lookup.isPending}
            onValueChange={(next) => {
              if (next) {
                setKind(next);
                lookup.reset();
              }
            }}
          >
            <SelectTrigger aria-label="订单查询方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {searchOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <InputGroup className="min-w-40 flex-1 md:max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="订单号"
              name="order-query"
              type="search"
              required
              maxLength={128}
              autoComplete="off"
              placeholder="输入完整订单号"
              value={value}
              disabled={lookup.isPending}
              onChange={(event) => {
                setValue(event.target.value);
                lookup.reset();
              }}
            />
          </InputGroup>
          <Button
            type="submit"
            variant="outline"
            disabled={!value.trim() || lookup.isPending}
          >
            {lookup.isPending && (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            )}
            查找
          </Button>
        </FieldGroup>
      </form>
      <ErrorNotice error={lookup.error} />
    </div>
  );
}
function OrderPage({
  payment,
  checkout,
  onClearFilters,
}: {
  payment: PaymentStatus | undefined;
  checkout: CheckoutStatus | undefined;
  onClearFilters: () => void;
}) {
  const pagination = useCursor();
  const orders = useQuery({
    queryKey: ["orders", payment, checkout, pagination.cursor],
    queryFn: ({ signal }) =>
      result(
        api.listAdministratorOrders({
          signal,
          query: {
            limit: 20,
            ...(payment ? { payment_status: payment } : {}),
            ...(checkout ? { checkout_status: checkout } : {}),
            ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
          },
        }),
      ),
  });
  return (
    <QueryView query={orders}>
      {(page) => (
        <>
          <div className="overflow-hidden rounded-lg border">
            {!page.data.length &&
            (pagination.page > 1 || payment || checkout) ? (
              <Empty>
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
                      pagination.page > 1 ? pagination.previous : onClearFilters
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
              <DataTable data={page.data} />
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
  );
}
export { OrderDetail } from "./OrderDetail";
