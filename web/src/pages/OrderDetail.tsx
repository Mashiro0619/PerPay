import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock3,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useParams } from "react-router";
import {
  api,
  refreshOperationalData,
  result,
  type AdminOrderDetail,
  type AdminOrderEvent,
  type PaymentMatchDetail,
} from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { eventExplanation, isHistoricalException } from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge } from "@/components/business-status";
import { CopyValue } from "@/components/copy-value";
import { QueryView } from "@/components/request-state";
import {
  DetailFields,
  useDetailFetching,
} from "@/components/detail/DetailPrimitives";
import { AssociateIncomeAction } from "@/components/detail/FinancialActions";
import { ExceptionCard, MatchCard } from "@/components/detail/PaymentEvidence";
import { OrderNotifications } from "@/components/detail/NotificationEvidence";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemGroup,
  ItemMedia,
} from "@/components/ui/item";
import { RefundMarkPanel } from "./RefundMark";
export function OrderDetail() {
  const { orderId = "" } = useParams();
  const back = useDetailBack("/orders", "全部订单");
  const fetching = useDetailFetching();
  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: ({ signal }) =>
      result(api.getAdministratorOrder({ path: { orderId }, signal })),
  });
  return (
    <div className="@container/order flex w-full min-w-0 flex-col gap-4">
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
          disabled={fetching > 0}
          onClick={() => {
            void refreshOperationalData();
          }}
        >
          {fetching > 0 ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新
        </Button>
      </div>
      <QueryView query={order}>
        {({ data }) => <OrderDesk key={data.order_id} order={data} />}
      </QueryView>
    </div>
  );
}
function OrderDesk({ order }: { order: AdminOrderDetail }) {
  const matches = order.reconciliation.matches;
  const active = matches.filter((match) => match.status === "SETTLED");
  const reversed = matches.filter((match) => match.status === "REVERSED");
  const exceptions = order.reconciliation.exceptions.filter(
    (exception) => !isHistoricalException(exception),
  );
  const history = order.reconciliation.exceptions.filter(isHistoricalException);
  const ledgers = new Map(
    matches.map((match) => [match.ledger_entry_id, match.ledger_entry]),
  );
  const candidates = new Map(
    matches.flatMap((match) =>
      match.candidate
        ? [[match.candidate.candidate_id, match.candidate] as const]
        : [],
    ),
  );
  const confirmed = [...order.events]
    .reverse()
    .find((event) => event.event_type === "PAYMENT_CONFIRMED");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-semibold tracking-tight">
          {order.product_name}
        </h2>
        <StatusBadge value={order.payment.status} />
      </div>
      <div className="grid min-w-0 items-start gap-4 @3xl/order:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)] @5xl/order:grid-cols-[minmax(16rem,1fr)_minmax(0,1.6fr)_minmax(16rem,1fr)]">
        <section
          aria-label="金额与订单信息"
          className="grid min-w-0 items-start gap-4 @3xl/order:col-span-2 @3xl/order:grid-cols-2 @5xl/order:col-span-1 @5xl/order:grid-cols-1"
        >
          <Card>
            <CardHeader>
              <CardDescription>实收金额</CardDescription>
              <p className="text-3xl font-semibold tabular-nums">
                {money(order.received_amount_cents)}
              </p>
            </CardHeader>
            <CardContent>
              <ItemGroup>
                <Item variant="muted" size="sm">
                  <ItemContent>
                    <ItemDescription>应付金额</ItemDescription>
                  </ItemContent>
                  <span className="font-medium tabular-nums">
                    {money(order.payable_amount_cents)}
                  </span>
                </Item>
                <Item size="sm">
                  <ItemContent>
                    <ItemDescription>原始金额</ItemDescription>
                  </ItemContent>
                  <span className="tabular-nums">
                    {money(order.requested_amount_cents)}
                  </span>
                </Item>
              </ItemGroup>
            </CardContent>
            <CardFooter>
              <CardDescription>
                收银台
                {order.checkout.status === "OPEN"
                  ? "开放中"
                  : order.checkout.status === "EXPIRED"
                    ? "已过期"
                    : "已关闭"}
              </CardDescription>
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                订单信息
              </CardTitle>
            </CardHeader>
            <CardContent>
              <DetailFields
                compact
                className="sm:grid-cols-1"
                items={[
                  [
                    "商户订单号",
                    <CopyValue
                      value={order.merchant_order_no}
                      label="复制商户订单号"
                    />,
                  ],
                  ["创建时间", dateTime(order.created_at)],
                  ...(confirmed
                    ? [
                        [
                          "付款确认时间",
                          dateTime(confirmed.occurred_at),
                        ] as const,
                      ]
                    : []),
                  ["付款截止", dateTime(order.checkout.expires_at)],
                ]}
              />
            </CardContent>
            <CardFooter className="block">
              <RefundMarkPanel
                key={order.order_id}
                order={order}
                includeOrderTools
              />
            </CardFooter>
          </Card>
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          {exceptions.map((exception) => (
            <ExceptionCard
              key={exception.exception_id}
              exception={exception}
              candidate={
                exception.candidate_id
                  ? candidates.get(exception.candidate_id)
                  : undefined
              }
              ledger={
                exception.ledger_entry_id
                  ? ledgers.get(exception.ledger_entry_id)
                  : undefined
              }
              order={order}
              embedded
            />
          ))}
          {active.map((match) => (
            <MatchCard key={match.payment_match_id} match={match} embedded />
          ))}
          {!active.length && !reversed.length && (
            <Card size="sm">
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  收款依据
                </CardTitle>
                <CardDescription>尚未关联收款。</CardDescription>
              </CardHeader>
              {order.payment.status === "UNPAID" && (
                <CardFooter>
                  <AssociateIncomeAction
                    orderId={order.order_id}
                    orderLabel={order.product_name}
                  />
                </CardFooter>
              )}
            </Card>
          )}
          {reversed.length > 0 && (
            <Accordion defaultValue={active.length === 0 ? ["reversed"] : []}>
              <AccordionItem value="reversed">
                <AccordionTrigger>
                  已撤销的收款关联（{reversed.length}）
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-4">
                    {reversed.map((match) => (
                      <MatchCard
                        key={match.payment_match_id}
                        match={match}
                        embedded
                      />
                    ))}
                    {order.payment.status === "UNPAID" && (
                      <AssociateIncomeAction
                        orderId={order.order_id}
                        orderLabel={order.product_name}
                      />
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
          <OrderNotifications
            key={order.order_id}
            orderId={order.order_id}
            notifyUrl={order.notification.notify_url}
          />
          {history.length > 0 && (
            <Accordion>
              <AccordionItem value="history">
                <AccordionTrigger>
                  异常历史（{history.length}）
                </AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-col gap-4">
                    {history.map((exception) => (
                      <ExceptionCard
                        key={exception.exception_id}
                        exception={exception}
                        candidate={
                          exception.candidate_id
                            ? candidates.get(exception.candidate_id)
                            : undefined
                        }
                        ledger={
                          exception.ledger_entry_id
                            ? ledgers.get(exception.ledger_entry_id)
                            : undefined
                        }
                        order={order}
                        embedded
                      />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </div>
        <aside
          className="flex min-w-0 flex-col gap-4"
          aria-label="订单动态与辅助信息"
        >
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                订单动态
              </CardTitle>
            </CardHeader>
            <CardContent>
              <OrderTimeline events={order.events} matches={matches} />
            </CardContent>
          </Card>
          {(order.note || order.refund.status !== "NONE") && (
            <Card size="sm">
              <CardHeader>
                <CardTitle role="heading" aria-level={2}>
                  补充信息
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DetailFields
                  className="sm:grid-cols-1"
                  items={[
                    ...(order.note ? [["订单备注", order.note] as const] : []),
                    ...(order.refund.status !== "NONE"
                      ? [
                          [
                            "历史退款（只读）",
                            <StatusBadge value={order.refund.status} />,
                          ] as const,
                        ]
                      : []),
                  ]}
                />
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
function OrderTimeline({
  events,
  matches,
}: {
  events: AdminOrderEvent[];
  matches: PaymentMatchDetail[];
}) {
  const operations = new Map(
    matches.flatMap((match) =>
      [match.creation_operation, match.resolution_operation]
        .filter((operation) => operation !== null && operation !== undefined)
        .map(
          (operation) => [operation.financial_operation_id, operation] as const,
        ),
    ),
  );
  const ordered = [...events].sort((a, b) => b.sequence - a.sequence);
  const entries = (values: AdminOrderEvent[]) => (
    <ItemGroup>
      {values.map((event) => {
        const operationId = event.details.financial_operation_id;
        const operation =
          typeof operationId === "string"
            ? operations.get(operationId)
            : undefined;
        const explanation = eventExplanation(event);
        return (
          <Item key={event.event_id} size="sm" variant="muted">
            <ItemMedia variant="icon">
              {event.event_type === "PAYMENT_CONFIRMED" ? (
                <Check />
              ) : event.event_type === "CREATED" ? (
                <Plus />
              ) : (
                <Clock3 />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{label(event.event_type)}</ItemTitle>
              <ItemDescription>
                <time dateTime={event.occurred_at}>
                  {dateTime(event.occurred_at)}
                </time>
              </ItemDescription>
              {explanation && (
                <p className="text-sm text-muted-foreground">{explanation}</p>
              )}
              {operation?.reason && (
                <p className="text-sm text-muted-foreground">
                  {operation.actor_id ? operation.actor_id + "：" : ""}
                  {operation.reason}
                </p>
              )}
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
  return (
    <div className="flex flex-col gap-4">
      {ordered.length ? (
        entries(ordered.slice(0, 6))
      ) : (
        <p className="text-sm text-muted-foreground">暂无订单事件</p>
      )}
      {ordered.length > 6 && (
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            <ChevronDown data-icon="inline-start" />
            更早动态（{ordered.length - 6}）
          </CollapsibleTrigger>
          <CollapsibleContent>{entries(ordered.slice(6))}</CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
