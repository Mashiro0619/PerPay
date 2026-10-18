import { BUSINESS_TIME_ZONE, dateTime } from "@/lib/format";

const time = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function LedgerFreshness({ value }: { value: number | null | undefined }) {
  const date = typeof value === "number" ? new Date(value) : null;
  const valid = date && Number.isFinite(date.getTime());
  return (
    <p className="text-xs text-muted-foreground" data-ledger-freshness>
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
