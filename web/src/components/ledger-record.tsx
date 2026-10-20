import type { AdminLedgerFacts, AdminLedgerMatch, AdminLedgerSummary } from "@/api/client";
import { Link } from "@/navigation";
import { label } from "@/lib/labels";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/business-status";
import { ListMoney } from "@/components/list-primitives";

export function ledgerHasAnomaly(entry: Pick<AdminLedgerSummary, "content_consistent" | "has_conflicts" | "active_match_count">) {
  return !entry.content_consistent || entry.has_conflicts || entry.active_match_count > 1;
}

export function LedgerStates({ entry }: { entry: Pick<AdminLedgerSummary, "states" | "content_consistent" | "has_conflicts" | "active_match_count"> }) {
  return <div className="business-cell-badges flex flex-wrap items-center gap-1.5">
    {ledgerHasAnomaly(entry) && <Badge variant="destructive">需要核查</Badge>}
    {entry.states.map(state => <Badge key={state} variant={state === "CONFLICT" ? "destructive" : state === "ALLOCATED" ? "success" : "secondary"}>{label(state)}</Badge>)}
  </div>;
}

export function LedgerDirection({ value, disputed = false }: { value: AdminLedgerFacts["direction"]; disputed?: boolean }) {
  return value ? <StatusBadge value={value} /> : <span className="text-muted-foreground">{disputed ? "有争议" : "—"}</span>;
}

export function LedgerMoney({ entry }: { entry: Pick<AdminLedgerSummary, "amount_cents" | "content_consistent"> }) {
  return entry.amount_cents === null && !entry.content_consistent
    ? <span className="text-muted-foreground">有争议</span>
    : <ListMoney value={entry.amount_cents} />;
}

export function LedgerOrderLink({ match }: { match: AdminLedgerMatch | null }) {
  return match ? <Link global className="list-code reconciliation-order-link" to={"/orders/" + match.order_id} aria-label={"查看订单：" + match.merchant_order_no} title={match.merchant_order_no}>{match.merchant_order_no}</Link> : <span className="text-muted-foreground">未关联</span>;
}

export function LedgerActiveOrder({ entry }: { entry: Pick<AdminLedgerSummary, "active_match" | "active_match_count"> }) {
  if (entry.active_match_count > 1) return <span className="text-destructive">多条生效关联 · 请核查</span>;
  return <LedgerOrderLink match={entry.active_match} />;
}

export function ledgerFact(value: string | null) {
  return value ?? "—";
}
