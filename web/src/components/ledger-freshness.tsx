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

function formatFreshnessTime(date: Date, now: Date): string {
  const targetDay = dayKey.format(date);
  const currentDay = dayKey.format(now);
  if (targetDay === currentDay) return time.format(date);
  return targetDay.slice(0, 4) === currentDay.slice(0, 4)
    ? monthDayTime.format(date)
    : yearMonthDayTime.format(date);
}

/** Undefined selects the global overview; null means a record has no known account. */
export function AccountLedgerFreshness({ accountId, size }: { accountId?: string | null | undefined; size?: "sm" | "default" }) {
  const system = useOptionalSystemStatus();
  const status = system && !system.checking && !system.unavailable ? system.status.data?.data : undefined;
  const lastSuccess = accountId ? status?.alipay_accounts?.find(account => account.id === accountId)?.health?.last_success_at : undefined;
  const value = accountId === undefined ? status?.ledger.last_success_at
    : lastSuccess === null ? null : lastSuccess === undefined ? undefined : Date.parse(lastSuccess);
  return <LedgerFreshness value={value} size={size} scope={accountId === undefined ? "all" : "account"} />;
}

export function LedgerFreshness({ value, size = "sm", scope }: { value: number | null | undefined; size?: "sm" | "default" | undefined; scope?: "all" | "account" }) {
  const date = typeof value === "number" ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
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
