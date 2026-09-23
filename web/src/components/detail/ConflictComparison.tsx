import { useId } from "react";
import { ArrowLeftRight, CircleAlert } from "lucide-react";
import type { LedgerConflictDetail } from "@/api/client";
import { conflictComparison } from "@/lib/conflict-comparison";
import { cn } from "@/lib/utils";
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
      <span className="text-muted-foreground" aria-label="未标记差异">
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
  const titleId = useId();
  const existing = detail.existing_ledger_entry;
  if (!detail.incoming_event && !existing) return null;
  const rows = conflictComparison(detail);
  return (
    <section
      className="@container/comparison flex w-full min-w-0 max-w-5xl flex-col gap-3"
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
      <div
        className="hidden min-w-0 overflow-hidden rounded-lg border @[640px]/comparison:block"
        data-comparison-desktop
      >
        <Table aria-labelledby={titleId} className="table-fixed">
          <colgroup>
            <col className="w-32" />
            <col />
            {existing && <col />}
            <col className="w-20" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>字段</TableHead>
              <TableHead>传入记录</TableHead>
              {existing && <TableHead>已有流水</TableHead>}
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
                <TableHead scope="row" className="align-top whitespace-normal">
                  {row.name}
                </TableHead>
                <TableCell className="align-top whitespace-pre-wrap wrap-anywhere">
                  {row.incoming ?? "未提供"}
                </TableCell>
                {existing && (
                  <TableCell className="align-top whitespace-pre-wrap wrap-anywhere">
                    {row.existing ?? "未提供"}
                  </TableCell>
                )}
                <TableCell className="align-top" data-comparison-result>
                  <Difference row={row} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ItemGroup
        role="group"
        aria-label="逐字段交易对照"
        className="@[640px]/comparison:hidden"
        data-comparison-mobile
      >
        {rows.map((row) => (
          <Item
            key={row.name}
            role="group"
            aria-label={row.name}
            variant="outline"
            size="sm"
            className="min-w-0 items-stretch"
            data-comparison-field
          >
            <ItemHeader>
              <ItemTitle>{row.name}</ItemTitle>
              <span data-comparison-result>
                <Difference row={row} />
              </span>
            </ItemHeader>
            <ItemContent className="min-w-0">
              <dl className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">传入记录</dt>
                  <dd className="whitespace-pre-wrap wrap-anywhere">
                    {row.incoming ?? "未提供"}
                  </dd>
                </div>
                {existing && (
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-xs text-muted-foreground">已有流水</dt>
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
    </section>
  );
}
