import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { useId, useRef, type ReactNode } from "react";
import { useIsFetching } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from "lucide-react";
import { result, type AdminOrderDetail, type ReconciliationOrder } from "@/api/client";
import { Link } from "@/navigation";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge, paymentBasisDescription } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/admin-dialog";
import {
  Item,
  ItemHeader,
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
export type DetailDensity = "default" | "comfortable";
export type DetailFieldLayout = "columns" | "flow";
export function DetailPage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-6" data-detail-page data-detail-layout="readable">{children}</div>;
}
export function DetailNavigation({ back, identifier, identifierLabel = "记录编号", global = false, children }: {
  back: { to: string; label: string; state?: unknown };
  identifier?: string | undefined;
  identifierLabel?: string;
  global?: boolean;
  children?: ReactNode;
}) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-detail-navigation>
    <Link global={global} to={back.to} state={back.state} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft data-icon="inline-start" />{back.label}
    </Link>
    {identifier && <div className="min-w-0 text-xs text-muted-foreground" data-detail-identifier>
      <CopyValue value={identifier} label={"复制" + identifierLabel} />
    </div>}
    {children && <div className="ml-auto flex items-center gap-2 empty:hidden">{children}</div>}
  </div>;
}
export function DetailFields({
  items,
  className,
  wide = [],
  compact = false,
  density = "default",
  layout = "columns",
}: {
  items: ReadonlyArray<readonly [string, ReactNode]>;
  className?: string;
  wide?: readonly string[];
  compact?: boolean;
  density?: DetailDensity;
  layout?: DetailFieldLayout;
}) {
  if (!items.length) return null;
  return (
    <div className="@container/detail-fields min-w-0" data-detail-fields data-density={density} data-layout={layout}>
    <dl
      className={cn(
        "min-w-0",
        layout === "flow" ? "detail-fields-flow" : "grid gap-4",
        layout === "columns" && density === "default" && "@sm/detail-fields:grid-cols-2",
        layout === "columns" && compact && density === "default" && "gap-x-4 gap-y-2",
        className,
        density === "comfortable" && "detail-fields-comfortable",
      )}
    >
      {items.map(([name, value]) => (
        <div
          key={name}
          data-field-wide={wide.includes(name) || undefined}
          className={cn(
            layout === "columns" && compact && density === "default"
              ? "grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1"
              : "flex min-w-0 flex-col gap-1",
            layout === "columns" && wide.includes(name) && "col-span-full",
            density === "comfortable" && "detail-field-comfortable",
            layout === "flow" && "detail-field-flow",
          )}
        >
          <dt className={density === "comfortable" ? "text-sm text-muted-foreground" : "record-list-meta"}>{name}</dt>
          <dd className="min-w-0 text-sm whitespace-pre-wrap wrap-anywhere">
            {value === "" || value == null ? "—" : value}
          </dd>
        </div>
      ))}
    </dl>
    </div>
  );
}
export function DetailCredentials({ items, title = "凭据编号", headingLevel = 3 }: {
  items: ReadonlyArray<readonly [string, ReactNode]>;
  title?: string;
  headingLevel?: 3 | 4;
}) {
  const titleId = useId();
  if (!items.length) return null;
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby={titleId} data-detail-credentials>
    <Separator />
    <Heading id={titleId} className="text-sm font-medium">{title}</Heading>
    <DetailFields density="comfortable" items={items} />
  </section>;
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
        kind="technical"
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-3xl"
        initialFocus={title}
        finalFocus={finalFocus}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle ref={title} tabIndex={-1}>
            技术详情
          </DialogTitle>
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
                  <CopyValue tooltip value={value} label={"复制" + name} />,
                ])}
            />
          )}
          <pre
            tabIndex={0}
            aria-label="技术详情"
            role="group"
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
  density = "default",
  layout = "columns",
}: {
  order: ReconciliationOrder | AdminOrderDetail;
  linked?: boolean;
  density?: DetailDensity;
  layout?: DetailFieldLayout;
}) {
  const payment =
    "payment" in order ? order.payment.status : order.payment_status;
  const basis = paymentBasisDescription("payment" in order ? order.payment.basis : order.payment_basis);
  if (density === "comfortable") return <Item className="items-start" data-detail-order-summary>
    <ItemContent className="min-w-0 gap-4">
      <ItemHeader className={cn("flex-wrap items-start gap-3", layout === "flow" && "justify-start")}>
        <ItemTitle className="line-clamp-none whitespace-normal wrap-anywhere" title={order.product_name}>
          {linked ? <Link to={"/orders/" + order.order_id}>{order.product_name}</Link> : order.product_name}
        </ItemTitle>
        <ItemActions><StatusBadge value={payment} /></ItemActions>
      </ItemHeader>
      {basis && <p className="text-sm text-muted-foreground">{basis}</p>}
      <DetailFields density="comfortable" layout={layout} wide={["商户订单号（业务网站）"]} items={[
        ["应付金额", <ListMoney value={order.payable_amount_cents} label="应付金额" />],
        ["实收金额", <ListMoney value={order.received_amount_cents} label="实收金额" />],
        ["所属网站", <Link to={"/sites/" + encodeURIComponent(order.api_client_id)}>{order.site_name ?? "名称不可用"}</Link>],
        ["创建时间", <ListDateTime value={order.created_at} inline />],
        ["商户订单号（业务网站）", <CopyValue value={order.merchant_order_no} label="复制商户订单号" />],
      ]} />
    </ItemContent>
  </Item>;
  return (
    <Item className="record-list-row" size="xs">
      <ItemContent className="min-w-0">
        <ItemTitle className="record-list-title" title={order.product_name}>
          {linked ? (
            <Link to={"/orders/" + order.order_id}>
              {order.product_name}
            </Link>
          ) : (
            order.product_name
          )}
        </ItemTitle>
        <ItemDescription className="line-clamp-none whitespace-normal wrap-anywhere">
          所属网站：{order.site_name ?? "名称不可用"} · 客户端 ID（PerPay）：{order.api_client_id}
        </ItemDescription>
        <ItemDescription className="line-clamp-none whitespace-normal wrap-anywhere">
          商户订单号（业务网站）：{order.merchant_order_no} · 创建时间：<ListDateTime value={order.created_at} inline />
        </ItemDescription>
        {basis && <ItemDescription className="record-list-meta">{basis}</ItemDescription>}
      </ItemContent>
      <ItemActions className="flex-col items-end">
        <div className="flex items-baseline gap-2"><span className="record-list-meta">应付</span><ListMoney value={order.payable_amount_cents} label="应付金额" /></div>
        <div className="flex items-baseline gap-2"><span className="record-list-meta">实收</span><ListMoney value={order.received_amount_cents} label="实收金额" secondary /></div>
        <StatusBadge value={payment} />
      </ItemActions>
    </Item>
  );
}
export function useRelatedOrder(
  orderId: string | null,
  known?: ReconciliationOrder | AdminOrderDetail,
) {
  const api = useWorkspaceApi();
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
export function RelatedOrder({ orderId, density = "default", layout = "columns" }: { orderId: string; density?: DetailDensity; layout?: DetailFieldLayout }) {
  const { query } = useRelatedOrder(orderId);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {query.isPending ? (
        <Loading label="正在读取关联订单…" />
      ) : query.data ? (
        <OrderFacts order={query.data.data} density={density} layout={layout} />
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
