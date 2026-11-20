import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { useId, type ReactNode } from "react";

import { result, type AdminOrderDetail, type MatchCandidate, type ReconciliationLedgerEntry, type ReconciliationOrder } from "@/api/client";
import {
  candidateFacts,
  candidateFactsBeyondLedger,
  candidateGuidance,
  detailTimestamp,
} from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { ListMoney } from "@/components/list-primitives";
import { cn } from "@/lib/utils";
import { useOverlayContext } from "@/lib/overlay-context";
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
import { AssociateIncomeAction } from "./FinancialActions";
import { DetailCredentials, DetailFields, OrderFacts, TechnicalDetails, useRelatedOrder, type DetailDensity, type DetailFieldLayout } from "./DetailPrimitives";
import { DetailSection } from "./DetailSections";
import { RecordTools } from "./RecordTools";
type DetailOrder = ReconciliationOrder | AdminOrderDetail;
function EvidenceSection({ title, children }: { title: string; children: ReactNode }) {
  const overlay = useOverlayContext();
  return overlay ? <DetailSection title={title} headingLevel={3}>{children}</DetailSection> : <>{children}</>;
}
export function LedgerFacts({
  entry,
  compact = false,
  density = "default",
  layout = "columns",
  showHeading = true,
  groupIdentifiers = false,
  collapseCredentials = false,
}: {
  entry: ReconciliationLedgerEntry;
  compact?: boolean;
  density?: DetailDensity;
  layout?: DetailFieldLayout;
  showHeading?: boolean;
  groupIdentifiers?: boolean;
  collapseCredentials?: boolean;
}) {
  const titleId = useId();
  const overlay = useOverlayContext();
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
      <DetailCredentials title="核对凭据" headingLevel={showHeading ? 4 : 3} collapsible={collapseCredentials} items={[
        ["支付宝订单号", entry.provider_order_no ? <CopyValue value={entry.provider_order_no} label="复制支付宝订单号" /> : "未提供"],
        ...(entry.merchant_order_no ? [["支付宝商户单号", <CopyValue value={entry.merchant_order_no} label="复制支付宝商户单号" />] as const] : []),
        ["内部流水编号（PerPay）", <CopyValue value={entry.ledger_entry_id} label="复制内部流水编号（PerPay）" />],
      ]} />
    </>;
    return showHeading ? <section className={cn("flex min-w-0 flex-col gap-4", overlay && "detail-section")} aria-labelledby={titleId}>
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
    <section className={cn("flex min-w-0 flex-col", comfortable ? "gap-4" : "gap-3", overlay && "detail-section")} aria-labelledby={titleId}>
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
          scope="page"
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
  const overlay = useOverlayContext();
  const facts = candidateFacts(candidate);
  const shownFacts = candidateFactsBeyondLedger(candidate, ledger);
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", overlay && "detail-section")} aria-labelledby={titleId}>
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
  const overlay = useOverlayContext();
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
  const { canAssociate, guidance } = candidateGuidance(candidate, entry, paymentStatus);
  return (
    <Card size={embedded ? "sm" : "default"} data-density="compact" aria-label={candidateTitle}>
      <CardHeader>
        <div className={cn(overlay && "flex min-w-0 flex-wrap items-center gap-2")}>
          <CardTitle className="record-list-title" role="heading" aria-level={2}>
            {candidateTitle}
          </CardTitle>
          {overlay && <StatusBadge value={candidate.status} />}
        </div>
        <CardDescription className="record-list-meta">{guidance}</CardDescription>
        {!overlay && <CardAction>
          <StatusBadge value={candidate.status} />
        </CardAction>}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <EvidenceSection title="关联订单">
        {order ? (
          <OrderFacts order={order} density={overlay ? "comfortable" : "default"} layout={overlay ? "flow" : "columns"} />
        ) : orderQuery.isPending ? (
          <Loading label="正在读取关联订单…" />
        ) : null}
        {!knownOrder && (
          <ErrorNotice
            scope="page"
            error={orderQuery.error}
            retry={() => {
              void orderQuery.refetch();
            }}
          />
        )}
        </EvidenceSection>
        {!transactionContext && entry ? (
          <LedgerFacts entry={entry} density={overlay ? "comfortable" : "default"} layout={overlay ? "flow" : "columns"} groupIdentifiers={!!overlay} />
        ) : !transactionContext && query.isPending ? (
          <Loading label="正在读取流水…" />
        ) : null}
        {!ledger && (
          <ErrorNotice
            scope="page"
            error={query.error}
            retry={() => {
              void query.refetch();
            }}
          />
        )}
        <CandidateEvidence candidate={candidate} ledger={entry} density={overlay ? "comfortable" : "default"} layout={overlay ? "flow" : "columns"} />
        <EvidenceSection title="处理记录">
        <DetailFields
          items={[
            ["形成时间", dateTime(candidate.created_at)],
            ...(candidate.decided_at
              ? [["决定时间", dateTime(candidate.decided_at)] as const]
              : []),
          ]}
        />
        </EvidenceSection>
        <RecordTools
          technical={!overlay}
          data={candidate}
          identifiers={[["可能匹配记录编号", candidate.candidate_id]]}
          label="可能匹配记录操作"
          to={
            embedded
              ? "/reconciliation/candidates/" + candidate.candidate_id
              : undefined
          }
        />
        {overlay && <TechnicalDetails title="匹配记录技术信息" data={candidate} identifiers={[["可能匹配记录编号", candidate.candidate_id]]} />}
      </CardContent>
      {canAssociate && entry && (
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
