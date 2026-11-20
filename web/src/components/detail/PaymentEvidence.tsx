import { useQuery } from "@/lib/workspace-query";
import { useWorkspaceApi } from "@/workspace";
import { useId } from "react";
import { result, type ReconciliationLedgerEntry } from "@/api/client";
import { detailTimestamp } from "@/lib/detail-summary";
import { ListMoney } from "@/components/list-primitives";
import { cn } from "@/lib/utils";
import { useOverlayContext } from "@/lib/overlay-context";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { DetailCredentials, DetailFields, type DetailDensity, type DetailFieldLayout } from "./DetailPrimitives";

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
