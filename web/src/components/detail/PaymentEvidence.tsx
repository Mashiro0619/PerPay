import { useQuery } from '@/lib/workspace-query';
import { useWorkspace, useWorkspaceApi } from "@/workspace";
import { Link } from "@/navigation";
import { useId } from "react";

import { result, type AdminOrderDetail, type FinancialException, type MatchCandidate, type PaymentMatchDetail, type ReconciliationLedgerEntry, type ReconciliationOrder } from "@/api/client";
import {
  candidateFacts,
  detailTimestamp,
  exceptionExplanation,
  exceptionResolution,
  exceptionStateLabel,
  numberField,
} from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { label } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { AssociateIncomeAction, ReverseMatchAction } from "./FinancialActions";
import { DetailCredentials, DetailFields, OrderFacts, useRelatedOrder, type DetailDensity, type DetailFieldLayout } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
type DetailOrder = ReconciliationOrder | AdminOrderDetail;
export function LedgerFacts({
  entry,
  compact = false,
  density = "default",
  layout = "columns",
  showHeading = true,
  groupIdentifiers = false,
}: {
  entry: ReconciliationLedgerEntry;
  compact?: boolean;
  density?: DetailDensity;
  layout?: DetailFieldLayout;
  showHeading?: boolean;
  groupIdentifiers?: boolean;
}) {
  const titleId = useId();
  const counterparty = ["支付宝交易对方", entry.other_account ?? "未提供"] as const;
  const comfortable = density === "comfortable";
  if (groupIdentifiers && comfortable) {
    const grouped = <>
      <DetailFields density="comfortable" layout={layout} wide={["支付宝交易备注"]} items={[
        ["支付宝交易金额", <span className="flex flex-wrap items-center gap-2"><ListMoney value={entry.amount_cents} /><StatusBadge value={entry.direction} /></span>],
        ["支付宝交易时间", detailTimestamp(entry.occurred_at)],
        counterparty,
        ...(entry.memo ? [["支付宝交易备注", entry.memo] as const] : []),
      ]} />
      <DetailCredentials title="核对凭据" headingLevel={4} items={[
        ["支付宝订单号", entry.provider_order_no ? <CopyValue value={entry.provider_order_no} label="复制支付宝订单号" /> : "未提供"],
        ...(entry.merchant_order_no ? [["支付宝商户单号", <CopyValue value={entry.merchant_order_no} label="复制支付宝商户单号" />] as const] : []),
        ["内部流水编号（PerPay）", <CopyValue value={entry.ledger_entry_id} label="复制内部流水编号（PerPay）" />],
      ]} />
    </>;
    return showHeading ? <section className="flex min-w-0 flex-col gap-4" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-medium">支付宝流水与 PerPay 记录</h3>
      {grouped}
    </section> : grouped;
  }
  const facts = (
    <DetailFields
      compact={compact}
      density={density}
      layout={layout}
      className={cn(
        compact && !comfortable && "@sm/detail-fields:grid-cols-1 @4xl/detail-fields:grid-cols-2",
      )}
      wide={["支付宝订单号", "支付宝商户单号", "支付宝交易备注"]}
      items={[
        [
          "支付宝交易金额",
          <span className="flex flex-wrap items-center gap-2">
            <ListMoney value={entry.amount_cents} />
            <StatusBadge value={entry.direction} />
          </span>,
        ],
        ["支付宝交易时间", detailTimestamp(entry.occurred_at)],
        ...(comfortable ? [counterparty] : []),
        [
          "支付宝订单号",
          entry.provider_order_no ? (
            <CopyValue
              value={entry.provider_order_no}
              label="复制支付宝订单号"
            />
          ) : (
            "未提供"
          ),
        ],
        ...(comfortable ? [] : [counterparty]),
        ...(entry.merchant_order_no
          ? [
              [
                "支付宝商户单号",
                <CopyValue
                  value={entry.merchant_order_no}
                  label="复制支付宝商户单号"
                />,
              ] as const,
            ]
          : []),
        ...(entry.memo ? [["支付宝交易备注", entry.memo] as const] : []),
      ]}
    />
  );
  if (!showHeading) return facts;
  return (
    <section className={cn("flex min-w-0 flex-col", comfortable ? "gap-4" : "gap-3")} aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-medium">支付宝流水</h3>
      {facts}
    </section>
  );
}
export function useRelatedLedger(
  ledgerId: string | null,
  known?: ReconciliationLedgerEntry,
) {
  const api = useWorkspaceApi();
  const query = useQuery({
    queryKey: ["ledger", ledgerId],
    enabled: !!ledgerId && !known,
    queryFn: ({ signal }) =>
      result(
        api.getReconciliationLedgerEntry({
          path: { ledgerEntryId: ledgerId! },
          signal,
        }),
      ),
  });
  return { entry: known ?? query.data?.data, query };
}
export function RelatedLedger({
  ledgerId,
  known,
}: {
  ledgerId: string;
  known?: ReconciliationLedgerEntry | undefined;
}) {
  const { entry, query } = useRelatedLedger(ledgerId, known);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {entry ? (
        <LedgerFacts entry={entry} />
      ) : query.isPending ? (
        <Loading label="正在读取关联流水…" />
      ) : null}
      {!known && (
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
      )}
    </div>
  );
}
export function CandidateEvidence({
  candidate,
  ledger,
  density = "default",
  layout = "columns",
}: {
  candidate: MatchCandidate;
  ledger?: ReconciliationLedgerEntry | undefined;
  density?: DetailDensity;
  layout?: DetailFieldLayout;
}) {
  const titleId = useId();
  const facts = candidateFacts(candidate);
  const shownFacts = facts.filter(
    ([name]) =>
      !ledger ||
      (name === "匹配金额"
        ? numberField(candidate.evidence, "amount_cents") !==
          ledger.amount_cents
        : name === "支付宝交易时间"
          ? numberField(candidate.evidence, "occurred_at") !==
            Date.parse(ledger.occurred_at)
          : true),
  );
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-medium">
        匹配依据
      </h3>
      {facts.length < 3 && (
        <p className="text-sm text-muted-foreground">匹配信息不完整</p>
      )}
      <DetailFields density={density} layout={layout} wide={["金额占用时间"]} items={shownFacts} />
    </section>
  );
}
export function MatchCard({
  match,
  embedded = false,
  density = "default",
  transactionContext = false,
}: {
  match: PaymentMatchDetail;
  embedded?: boolean;
  density?: DetailDensity;
  /** The enclosing transaction already displays the complete Alipay facts. */
  transactionContext?: boolean;
}) {
  const operation = match.creation_operation;
  const reversal =
    match.status === "REVERSED" ? match.resolution_operation : null;
  if (transactionContext) return (
    <Card aria-label="收款关联记录" data-match-summary>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>{match.status === "REVERSED" ? "已撤销的关联" : "当前关联订单"}</CardTitle>
        <CardAction className="flex max-w-full flex-wrap items-center gap-2">
          <StatusBadge value={match.status} />
          <ReverseMatchAction match={match} inline includeOrderIdentifiers movesOnSuccess />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        <OrderFacts order={match.order} density="comfortable" layout="flow" />
        <MatchProcessingHistory match={match} />
        <DetailFields density="comfortable" layout="flow" wide={["使用的查账记录"]} items={[
          ["使用的查账记录", <div className="flex flex-wrap items-center gap-3"><CopyValue value={match.ledger_entry_id} label="复制使用的查账记录编号" /><Link to={"#source-" + match.ledger_entry_id} onClick={() => document.getElementById("source-" + match.ledger_entry_id)?.scrollIntoView({ block: "start" })}>核对这份记录</Link></div>],
        ]} />
      </CardContent>
    </Card>
  );
  if (density === "comfortable" && !embedded) {
    const manual = match.evidence_type === "MANUAL";
    return (
      <>
        <Card aria-label="收款关联记录" data-match-summary>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>关联摘要与订单</CardTitle>
            <CardAction className="flex flex-col items-end gap-2 @sm/card-header:flex-row @sm/card-header:items-center">
              <StatusBadge value={match.status} />
              <ReverseMatchAction match={match} inline includeOrderIdentifiers />
            </CardAction>
          </CardHeader>
          <CardContent><OrderFacts order={match.order} density="comfortable" layout="flow" /></CardContent>
        </Card>
        <Card aria-label="支付宝交易" data-match-ledger>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>支付宝交易</CardTitle>
          </CardHeader>
          <CardContent><LedgerFacts entry={match.ledger_entry} density="comfortable" layout="flow" showHeading={false} /></CardContent>
        </Card>
        <Card aria-label="匹配依据与处理记录" data-match-evidence>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>匹配依据与处理记录</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-6">
            {match.candidate && (
              <>
                <CandidateEvidence candidate={match.candidate} ledger={match.ledger_entry} density="comfortable" layout="flow" />
                <Separator />
              </>
            )}
            <section aria-label={manual ? "人工关联记录" : "关联记录"} className="flex min-w-0 flex-col gap-4">
              <h3 className="text-sm font-medium">{manual ? "人工关联记录" : "关联记录"}</h3>
              <DetailFields density="comfortable" layout="flow" wide={["关联理由"]} items={[
                ["关联方式", manual ? "管理员人工关联" : "按金额和付款时间推断"],
                ["关联时间", dateTime(operation?.created_at ?? match.created_at)],
                ...(manual ? [["关联操作人", operation?.actor_id ?? "未记录"] as const] : []),
                ...(operation?.reason ? [["关联理由", operation.reason] as const] : []),
              ]} />
            </section>
            {match.status === "REVERSED" && (
              <>
                <Separator />
                <section aria-label="撤销记录" className="flex min-w-0 flex-col gap-4">
                  <h3 className="text-sm font-medium">撤销记录</h3>
                  <DetailFields density="comfortable" layout="flow" wide={["撤销理由"]} items={[
                    ["撤销时间", dateTime(reversal?.created_at ?? match.resolved_at)],
                    ["撤销操作人", reversal?.actor_id ?? "未记录"],
                    ["撤销理由", reversal?.reason ?? "未记录"],
                  ]} />
                </section>
              </>
            )}
          </CardContent>
        </Card>
      </>
    );
  }
  return (
    <Card size={embedded ? "sm" : "default"} data-density="compact" aria-label="收款关联记录">
      <CardHeader>
        <CardTitle className="record-list-title" role="heading" aria-level={2}>收款关联记录</CardTitle>
        <CardDescription className="record-list-meta">
          {match.evidence_type === "MANUAL"
            ? "管理员人工关联 · " + (operation?.actor_id ?? "未记录")
            : "PerPay 按金额和付款时间推断"}{" "}
          · <ListDateTime value={operation?.created_at ?? match.created_at} inline />
        </CardDescription>
        <CardAction>
          <StatusBadge value={match.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {!embedded && <OrderFacts order={match.order} />}
        <LedgerFacts entry={match.ledger_entry} compact={embedded} />
        <DetailFields
          compact={embedded}
          wide={["关联理由", "撤销理由"]}
          items={[
            ...(operation?.reason
              ? [["关联理由", operation.reason] as const]
              : []),
            ...(match.status === "REVERSED"
              ? [
                  [
                    "撤销时间",
                    dateTime(reversal?.created_at ?? match.resolved_at),
                  ] as const,
                  ["撤销操作人", reversal?.actor_id ?? "未记录"] as const,
                  ["撤销理由", reversal?.reason ?? "未记录"] as const,
                ]
              : []),
          ]}
        />
        {match.candidate && <CandidateEvidence candidate={match.candidate} ledger={match.ledger_entry} />}
        <ReverseMatchAction match={match} embedded={embedded} />
      </CardContent>
    </Card>
  );
}
/** Shared evidence; a transaction detail does not repeat its Alipay facts here. */
function MatchProcessingHistory({ match }: { match: PaymentMatchDetail }) {
  const manual = match.evidence_type === "MANUAL";
  const operation = match.creation_operation;
  const reversal = match.status === "REVERSED" ? match.resolution_operation : null;
  return <div className="flex min-w-0 flex-col gap-6" data-match-evidence>
    {match.candidate && <CandidateEvidence candidate={match.candidate} ledger={match.ledger_entry} density="comfortable" layout="flow" />}
    <section aria-label={manual ? "人工关联记录" : "关联记录"} className="flex min-w-0 flex-col gap-4">
      <h4 className="text-sm font-medium">{manual ? "人工关联记录" : "关联记录"}</h4>
      <DetailFields density="comfortable" layout="flow" wide={["关联理由"]} items={[
        ["关联方式", manual ? "管理员人工关联" : "PerPay 按金额和付款时间推断"],
        ["关联时间", dateTime(operation?.created_at ?? match.created_at)],
        ...(manual ? [["关联操作人", operation?.actor_id ?? "未记录"] as const] : []),
        ...(operation?.reason ? [["关联理由", operation.reason] as const] : []),
      ]} />
    </section>
    {match.status === "REVERSED" && <section aria-label="撤销记录" className="flex min-w-0 flex-col gap-4">
      <h4 className="text-sm font-medium">撤销记录</h4>
      <DetailFields density="comfortable" layout="flow" wide={["撤销理由"]} items={[
        ["撤销时间", dateTime(reversal?.created_at ?? match.resolved_at)],
        ["撤销操作人", reversal?.actor_id ?? "未记录"],
        ["撤销理由", reversal?.reason ?? "未记录"],
      ]} />
    </section>}
  </div>;
}

export function CandidateCard({
  candidate,
  ledger,
  order: knownOrder,
  embedded = false,
  transactionContext = false,
}: {
  candidate: MatchCandidate;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: DetailOrder | undefined;
  embedded?: boolean;
  transactionContext?: boolean;
}) {
  const { entry, query } = useRelatedLedger(candidate.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(
    candidate.order_id,
    knownOrder,
  );
  const candidateTitle = knownOrder ? "可能匹配的流水" : ledger ? "可能匹配的订单" : "可能匹配的记录";
  const paymentStatus = order
    ? "payment" in order
      ? order.payment.status
      : order.payment_status
    : null;
  const canAssociate =
    candidate.status === "ELIGIBLE" &&
    entry?.direction === "CREDIT" &&
    ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state) &&
    paymentStatus === "UNPAID";
  let guidance = "订单或流水当前不可人工关联。";
  if (candidate.status === "SELECTED") {
    guidance = paymentStatus === "CONFIRMED"
      ? "已选用，订单收款已确认。"
      : paymentStatus === "DISPUTED"
        ? "曾被选用，收款有争议，请核对收款关联记录。"
        : "已选用，请以订单当前收款状态为准。";
  } else if (candidate.status === "SUPERSEDED") {
    guidance = "已被替代，仅供查阅。";
  } else if (canAssociate) {
    guidance = "仅为匹配建议，核对订单与流水后可人工关联，尚未确认收款。";
  } else if (!entry || !order) {
    guidance = "订单或流水状态未知，暂不能人工关联。";
  } else if (paymentStatus === "CONFIRMED") {
    guidance = "订单收款已确认，不能再次关联。";
  } else if (paymentStatus === "DISPUTED") {
    guidance = "收款有争议，请核对收款关联记录。";
  }
  return (
    <Card size={embedded ? "sm" : "default"} data-density="compact" aria-label={candidateTitle}>
      <CardHeader>
        <CardTitle className="record-list-title" role="heading" aria-level={2}>
          {candidateTitle}
        </CardTitle>
        <CardDescription className="record-list-meta">{guidance}</CardDescription>
        <CardAction>
          <StatusBadge value={candidate.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {order ? (
          <OrderFacts order={order} />
        ) : orderQuery.isPending ? (
          <Loading label="正在读取关联订单…" />
        ) : null}
        {!knownOrder && (
          <ErrorNotice
            error={orderQuery.error}
            retry={() => {
              void orderQuery.refetch();
            }}
          />
        )}
        {!transactionContext && entry ? (
          <LedgerFacts entry={entry} />
        ) : !transactionContext && query.isPending ? (
          <Loading label="正在读取流水…" />
        ) : null}
        {!ledger && (
          <ErrorNotice
            error={query.error}
            retry={() => {
              void query.refetch();
            }}
          />
        )}
        <CandidateEvidence candidate={candidate} ledger={entry} />
        <DetailFields
          items={[
            ["形成时间", dateTime(candidate.created_at)],
            ...(candidate.decided_at
              ? [["决定时间", dateTime(candidate.decided_at)] as const]
              : []),
          ]}
        />
        <RecordTools
          data={candidate}
          identifiers={[["可能匹配记录编号", candidate.candidate_id]]}
          label="可能匹配记录操作"
          to={
            embedded
              ? "/reconciliation/candidates/" + candidate.candidate_id
              : undefined
          }
        />
      </CardContent>
      {canAssociate && (
          <CardFooter>
            <AssociateIncomeAction
              orderId={candidate.order_id}
              ledgerId={candidate.ledger_entry_id}
              orderLabel={order?.product_name}
              ledgerLabel={
                money(entry.amount_cents) + " · " + dateTime(entry.occurred_at)
              }
            />
          </CardFooter>
        )}
    </Card>
  );
}
export function ExceptionCard({
  exception,
  ledger,
  order: knownOrder,
  candidate: knownCandidate,
  embedded = false,
  density = "default",
}: {
  exception: FinancialException;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: DetailOrder | undefined;
  candidate?: MatchCandidate | undefined;
  embedded?: boolean;
  density?: DetailDensity;
}) {
  const api = useWorkspaceApi();
  const { clientId } = useWorkspace();
  const { entry, query } = useRelatedLedger(exception.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(
    exception.order_id,
    knownOrder,
  );
  const candidateQuery = useQuery({
    queryKey: ["candidate", exception.candidate_id],
    enabled: !!exception.candidate_id && !knownCandidate,
    queryFn: ({ signal }) =>
      result(
        api.getReconciliationCandidate({
          path: { candidateId: exception.candidate_id! },
          signal,
        }),
      ),
  });
  const candidate = knownCandidate ?? candidateQuery.data?.data;
  const retired = ["UNMATCHED_DEBIT", "UNLINKED_REFUND"].includes(
    exception.exception_type,
  );
  const payment = order
    ? "payment" in order
      ? order.payment.status
      : order.payment_status
    : null;
  const resolution = exceptionResolution(exception);
  const canAssociate =
    !retired &&
    exception.status === "OPEN" &&
    ((!exception.order_id && !knownOrder) || payment === "UNPAID") &&
    (!exception.ledger_entry_id ||
      (entry?.direction === "CREDIT" &&
        ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state)));
  if (density === "comfortable" && !embedded) return (
    <Card aria-label="账务异常记录" data-financial-exception>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <CardTitle role="heading" aria-level={2}>{label(exception.exception_type)}</CardTitle>
          <CardDescription>{exceptionExplanation(exception)}</CardDescription>
        </div>
        <CardAction className="flex max-w-full flex-wrap items-center justify-end gap-2">
          <StatusBadge value={exception.reminder_ignored ? "NONE" : exception.status} label={exceptionStateLabel(exception)} />
          {canAssociate && <AssociateIncomeAction
            orderId={order?.order_id ?? exception.order_id ?? ""}
            ledgerId={exception.ledger_entry_id ?? ""}
            orderLabel={order?.product_name}
            ledgerLabel={entry ? money(entry.amount_cents) + " · " + dateTime(entry.occurred_at) : undefined}
          />}
          <RecordTools
            inline
            data={exception}
            identifiers={[
              ["异常编号", exception.exception_id],
              ["客户端 ID", order?.api_client_id ?? clientId],
              ["内部流水编号（PerPay）", entry?.ledger_entry_id ?? exception.ledger_entry_id],
              ["内部订单编号", order?.order_id ?? exception.order_id],
              ["可能匹配记录编号", candidate?.candidate_id ?? exception.candidate_id],
            ]}
            label="异常记录操作"
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-6">
        {order ? <OrderFacts order={order} density="comfortable" layout="flow" />
          : exception.order_id && orderQuery.isPending ? <Loading label="正在读取关联订单…" />
          : !exception.order_id ? <p className="text-sm text-muted-foreground">尚未关联订单</p> : null}
        {!knownOrder && exception.order_id && <ErrorNotice error={orderQuery.error} retry={() => { void orderQuery.refetch(); }} />}
        {entry ? <LedgerFacts entry={entry} density="comfortable" layout="flow" groupIdentifiers />
          : exception.ledger_entry_id && query.isPending ? <Loading label="正在读取关联流水…" /> : null}
        {!ledger && exception.ledger_entry_id && <ErrorNotice error={query.error} retry={() => { void query.refetch(); }} />}
        <DetailFields density="comfortable" layout="flow" wide={["处理结果"]} items={[
          ["发现时间", dateTime(exception.created_at)],
          ...(exception.resolved_at ? [["处理时间", dateTime(exception.resolved_at)] as const] : []),
          ...(resolution ? [["处理结果", resolution] as const] : []),
        ]} />
        {candidate && <CandidateEvidence candidate={candidate} ledger={entry} density="comfortable" layout="flow" />}
        {!knownCandidate && exception.candidate_id && <ErrorNotice error={candidateQuery.error} retry={() => { void candidateQuery.refetch(); }} />}
      </CardContent>
    </Card>
  );
  return (
    <Card size={embedded ? "sm" : "default"} data-density="compact" aria-label="账务异常记录">
      <CardHeader>
        <CardTitle className="record-list-title" role="heading" aria-level={2}>
          {label(exception.exception_type)}
        </CardTitle>
        <CardDescription className="record-list-meta">{exceptionExplanation(exception)}</CardDescription>
        <CardAction>
          <StatusBadge
            value={exception.reminder_ignored ? "NONE" : exception.status}
            label={exceptionStateLabel(exception)}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {!embedded &&
          (order ? (
            <OrderFacts order={order} />
          ) : exception.order_id && orderQuery.isPending ? (
            <Loading label="正在读取关联订单…" />
          ) : !exception.order_id ? (
            <p className="text-sm text-muted-foreground">尚未关联订单</p>
          ) : null)}
        {!knownOrder && exception.order_id && (
          <ErrorNotice
            error={orderQuery.error}
            retry={() => {
              void orderQuery.refetch();
            }}
          />
        )}
        {entry ? (
          <LedgerFacts entry={entry} />
        ) : exception.ledger_entry_id && query.isPending ? (
          <Loading label="正在读取关联流水…" />
        ) : null}
        {!ledger && exception.ledger_entry_id && (
          <ErrorNotice
            error={query.error}
            retry={() => {
              void query.refetch();
            }}
          />
        )}
        <DetailFields
          items={[
            ["发现时间", dateTime(exception.created_at)],
            ...(exception.resolved_at
              ? [["处理时间", dateTime(exception.resolved_at)] as const]
              : []),
            ...(resolution ? [["处理结果", resolution] as const] : []),
          ]}
        />
        {candidate && (
          <CandidateEvidence candidate={candidate} ledger={entry} />
        )}
        {!knownCandidate && exception.candidate_id && (
          <ErrorNotice
            error={candidateQuery.error}
            retry={() => {
              void candidateQuery.refetch();
            }}
          />
        )}
        <RecordTools
          data={exception}
          identifiers={[["异常编号", exception.exception_id]]}
          label="异常记录操作"
          to={
            embedded
              ? "/reconciliation/exceptions/" + exception.exception_id
              : undefined
          }
        />
      </CardContent>
      {canAssociate && (
        <CardFooter>
          <AssociateIncomeAction
            orderId={order?.order_id ?? exception.order_id ?? ""}
            ledgerId={exception.ledger_entry_id ?? ""}
            orderLabel={order?.product_name}
            ledgerLabel={
              entry
                ? money(entry.amount_cents) +
                  " · " +
                  dateTime(entry.occurred_at)
                : undefined
            }
          />
        </CardFooter>
      )}
    </Card>
  );
}
