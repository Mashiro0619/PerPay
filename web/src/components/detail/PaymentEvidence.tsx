import { useQuery } from '@/lib/workspace-query';
import { useWorkspaceApi } from "@/workspace";
import { Link } from "@/navigation";
import { useId, type ReactNode } from "react";

import { result, type AdminOrderDetail, type MatchCandidate, type PaymentMatchDetail, type ReconciliationLedgerEntry, type ReconciliationOrder } from "@/api/client";
import {
  candidateFacts,
  candidateFactsBeyondLedger,
  candidateGuidance,
  detailTimestamp,
} from "@/lib/detail-summary";
import { dateTime, money } from "@/lib/format";
import { ListDateTime, ListMoney } from "@/components/list-primitives";
import { cn } from "@/lib/utils";
import { useOverlayContext } from "@/lib/overlay-context";
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
  const overlay = useOverlayContext();
  const operation = match.creation_operation;
  const reversal =
    match.status === "REVERSED" ? match.resolution_operation : null;
  const technicalInformation = overlay ? <TechnicalDetails title="收款关联技术信息" data={match} identifiers={[
    ["关联编号", match.payment_match_id],
    ["流水编号", match.ledger_entry_id],
    ["可能匹配记录编号", match.candidate_id],
    ...((transactionContext || (density === "comfortable" && !embedded)) ? [
      ["内部订单编号", match.order.order_id],
      ["网站编号", match.order.api_client_id],
    ] as const : []),
  ]} /> : null;
  if (transactionContext) return (
    <Card aria-label="收款关联记录" data-match-summary>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <CardTitle className="min-w-0 flex-1 basis-48" role="heading" aria-level={3}>{match.status === "REVERSED" ? "已撤销的关联" : "当前关联订单"}</CardTitle>
        <CardAction className="flex max-w-full flex-wrap items-center gap-2">
          <StatusBadge value={match.status} />
          <ReverseMatchAction match={match} inline technical={!overlay} includeOrderIdentifiers movesOnSuccess />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-2">
        <OrderFacts order={match.order} density="comfortable" layout="flow" />
        <MatchProcessingHistory match={match} />
        <DetailFields density="comfortable" layout="flow" items={[
          ["使用的查账记录", <div className="flex flex-wrap items-center gap-3"><CopyValue value={match.ledger_entry_id} label="复制使用的查账记录编号" /><Link to={"#source-" + match.ledger_entry_id} onClick={() => document.getElementById("source-" + match.ledger_entry_id)?.scrollIntoView({ block: "start" })}>核对这份记录</Link></div>],
        ]} />
        {technicalInformation}
      </CardContent>
    </Card>
  );
  if (density === "comfortable" && !embedded) {
    const manual = match.evidence_type === "MANUAL";
    return (
      <>
        <Card aria-label="收款关联记录" data-match-summary>
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle className="min-w-0 flex-1 basis-48" role="heading" aria-level={2}>关联摘要与订单</CardTitle>
            <CardAction className="flex max-w-full flex-wrap items-center gap-2">
              <StatusBadge value={match.status} />
              <ReverseMatchAction match={match} inline technical={!overlay} includeOrderIdentifiers />
            </CardAction>
          </CardHeader>
          <CardContent><OrderFacts order={match.order} density="comfortable" layout="flow" /></CardContent>
        </Card>
        <Card aria-label="支付宝交易" data-match-ledger>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>支付宝交易</CardTitle>
          </CardHeader>
          <CardContent><LedgerFacts entry={match.ledger_entry} density="comfortable" layout="flow" showHeading={false} groupIdentifiers={!!overlay} /></CardContent>
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
            {technicalInformation}
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
        <LedgerFacts entry={match.ledger_entry} compact={embedded} density={overlay ? "comfortable" : "default"} layout={overlay ? "flow" : "columns"} groupIdentifiers={!!overlay} collapseCredentials={embedded && match.status === "SETTLED" && match.order.payment_status === "CONFIRMED"} />
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
        <ReverseMatchAction match={match} embedded={embedded} technical={!overlay} />
        {technicalInformation}
      </CardContent>
    </Card>
  );
}
/** Shared evidence; a transaction detail does not repeat its Alipay facts here. */
function MatchProcessingHistory({ match }: { match: PaymentMatchDetail }) {
  const overlay = useOverlayContext();
  const manual = match.evidence_type === "MANUAL";
  const operation = match.creation_operation;
  const reversal = match.status === "REVERSED" ? match.resolution_operation : null;
  return <div className="flex min-w-0 flex-col gap-2" data-match-evidence>
    {match.candidate && <CandidateEvidence candidate={match.candidate} ledger={match.ledger_entry} density="comfortable" layout="flow" />}
    <section aria-label={manual ? "人工关联记录" : "关联记录"} className={cn("flex min-w-0 flex-col gap-4", overlay && "detail-section")}>
      <h4 className="text-sm font-medium">{manual ? "人工关联记录" : "关联记录"}</h4>
      <DetailFields density="comfortable" layout="flow" wide={["关联理由"]} items={[
        ["关联方式", manual ? "管理员人工关联" : "PerPay 按金额和付款时间推断"],
        ["关联时间", dateTime(operation?.created_at ?? match.created_at)],
        ...(manual ? [["关联操作人", operation?.actor_id ?? "未记录"] as const] : []),
        ...(operation?.reason ? [["关联理由", operation.reason] as const] : []),
      ]} />
    </section>
    {match.status === "REVERSED" && <section aria-label="撤销记录" className={cn("flex min-w-0 flex-col gap-4", overlay && "detail-section")}>
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
