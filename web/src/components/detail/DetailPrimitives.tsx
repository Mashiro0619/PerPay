import { useRef, type ReactNode } from "react";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  api,
  result,
  type AdminOrderDetail,
  type ReconciliationOrder,
} from "@/api/client";
import { Link } from "@/navigation";
import { dateTime, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "@/components/ui/item";
const detailQueryScopes = new Set([
  "order",
  "order-notifications",
  "match",
  "candidate",
  "exception",
  "ledger",
  "ledger-candidates",
  "notification",
  "notification-attempts",
  "conflict",
]);
export function useDetailFetching() {
  return useIsFetching({
    predicate: (query) => detailQueryScopes.has(String(query.queryKey[0])),
  });
}
export function DetailFields({
  items,
  className,
  wide = [],
  compact = false,
}: {
  items: ReadonlyArray<readonly [string, ReactNode]>;
  className?: string;
  wide?: readonly string[];
  compact?: boolean;
}) {
  if (!items.length) return null;
  return (
    <dl
      className={cn(
        "grid min-w-0 gap-4 sm:grid-cols-2",
        compact && "gap-x-4 gap-y-2",
        className,
      )}
    >
      {items.map(([name, value]) => (
        <div
          key={name}
          className={cn(
            compact
              ? "grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1"
              : "flex min-w-0 flex-col gap-1",
            wide.includes(name) && "sm:col-span-2",
          )}
        >
          <dt className="text-sm text-muted-foreground">{name}</dt>
          <dd className="min-w-0 text-sm whitespace-pre-wrap break-words">
            {value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function TechnicalDetailsDialog({
  open,
  onOpenChange,
  finalFocus,
  data,
  identifiers = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus: () => HTMLElement | null;
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        initialFocus={title}
        finalFocus={finalFocus}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle ref={title} tabIndex={-1}>
            技术详情
          </DialogTitle>
          <DialogDescription>
            当前记录的标识与原始数据，仅供排查，不会修改业务状态。
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-1">
          {identifiers.length > 0 && (
            <DetailFields
              items={identifiers
                .filter(
                  (entry): entry is readonly [string, string] => !!entry[1],
                )
                .map(([name, value]) => [
                  name,
                  <CopyValue value={value} label={"复制" + name} />,
                ])}
            />
          )}
          <pre
            tabIndex={0}
            aria-label="技术详情"
            className="shrink-0 rounded-md bg-muted p-4 text-xs whitespace-pre-wrap break-all"
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>关闭</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function DetailLink({
  to,
  label = "打开独立详情",
}: {
  to: string;
  label?: string;
}) {
  return (
    <Link to={to} className={buttonVariants({ variant: "link", size: "sm" })}>
      {label}
      <ExternalLink data-icon="inline-end" />
    </Link>
  );
}
export function OrderFacts({
  order,
  linked = true,
}: {
  order: ReconciliationOrder | AdminOrderDetail;
  linked?: boolean;
}) {
  const payment =
    "payment" in order ? order.payment.status : order.payment_status;
  return (
    <Item variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle className="break-all">
          {linked ? (
            <Link to={"/orders/" + order.order_id} className="hover:underline">
              {order.product_name}
            </Link>
          ) : (
            order.product_name
          )}
        </ItemTitle>
        <ItemDescription>
          应付 {money(order.payable_amount_cents)} · 实收{" "}
          {money(order.received_amount_cents)}
        </ItemDescription>
        <ItemDescription className="break-all">
          {order.merchant_order_no} · {dateTime(order.created_at)}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <StatusBadge value={payment} />
      </ItemActions>
    </Item>
  );
}
export function useRelatedOrder(
  orderId: string | null,
  known?: ReconciliationOrder | AdminOrderDetail,
) {
  const query = useQuery({
    queryKey: ["order", orderId],
    enabled: !!orderId && !known,
    queryFn: ({ signal }) =>
      result(
        api.getAdministratorOrder({ path: { orderId: orderId! }, signal }),
      ),
  });
  return { order: known ?? query.data?.data, query };
}
export function RelatedOrder({ orderId }: { orderId: string }) {
  const { query } = useRelatedOrder(orderId);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {query.isPending ? (
        <Loading label="正在读取关联订单…" />
      ) : query.data ? (
        <OrderFacts order={query.data.data} />
      ) : null}
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    </div>
  );
}
