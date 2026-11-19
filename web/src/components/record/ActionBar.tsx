import { useRef, useState, type ReactNode } from "react";
import { Code } from "lucide-react";
import { preciseDateTime } from "@/lib/format";
import { OverlayActions } from "@/components/overlay-actions";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TechnicalDetailsDialog } from "@/components/detail/DetailPrimitives";
import { ActionMenu, type RecordAction } from "./ActionMenu";

export type TechnicalEntry = {
  title: string;
  data: unknown;
  identifiers?: ReadonlyArray<readonly [string, string | null]>;
  /** Distinguishes entries that share a title; defaults to the title. */
  id?: string;
  /** Shown after the title in the menu, to tell entries with the same title apart. */
  note?: string;
};

/** A technical entry with the time that tells it apart from others of its kind. */
export type DatedTechnicalEntry = TechnicalEntry & { created: string };

/** Entries that share a title are told apart by when their record was created. */
export function technicalEntries(entries: readonly DatedTechnicalEntry[]): TechnicalEntry[] {
  const titles = new Map<string, number>();
  for (const entry of entries) titles.set(entry.title, (titles.get(entry.title) ?? 0) + 1);
  return entries.map(({ created, ...entry }) => titles.get(entry.title)! > 1 ? { ...entry, note: preciseDateTime(created) } : entry);
}

/**
 * The record's fixed footer. At most one filled primary and one outlined
 * secondary action sit on the right; destructive actions and the record's only
 * "技术信息" entry go into the menu on the left.
 */
export function ActionBar({ primary, secondary, menu = [], menuLabel, technical = [] }: {
  primary?: ReactNode;
  secondary?: ReactNode;
  menu?: readonly RecordAction[];
  /** Accessible name of the menu, such as "更多操作，订单操作". */
  menuLabel: string;
  /** Raw data of the record and its sub-records, each opened from the menu. */
  technical?: readonly TechnicalEntry[];
}) {
  const [shown, setShown] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!primary && !secondary && !menu.length && !technical.length) return null;
  const key = (entry: TechnicalEntry) => entry.id ?? entry.title;
  return <OverlayActions className="justify-start">
    <ActionMenu align="start" actions={menu} label={menuLabel} text="更多" triggerRef={trigger}
      extra={technical.map(entry => <DropdownMenuItem key={key(entry)} onClick={() => setShown(key(entry))}>
        <Code aria-hidden="true" />{entry.title}{entry.note && <> · <span className="text-muted-foreground">{entry.note}</span></>}
      </DropdownMenuItem>)} />
    {(primary || secondary) && <div data-record-primary-actions className="ml-auto flex min-w-0 flex-wrap justify-end gap-2 max-md:flex-1 max-md:[&>*]:flex-1">{secondary}{primary}</div>}
    {technical.map(entry => <TechnicalDetailsDialog key={key(entry)} open={shown === key(entry)} onOpenChange={open => setShown(open ? key(entry) : null)}
      finalFocus={() => trigger.current} data={entry.data} identifiers={entry.identifiers ?? []} title={entry.title} />)}
  </OverlayActions>;
}
