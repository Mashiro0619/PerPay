import { useId, useState } from "react";
import { ArrowLeftRight, ChevronDown, CircleAlert } from "lucide-react";
import type { LedgerConflictDetail } from "@/api/client";
import { comparisonAmount, conflictComparison } from "@/lib/conflict-comparison";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOverlayContext } from "@/lib/overlay-context";
import { useListSize } from "@/hooks/use-list-size";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Item,
  ItemGroup,
  ItemHeader,
  ItemTitle,
  ItemContent,
} from "@/components/ui/item";
type ComparisonRow = ReturnType<typeof conflictComparison>[number];
function Difference({ row }: { row: ComparisonRow }) {
  if (!row.differs && !row.invalid)
    return (
      <span className="text-muted-foreground" role="img" aria-label="未标记差异">
        —
      </span>
    );
  const Icon = row.invalid ? CircleAlert : ArrowLeftRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap",
        row.invalid && "text-destructive",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {row.invalid ? "异常" : "不同"}
    </span>
  );
}
export function ConflictComparison({
  detail,
}: {
  detail: LedgerConflictDetail;
}) {
  if (!detail.incoming_event && !detail.existing_ledger_entry) return null;
  return <ComparisonContent key={detail.conflict.conflict_id} detail={detail} />;
}
function ComparisonContent({
  detail,
}: {
  detail: LedgerConflictDetail;
}) {
  const titleId = useId();
  const [showSame, setShowSame] = useState(false);
  const overlay = useOverlayContext();
  const { ref, isSummary } = useListSize<HTMLElement>();
  const existing = detail.existing_ledger_entry;
  const rows = conflictComparison(detail).map((row) => {
    if (row.name !== "支付宝交易金额" || row.invalid) return row;
    const cents = comparisonAmount(row.incoming);
    return cents === null ? row : { ...row, incoming: money(cents) };
  });
  const attention = rows.filter((row) => row.differs || row.invalid);
  const remaining = rows.filter((row) => !row.differs && !row.invalid);
  const canCompare = !!existing && !!detail.incoming_event;
  const visibleRows = canCompare ? attention : [...attention, ...remaining];
  return (
    <section
      ref={ref}
      className={cn("flex w-full min-w-0 flex-col gap-3", overlay && "detail-section")}
      aria-labelledby={titleId}
      data-conflict-comparison
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 id={titleId} className="text-sm font-medium">
          交易对照
        </h3>
        {!existing && (
          <p className="text-xs text-muted-foreground">无可对照流水</p>
        )}
      </div>
      {canCompare && (
        <p className="text-sm text-muted-foreground" data-comparison-summary>
          {attention.length > 0
            ? `${attention.length} 项需核对 · ${remaining.length} 项相同`
            : "当前对照字段未标记差异"}
        </p>
      )}
      {visibleRows.length > 0 && (
        <ComparisonRows
          rows={visibleRows}
          existing={!!existing}
          isSummary={isSummary}
          label={isSummary ? "逐字段交易对照" : "交易对照"}
        />
      )}
      {canCompare && remaining.length > 0 && (
        <Collapsible open={showSame} onOpenChange={setShowSame} className="flex min-w-0 flex-col gap-3">
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />} className="h-auto min-h-8 max-w-full self-start whitespace-normal">
            <ChevronDown data-icon="inline-start" className={cn(showSame && "rotate-180")} />
            {showSame ? "收起" : "查看"}相同字段（{remaining.length}）
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ComparisonRows rows={remaining} existing isSummary={isSummary} label="相同字段对照" />
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

function ComparisonRows({
  rows,
  existing,
  isSummary,
  label,
}: {
  rows: ComparisonRow[];
  existing: boolean;
  isSummary: boolean;
  label: string;
}) {
  return (
    !isSummary ? (
      <div
        className="business-table-surface"
        data-embedded="true"
        data-density="compact"
        data-comparison-desktop
      >
        <Table aria-label={label} className="business-table table-fixed">
          <colgroup>
            <col className="w-32" />
            <col />
            {existing && <col />}
            <col className="w-20" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>字段</TableHead>
              <TableHead className="whitespace-normal">本次收到的记录{existing && "（新值）"}</TableHead>
              {existing && <TableHead className="whitespace-normal">已保存的支付宝流水（旧值）</TableHead>}
              <TableHead>{existing ? "差异" : "校验结果"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.name}
                data-different={row.differs || undefined}
                data-invalid={row.invalid || undefined}
              >
                <TableHead scope="row" className="whitespace-normal">
                  {row.name}
                </TableHead>
                <TableCell className="whitespace-pre-wrap wrap-anywhere">
                  {row.incoming ?? "未提供"}
                </TableCell>
                {existing && (
                  <TableCell className="whitespace-pre-wrap wrap-anywhere">
                    {row.existing ?? "未提供"}
                  </TableCell>
                )}
                <TableCell data-comparison-result>
                  <Difference row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      ) : (
      <ItemGroup
        role="group"
        aria-label={label}
        className="record-list"
        data-density="compact"
        data-comparison-mobile
      >
        {rows.map((row) => (
          <Item
            key={row.name}
            role="group"
            aria-label={row.name}
            size="xs"
            className="record-list-row items-stretch"
            data-comparison-field
          >
            <ItemHeader>
              <ItemTitle className="record-list-title">{row.name}</ItemTitle>
              <span data-comparison-result>
                <Difference row={row} />
              </span>
            </ItemHeader>
            <ItemContent className="min-w-0">
              <dl className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">本次收到的记录{existing && "（新值）"}</dt>
                  <dd className="whitespace-pre-wrap wrap-anywhere">
                    {row.incoming ?? "未提供"}
                  </dd>
                </div>
                {existing && (
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">已保存的支付宝流水（旧值）</dt>
                    <dd className="whitespace-pre-wrap wrap-anywhere">
                      {row.existing ?? "未提供"}
                    </dd>
                  </div>
                )}
              </dl>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      )
  );
}
