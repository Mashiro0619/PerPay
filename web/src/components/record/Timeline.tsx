import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { preciseDateTime } from "@/lib/format";
import { Disclosure } from "./Disclosure";

/** A time to the second, as record details show it. */
export function RecordTime({ value, className }: { value: string | number | null | undefined; className?: string }) {
  const formatted = preciseDateTime(value);
  if (formatted === "—") return <span className={className}>—</span>;
  return <time dateTime={new Date(value!).toISOString()} title={formatted + "（北京时间）"} className={cn("tabular-nums", className)}>{formatted}</time>;
}

export type TimelineEntry = {
  id: string;
  title: ReactNode;
  time: string | number;
  body?: ReactNode;
  tone?: "default" | "success" | "danger" | "muted";
};

const dots = {
  default: "bg-foreground",
  success: "bg-success-foreground",
  danger: "bg-destructive",
  muted: "border border-muted-foreground bg-popover",
} as const;

function Entries({ entries, label }: { entries: readonly TimelineEntry[]; label: string }) {
  return <ol aria-label={label} className="relative flex min-w-0 flex-col gap-3 before:absolute before:inset-y-2 before:left-[3px] before:w-px before:bg-border">
    {entries.map(entry => <li key={entry.id} data-timeline-tone={entry.tone ?? "default"} className="relative grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3">
      <span aria-hidden="true" className={cn("size-2 self-start rounded-full mt-1.5", dots[entry.tone ?? "default"])} />
      <span className="min-w-0 text-sm leading-5 font-medium wrap-anywhere">{entry.title}</span>
      <RecordTime value={entry.time} className="text-xs leading-5 whitespace-nowrap text-muted-foreground max-md:col-start-2 max-md:row-start-2" />
      {entry.body && <div className="col-start-2 col-end-4 min-w-0 text-[0.8125rem] leading-5 whitespace-pre-wrap text-muted-foreground wrap-anywhere">{entry.body}</div>}
    </li>)}
  </ol>;
}

/** Newest-first events in one column: marker, title, and a right-aligned time. */
export function Timeline({ entries, label, initial = 6, moreLabel = "更早记录", empty = "暂无记录" }: {
  entries: readonly TimelineEntry[];
  label: string;
  /** Entries shown before the rest is collapsed. */
  initial?: number;
  moreLabel?: string;
  empty?: ReactNode;
}) {
  if (!entries.length) return <p className="text-[0.8125rem] leading-5 text-muted-foreground">{empty}</p>;
  const rest = entries.slice(initial);
  return <div className="flex min-w-0 flex-col gap-2" data-record-timeline>
    <Entries entries={entries.slice(0, initial)} label={label} />
    {rest.length > 0 && <Disclosure label={moreLabel} count={rest.length}><Entries entries={rest} label={moreLabel} /></Disclosure>}
  </div>;
}
