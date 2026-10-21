import { BUSINESS_TIME_ZONE, dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function LedgerFreshness({ value, size = "sm" }: { value: number | null | undefined; size?: "sm" | "default" }) {
  const date = typeof value === "number" ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
  return (
    <p className={cn("text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")} data-ledger-freshness>
      最近查账成功：
      {valid ? (
        <time dateTime={date.toISOString()} title={dateTime(value)}>
          {time.format(date)}
        </time>
      ) : (
        <span>{value === null ? "暂无记录" : "暂不可用"}</span>
      )}
    </p>
  );
}
