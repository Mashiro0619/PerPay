import { useQuery } from '@/lib/workspace-query';
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { InlineEmpty } from "@/components/admin-empty";
import { PageHeaderActions } from "@/components/page-header-actions";
import { PageHeading } from "@/components/page-heading";
import { RefreshButton } from "@/components/refresh-button";
import { Check, ChevronDown, Clock3, ExternalLink, Plus } from "lucide-react";
import { useParams } from "react-router";
import { queryClient, result, type AdminOrderDetail, type AdminOrderEvent, type PaymentMatchDetail } from "@/api/client";
import { Link, useDetailBack } from "@/navigation";
import { eventExplanation, isHistoricalException } from "@/lib/detail-summary";
import { dateTime } from "@/lib/format";
import { label } from "@/lib/labels";
import { StatusBadge, OrderStatusBadge, paymentBasisDescription } from "@/components/business-status";
import { DisputedOrderActions } from "@/components/detail/disputed-order-actions";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { CopyValue } from "@/components/copy-value";
import { QueryView } from "@/components/request-state";
import { DetailFields, DetailNavigation, DetailPage, TechnicalDetails } from "@/components/detail/DetailPrimitives";
import { DetailSections, DetailSection } from "@/components/detail/DetailSections";
import { AssociateIncomeAction } from "@/components/detail/FinancialActions";
import { ExceptionCard, MatchCard } from "@/components/detail/PaymentEvidence";
import { OrderNotifications } from "@/components/detail/NotificationEvidence";
import { Button, buttonVariants } from "@/components/ui/button";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Item, ItemContent, ItemTitle, ItemDescription, ItemGroup, ItemMedia } from "@/components/ui/item";
import { RefundMarkPanel } from "./RefundMark";

export function OrderDetail() {
  const api = useWorkspaceApi();
  const { orderId = "" } = useParams();
  const back = useDetailBack("/orders", "全部订单");
  const order = useQuery({
    queryKey: ["order", orderId],
    queryFn: ({ signal }) => result(api.getAdministratorOrder({ path: { orderId }, signal })),
  });
  return <DetailPage>
    <PageHeading title={order.data?.data.product_name ?? "订单详情"} />
    <DetailNavigation back={back}>
      <PageHeaderActions><RefreshButton disabled={order.isFetching} busy={order.isFetching} onClick={() => {
        void order.refetch();
        void queryClient.invalidateQueries({ predicate: query => query.queryKey.includes("order-notifications") && query.queryKey.includes(orderId) });
      }} /></PageHeaderActions>
    </DetailNavigation>
    <QueryView query={order}>{({ data }) => <OrderDesk key={data.order_id} order={data} />}</QueryView>
  </DetailPage>;
}

function OrderDesk({ order }: { order: AdminOrderDetail }) {
  const { clientId } = useWorkspace();
  const basis = paymentBasisDescription(order.payment.basis);
  const matches = order.reconciliation.matches;
  const active = matches.filter(match => match.status === "SETTLED");
  const reversed = matches.filter(match => match.status === "REVERSED");
  const exceptions = order.reconciliation.exceptions.filter(exception => !isHistoricalException(exception));
  const history = order.reconciliation.exceptions.filter(isHistoricalException);
  const ledgers = new Map(matches.map(match => [match.ledger_entry_id, match.ledger_entry]));
  const candidates = new Map(matches.flatMap(match => match.candidate ? [[match.candidate.candidate_id, match.candidate] as const] : []));
  const confirmed = [...order.events].reverse().find(event => event.event_type === "PAYMENT_CONFIRMED");
  const renderException = (exception: AdminOrderDetail["reconciliation"]["exceptions"][number]) => <ExceptionCard
    key={exception.exception_id} exception={exception}
    candidate={exception.candidate_id ? candidates.get(exception.candidate_id) : undefined}
    ledger={exception.ledger_entry_id ? ledgers.get(exception.ledger_entry_id) : undefined}
    order={order} embedded />;
  const association = <>
    {exceptions.length > 0 && <p className="text-sm text-muted-foreground">{exceptions.length} 项待核对</p>}
    {exceptions.map(renderException)}
    {active.map(match => <MatchCard key={match.payment_match_id} match={match} embedded />)}
    {!active.length && <DetailSection title="收款关联记录">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-order-association-prompt>
        <p className="text-sm text-muted-foreground">{order.payment.status === "DISPUTED" ? "原收款关联已撤销，请继续核对付款凭证。" : "尚未关联收款。"}</p>
        {order.payment.status === "UNPAID" && <AssociateIncomeAction orderId={order.order_id} orderLabel={order.product_name} />}
      </div>
    </DetailSection>}
    {reversed.length > 0 && <Accordion><AccordionItem value="reversed">
      <AccordionTrigger>已撤销的收款关联（{reversed.length}）</AccordionTrigger>
      <AccordionContent><div className="flex flex-col gap-4">{reversed.map(match => <MatchCard key={match.payment_match_id} match={match} embedded />)}</div></AccordionContent>
    </AccordionItem></Accordion>}
    {active.length > 0 && order.payment.status === "UNPAID" && <div className="flex min-w-0 flex-wrap items-center gap-2">
      <AssociateIncomeAction orderId={order.order_id} orderLabel={order.product_name} />
    </div>}
  </>;
  return <>
    <div className="detail-record-summary flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="PerPay 收款状态">
      <OrderStatusBadge payment={order.payment.status} checkout={order.checkout.status} refundMarked={order.refund_mark.marked} />
      <span className="inline-flex items-baseline gap-1 text-sm"><span className="text-muted-foreground">应付</span><ListMoney value={order.payable_amount_cents} /></span>
      <span className="inline-flex items-baseline gap-1 text-sm"><span className="text-muted-foreground">实收</span><ListMoney value={order.received_amount_cents} /></span>
      <ListDateTime value={order.created_at} inline />
      {basis && <p className="basis-full text-xs text-muted-foreground">{basis}</p>}
    </div>
    <DetailSections label="订单详情内容" sections={[
      { id: "overview", label: "概况", content: <>
        {order.payment.status === "DISPUTED" && <DisputedOrderActions order={order} />}
        <DetailSection title="订单信息">
          <DetailFields wide={["商品名称", "订单备注"]} items={[
            ["商户订单号", <CopyValue value={order.merchant_order_no} label="复制商户订单号" />],
            ...(Array.from(order.product_name).length > 24 ? [["商品名称", order.product_name] as const] : []),
            ...(!clientId ? [["业务网站", <Link global to={"/sites/" + encodeURIComponent(order.api_client_id) + "/summary"}>{order.site_name ?? "业务网站名称暂不可用"}</Link>] as const] : []),
            ["收款账号", <AlipayAccountIdentity id={order.alipay_account_id} name={order.alipay_account_name} />],
            ["下单金额", <ListMoney value={order.requested_amount_cents} secondary />],
            ["加价金额", <ListMoney value={order.payable_amount_cents - order.requested_amount_cents} secondary />],
            ...(confirmed ? [["确认收款时间", dateTime(confirmed.occurred_at)] as const] : []),
            ["收银台状态", <StatusBadge value={order.checkout.status} />],
            ["有效期至", dateTime(order.checkout.expires_at)],
            ...(order.note ? [["订单备注", order.note] as const] : []),
          ]} />
        </DetailSection>
        <RefundMarkPanel key={order.order_id} order={order} includeOrderTools footerActions={
          <a className={buttonVariants({ variant: "outline", size: "sm" })}
            href={"/api/admin/v1" + (clientId ? "/sites/" + encodeURIComponent(clientId) : "") + "/orders/" + encodeURIComponent(order.order_id) + "/checkout"}
            target="_blank" rel="noopener noreferrer" title="在新标签页查看收银台">{order.payment.status === "UNPAID" && order.checkout.status === "OPEN" ? "打开收银台" : "查看收银台结果"}<ExternalLink data-icon="inline-end" /></a>
        } />
        {order.refund.status !== "NONE" && <DetailFields items={[["历史退款（只读）", <StatusBadge value={order.refund.status} />]]} />}
      </> },
      { id: "payments", label: "收款关联" + (exceptions.length ? ` · ${exceptions.length} 项待核对` : ""), content: association, anchorPrefixes: ["match-", "candidate-", "exception-"] },
      { id: "notifications", label: "通知", content: <OrderNotifications orderId={order.order_id} notifyUrl={order.notification.notify_url} /> },
      { id: "history", label: "动态与记录", content: <>
        <DetailSection title="订单动态"><OrderTimeline events={order.events} matches={matches} /></DetailSection>
        {history.length > 0 && <Accordion><AccordionItem value="history"><AccordionTrigger>异常历史（{history.length}）</AccordionTrigger><AccordionContent>{history.map(renderException)}</AccordionContent></AccordionItem></Accordion>}
        <TechnicalDetails title="订单技术信息" data={order} identifiers={[["内部订单编号", order.order_id]]} />
      </> },
    ]} />
  </>;
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
    <ItemGroup className="record-list list-timeline" data-density="compact" data-order-timeline>
      {values.map((event) => {
        const operationId = event.details.financial_operation_id;
        const operation =
          typeof operationId === "string"
            ? operations.get(operationId)
            : undefined;
        const explanation = eventExplanation(event);
        return (
          <Item key={event.event_id} className="record-list-row px-0 py-1" size="xs" role="listitem">
            <ItemMedia variant="icon">
              {event.event_type === "PAYMENT_CONFIRMED" ? (
                <Check />
              ) : event.event_type === "CREATED" ? (
                <Plus />
              ) : (
                <Clock3 />
              )}
            </ItemMedia>
            <ItemContent className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <ItemTitle className="record-list-title">{label(event.event_type)}</ItemTitle>
                <ItemDescription className="record-list-meta">
                  <ListDateTime value={event.occurred_at} inline />
                </ItemDescription>
                {explanation && <p className="record-list-meta">{explanation}</p>}
                {operation?.reason && <p className="record-list-meta whitespace-pre-wrap">
                  {operation.actor_id ? operation.actor_id + "：" : ""}
                  {operation.reason}
                </p>}
              </div>
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
  return (
    <div className="flex flex-col gap-2">
      {ordered.length ? (
        entries(ordered.slice(0, 6))
      ) : (
        <InlineEmpty>暂无订单事件</InlineEmpty>
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
import { AlipayAccountIdentity } from "@/components/alipay-account-identity";
