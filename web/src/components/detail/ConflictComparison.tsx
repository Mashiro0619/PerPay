import type { LedgerConflictDetail } from "@/api/client";
import { comparisonAmount, conflictComparison } from "@/lib/conflict-comparison";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useListSize } from "@/hooks/use-list-size";
import { Disclosure } from "@/components/record/Disclosure";
import { FieldList, type Field } from "@/components/record/FieldList";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type ComparisonRow = ReturnType<typeof conflictComparison>[number];

const note = "text-[0.8125rem] leading-5 text-muted-foreground";
const identifierFields = new Set(["支付宝流水号", "支付宝订单号", "支付宝商户单号"]);

function formatRows(detail: LedgerConflictDetail): ComparisonRow[] {
  return conflictComparison(detail).map((row) => {
    if (row.name !== "支付宝交易金额" || row.invalid) return row;
    const cents = comparisonAmount(row.incoming);
    return cents === null ? row : { ...row, incoming: money(cents) };
  });
}

/** Count of differing or invalid fields when both incoming and existing records are present. */
export function conflictAttentionCount(detail: LedgerConflictDetail): number {
  if (!detail.incoming_event || !detail.existing_ledger_entry) return 0;
  return formatRows(detail).filter((row) => row.differs || row.invalid).length;
}

/**
 * Compares an incoming conflict event against the existing ledger entry.
 * When both sides exist, differing or invalid fields lead and matching ones
 * fold away; when only one side exists, it is shown as a single field list.
 */
export function ConflictComparison({
  detail,
}: {
  detail: LedgerConflictDetail;
}) {
  if (!detail.incoming_event && !detail.existing_ledger_entry) return null;
  return <ComparisonContent key={detail.conflict.conflict_id} detail={detail} />;
}

function singleSideFields(rows: ComparisonRow[], side: "incoming" | "existing"): Field[] {
  return rows.map((row) => {
    const raw = row[side];
    const kind: Field["kind"] = identifierFields.has(row.name) && raw ? "id"
      : row.name === "支付宝交易金额" && !row.invalid ? "money"
        : row.name === "支付宝交易时间" && !row.invalid ? "time"
          : "text";
    return {
      label: row.name,
      kind,
      ...(kind === "id" && raw ? { copy: raw } : {}),
      value: row.invalid ? (
        <span className="inline-flex flex-wrap items-baseline gap-1.5" data-comparison-invalid>
          <span className="font-medium text-destructive">{raw ?? "未提供"}</span>
          <span className="text-xs font-medium text-destructive">异常</span>
        </span>
      ) : (raw ?? "未提供"),
    };
  });
}

function ComparisonContent({
  detail,
}: {
  detail: LedgerConflictDetail;
}) {
  const { ref, size } = useListSize<HTMLDivElement>();
  // A 3-column comparison table fits comfortably from 32rem up (44rem drawers are ~39.5rem inside).
  const compact = size.container > 0 && size.container < 32 * size.rem;
  const existing = detail.existing_ledger_entry;
  const incoming = detail.incoming_event;
  const rows = formatRows(detail);
  const attention = rows.filter((row) => row.differs || row.invalid);
  const remaining = rows.filter((row) => !row.differs && !row.invalid);
  const canCompare = !!existing && !!incoming;

  if (!canCompare) {
    return (
      <div ref={ref} className="flex w-full min-w-0 flex-col gap-3" data-conflict-comparison>
        <p className={note}>{existing ? "无本次收到的单笔记录，以下为已保存的支付宝流水。" : "无可对照流水"}</p>
        <FieldList items={singleSideFields(rows, incoming ? "incoming" : "existing")} />
      </div>
    );
  }

  return (
    <div ref={ref} className="flex w-full min-w-0 flex-col gap-3" data-conflict-comparison>
      <p className={note} data-comparison-summary>
        {attention.length > 0
          ? `${attention.length} 项需核对 · ${remaining.length} 项相同`
          : "当前对照字段未标记差异"}
      </p>
      {attention.length > 0 && (
        <ComparisonRows
          rows={attention}
          compact={compact}
          label={compact ? "逐字段交易对照" : "交易对照"}
        />
      )}
      {remaining.length > 0 && (
        <Disclosure label="相同字段" count={remaining.length}>
          <ComparisonRows rows={remaining} compact={compact} label="相同字段对照" />
        </Disclosure>
      )}
    </div>
  );
}

function ComparisonRows({
  rows,
  compact,
  label,
}: {
  rows: ComparisonRow[];
  compact: boolean;
  label: string;
}) {
  if (compact) {
    return (
      <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2" data-comparison-mobile>
        {rows.map((row) => (
          <div
            key={row.name}
            role="group"
            aria-label={row.name}
            data-comparison-field
            data-different={row.differs || undefined}
            data-invalid={row.invalid || undefined}
            className="flex min-w-0 flex-col gap-1.5 rounded-lg border px-3 py-2.5"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[0.8125rem] leading-5 font-medium text-foreground">{row.name}</span>
              {row.invalid && <span className="text-xs font-medium text-destructive" data-comparison-invalid>异常</span>}
              {!row.invalid && row.differs && <span className="text-xs font-medium text-destructive" data-comparison-diff>差异</span>}
            </div>
            <dl className="flex min-w-0 flex-col gap-2 text-sm leading-5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">本次收到（新值）</dt>
                <dd className={cn("min-w-0 whitespace-pre-wrap wrap-anywhere", (row.differs || row.invalid) && "font-medium text-destructive")}>
                  {row.incoming ?? "未提供"}
                </dd>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <dt className="text-xs text-muted-foreground">已有流水（旧值）</dt>
                <dd className="min-w-0 whitespace-pre-wrap wrap-anywhere">
                  {row.existing ?? "未提供"}
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="business-table-surface"
      data-embedded="true"
      data-density="compact"
      data-comparison-desktop
    >
      <Table aria-label={label} className="business-table table-fixed">
        <colgroup>
          <col className="w-[7.5rem]" />
          <col />
          <col />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>字段</TableHead>
            <TableHead className="whitespace-normal">本次收到（新值）</TableHead>
            <TableHead className="whitespace-normal">已有流水（旧值）</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.name}
              data-different={row.differs || undefined}
              data-invalid={row.invalid || undefined}
            >
              <TableHead scope="row" className="whitespace-normal text-[0.8125rem] font-normal text-muted-foreground">
                {row.name}
              </TableHead>
              <TableCell className={cn("whitespace-pre-wrap wrap-anywhere", (row.differs || row.invalid) && "font-medium text-destructive")}>
                {row.incoming ?? "未提供"}
                {row.invalid && <span className="ml-1.5 text-xs font-medium" data-comparison-invalid>（异常）</span>}
                {!row.invalid && row.differs && <span className="ml-1.5 text-xs font-medium" data-comparison-diff>（差异）</span>}
              </TableCell>
              <TableCell className="whitespace-pre-wrap wrap-anywhere">
                {row.existing ?? "未提供"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
