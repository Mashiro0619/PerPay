import { useEffect, useState } from "react";
import { BUSINESS_TIME_ZONE, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOptionalSystemStatus } from "@/features/system-status";

const dayKey = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const monthDayTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const yearMonthDayTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function dateParts(date: Date): { year: string; day: string } {
  const parts = dayKey.formatToParts(date);
  const year = parts.find(part => part.type === "year")?.value ?? "";
  const month = parts.find(part => part.type === "month")?.value ?? "";
  const day = parts.find(part => part.type === "day")?.value ?? "";
  return { year, day: `${year}-${month}-${day}` };
}

function formatFreshnessTime(date: Date, now: Date): string {
  const target = dateParts(date);
  const current = dateParts(now);
  if (target.day === current.day) return time.format(date);
  return target.year === current.year
    ? monthDayTime.format(date)
    : yearMonthDayTime.format(date);
}

/** Milliseconds until the next Beijing midnight (UTC+8, no DST). */
function msUntilNextBusinessMidnight(nowMs: number): number {
  const offset = 8 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const elapsed = ((nowMs + offset) % dayMs + dayMs) % dayMs;
  return dayMs - elapsed + 1000;
}

/** Undefined selects the global overview; null means a record has no known account. */
export function AccountLedgerFreshness({ accountId, size }: { accountId?: string | null | undefined; size?: "sm" | "default" }) {
  const system = useOptionalSystemStatus();
  const status = system && !system.checking && !system.unavailable ? system.status.data?.data : undefined;
  const accounts = status?.alipay_accounts;
  const lastSuccess = accountId ? accounts?.find(account => account.id === accountId)?.health?.last_success_at : undefined;
  const value = accountId === undefined ? status?.ledger.last_success_at
    : lastSuccess === null ? null : lastSuccess === undefined ? undefined : Date.parse(lastSuccess);
  const multipleAccounts = accountId === undefined && (accounts ? accounts.length > 1 : true);
  return <LedgerFreshness value={value} size={size} scope={accountId === undefined ? (multipleAccounts ? "all" : undefined) : "account"} />;
}

export function LedgerFreshness({ value, size = "sm", scope }: { value: number | null | undefined; size?: "sm" | "default" | undefined; scope?: "all" | "account" }) {
  const [, setRollover] = useState(0);
  const date = typeof value === "number" ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
  useEffect(() => {
    if (!valid) return;
    const timer = setTimeout(() => setRollover(tick => tick + 1), msUntilNextBusinessMidnight(Date.now()));
    return () => clearTimeout(timer);
  }, [valid, value]);
  return (
    <p className={cn("text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")} data-ledger-freshness>
      {scope === "account" ? "本账号最近查账成功：" : "最近查账成功："}
      {valid ? (
        <time dateTime={date.toISOString()} title={dateTime(value)}>
          {formatFreshnessTime(date, new Date())}
        </time>
      ) : (
        <span>{value === null ? "暂无记录" : "暂不可用"}</span>
      )}
      {valid && scope === "all" && <span>（多账号取最新）</span>}
    </p>
  );
}
