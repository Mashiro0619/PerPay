import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  result,
  type AdminOrderDetail,
  type FinancialException,
  type MatchCandidate,
  type PaymentMatchDetail,
  type ReconciliationLedgerEntry,
  type ReconciliationOrder,
} from "@/api/client";
import {
  candidateFacts,
  detailTimestamp,
  exceptionExplanation,
  exceptionResolution,
  exceptionStateLabel,
  numberField,
} from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { label } from "@/lib/labels";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
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
import { DetailFields, OrderFacts, useRelatedOrder } from "./DetailPrimitives";
import { RecordTools } from "./RecordTools";
type DetailOrder = ReconciliationOrder | AdminOrderDetail;
export function LedgerFacts({
  entry,
  compact = false,
}: {
  entry: ReconciliationLedgerEntry;
  compact?: boolean;
}) {
  return (
    <DetailFields
      compact={compact}
      wide={["流水备注"]}
      items={[
        [
          "流水金额",
          <span className="flex flex-wrap items-center gap-2">
            <strong className="tabular-nums">
              {money(entry.amount_cents)}
            </strong>
            <StatusBadge value={entry.direction} />
          </span>,
        ],
        ["交易时间", detailTimestamp(entry.occurred_at)],
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
        ["交易对方", entry.other_account ?? "未提供"],
        ...(entry.merchant_order_no
          ? [
              [
                "流水商户单号",
                <CopyValue
                  value={entry.merchant_order_no}
                  label="复制流水商户单号"
                />,
              ] as const,
            ]
          : []),
        ...(entry.memo ? [["流水备注", entry.memo] as const] : []),
      ]}
    />
  );
}
export function useRelatedLedger(
  ledgerId: string | null,
  known?: ReconciliationLedgerEntry,
) {
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
}: {
  candidate: MatchCandidate;
  ledger?: ReconciliationLedgerEntry | undefined;
}) {
  const titleId = useId();
  const facts = candidateFacts(candidate);
  const shownFacts = facts.filter(
    ([name]) =>
      !ledger ||
      (name === "匹配金额"
        ? numberField(candidate.evidence, "amount_cents") !==
          ledger.amount_cents
        : name === "流水发生时间"
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
        <p className="text-sm text-muted-foreground">匹配依据不完整</p>
      )}
      <DetailFields items={shownFacts} />
    </section>
  );
}
export function MatchCard({
  match,
  embedded = false,
}: {
  match: PaymentMatchDetail;
  embedded?: boolean;
}) {
  const operation = match.creation_operation;
  const reversal =
    match.status === "REVERSED" ? match.resolution_operation : null;
  return (
    <Card size={embedded ? "sm" : "default"} aria-label="收款关联记录">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {embedded && match.status === "SETTLED" ? "收款依据" : "收款记录"}
        </CardTitle>
        <CardDescription>
          {match.evidence_type === "MANUAL"
            ? "人工关联 · " + (operation?.actor_id ?? "未记录")
            : "按金额与付款时间推断"}{" "}
          · {dateTime(operation?.created_at ?? match.created_at)}
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
        {match.candidate && (
          <CandidateEvidence
            candidate={match.candidate}
            ledger={match.ledger_entry}
          />
        )}
        <ReverseMatchAction match={match} embedded={embedded} />
      </CardContent>
    </Card>
  );
}
export function CandidateCard({
  candidate,
  ledger,
  order: knownOrder,
  embedded = false,
}: {
  candidate: MatchCandidate;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: DetailOrder | undefined;
  embedded?: boolean;
}) {
  const { entry, query } = useRelatedLedger(candidate.ledger_entry_id, ledger);
  const { order, query: orderQuery } = useRelatedOrder(
    candidate.order_id,
    knownOrder,
  );
  const paymentStatus = order
    ? "payment" in order
      ? order.payment.status
      : order.payment_status
    : null;
  return (
    <Card aria-label="匹配候选证据">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          金额推断候选
        </CardTitle>
        <CardDescription>候选不代表付款确认。</CardDescription>
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
        {entry ? (
          <LedgerFacts entry={entry} />
        ) : query.isPending ? (
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
          identifiers={[["候选编号", candidate.candidate_id]]}
          label="候选记录操作"
          to={
            embedded
              ? "/reconciliation/candidates/" + candidate.candidate_id
              : undefined
          }
        />
      </CardContent>
      {candidate.status === "ELIGIBLE" &&
        entry?.direction === "CREDIT" &&
        ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state) &&
        paymentStatus === "UNPAID" && (
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
}: {
  exception: FinancialException;
  ledger?: ReconciliationLedgerEntry | undefined;
  order?: DetailOrder | undefined;
  candidate?: MatchCandidate | undefined;
  embedded?: boolean;
}) {
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
  return (
    <Card aria-label="账务异常记录">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {label(exception.exception_type)}
        </CardTitle>
        <CardDescription>{exceptionExplanation(exception)}</CardDescription>
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
