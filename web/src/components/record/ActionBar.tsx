import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Code, ExternalLink } from "lucide-react";
import { Link } from "@/navigation";
import { preciseDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { OverlayActions } from "@/components/overlay-actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TechnicalDetailsDialog } from "@/components/detail/DetailPrimitives";
import { ActionMenu, type RecordAction } from "./ActionMenu";

const COMPACT_FOOTER_QUERY = "(max-width: 767px)";

function useCompactFooter() {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COMPACT_FOOTER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_FOOTER_QUERY);
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function isRecordAction(value: ReactNode | RecordAction | undefined): value is RecordAction {
  return typeof value === "object" && value !== null && !isValidElement(value) && !Array.isArray(value) && "label" in value && typeof value.label === "string";
}

const wrappingAction = "h-auto min-h-8 min-w-0 max-w-full whitespace-normal py-1.5";

function actionButtonClass(variant: "default" | "outline" = "default") {
  return cn(buttonVariants({ variant }), wrappingAction);
}

function BarAction({ action, variant }: { action: RecordAction; variant: "default" | "outline" }) {
  if (action.href && !action.disabled) return <a className={actionButtonClass(variant)} href={action.href} target="_blank" rel="noopener noreferrer" title={action.title}>
    {action.label}<ExternalLink data-icon="inline-end" aria-hidden="true" />
  </a>;
  if (action.to && !action.disabled) return <Link to={action.to} global={action.global ?? false} className={actionButtonClass(variant)}>{action.label}</Link>;
  return <Button type="button" variant={action.danger ? "destructive" : variant} data-danger={action.danger || undefined} className={wrappingAction} disabled={action.disabled}
    onClick={event => action.onSelect?.(event.currentTarget)}>{action.label}</Button>;
}

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
 * "技术信息" entry go into the menu on the left. On phones, a secondary
 * RecordAction beside a primary one moves into the menu so the primary button
 * keeps full breathing room.
 */
export function ActionBar({ primary, secondary, menu = [], menuLabel, technical = [] }: {
  primary?: ReactNode | RecordAction;
  secondary?: ReactNode | RecordAction;
  menu?: readonly RecordAction[];
  /** Accessible name of the menu, such as "更多操作，订单操作". */
  menuLabel: string;
  /** Raw data of the record and its sub-records, each opened from the menu. */
  technical?: readonly TechnicalEntry[];
}) {
  const compact = useCompactFooter();
  const [shown, setShown] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!primary && !secondary && !menu.length && !technical.length) return null;
  const secondaryAction = isRecordAction(secondary) ? secondary : null;
  const foldSecondary = !!secondaryAction && !!primary && compact;
  const effectiveMenu = foldSecondary ? [secondaryAction, ...menu] : menu;
  const visiblePrimary: ReactNode = isRecordAction(primary) ? <BarAction action={primary} variant="default" /> : primary;
  const visibleSecondary: ReactNode = isRecordAction(secondary)
    ? (foldSecondary ? null : <BarAction action={secondary} variant="outline" />)
    : secondary;
  const key = (entry: TechnicalEntry) => entry.id ?? entry.title;
  return <OverlayActions className="justify-start">
    <ActionMenu align="start" actions={effectiveMenu} label={menuLabel} text="更多" triggerRef={trigger}
      extra={technical.map(entry => <DropdownMenuItem key={key(entry)} onClick={() => setShown(key(entry))}>
        <Code aria-hidden="true" />{entry.title}{entry.note && <> · <span className="text-muted-foreground">{entry.note}</span></>}
      </DropdownMenuItem>)} />
    {(visiblePrimary || visibleSecondary) && <div data-record-primary-actions className="ml-auto flex min-w-0 flex-wrap justify-end gap-2 max-md:flex-1 max-md:[&>*]:flex-1">{visibleSecondary}{visiblePrimary}</div>}
    {technical.map(entry => <TechnicalDetailsDialog key={key(entry)} open={shown === key(entry)} onOpenChange={open => setShown(open ? key(entry) : null)}
      finalFocus={() => trigger.current} data={entry.data} identifiers={entry.identifiers ?? []} title={entry.title} />)}
  </OverlayActions>;
}
