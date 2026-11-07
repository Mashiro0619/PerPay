import { Children, createContext, useContext, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { dateTime, money } from "@/lib/format";
import { ItemActions, ItemContent, ItemHeader, ItemTitle } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const CompactRowContext = createContext(false);
/** Full details belong to the record surface; embedded summaries keep their own layout. */
export function ListRowPresentation({ compact, children }: { compact: boolean; children: ReactNode }) {
  return <CompactRowContext value={compact}>{children}</CompactRowContext>;
}

/** Shared typography for tables, overview rows and record summaries. */
export function ListIdentity({
  children,
  meta,
  description,
}: {
  children: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
}) {
  const compact = useContext(CompactRowContext);
  return (
    <div className="list-identity">
      <ItemTitle className="list-identity-title">{children}</ItemTitle>
      {!compact && meta && <div className="list-identity-meta">{meta}</div>}
      {!compact && description && <div className="list-identity-description">{description}</div>}
    </div>
  );
}

export function ListMeta({ children }: { children: ReactNode }) {
  return <div className="list-meta">{children}</div>;
}

export function ListMoney({
  value,
  secondary = false,
  label,
}: {
  value: number | null | undefined;
  secondary?: boolean;
  label?: string;
}) {
  const formatted = money(value);
  return (
    <span
      className={cn("list-money", secondary && "list-money-secondary")}
      data-empty={value == null || undefined}
      data-wide={formatted.length > 15 || undefined}
      role={label ? "group" : undefined}
      aria-label={label ? `${label} ${formatted}` : undefined}
    >
      {formatted}
    </span>
  );
}

export function ListDateTime({
  value,
  inline = false,
}: {
  value: string | number | null | undefined;
  inline?: boolean;
}) {
  const formatted = dateTime(value);
  if (formatted === "—") return <span className="list-time-empty">—</span>;
  const date = new Date(value!);
  const split = formatted.lastIndexOf(" ");
  return (
    <time
      className={cn("list-time", inline && "list-time-inline")}
      dateTime={date.toISOString()}
      title={formatted + "（北京时间）"}
    >
      {inline || split < 0 ? formatted : (
        <>
          <span>{formatted.slice(0, split)}</span>{" "}
          <span className="list-time-clock">{formatted.slice(split + 1)}</span>
        </>
      )}
    </time>
  );
}

export function ListSummary({
  identity,
  aside,
  source,
  layout,
  status,
  message,
  metadata,
  children,
  details,
  actions,
}: {
  identity: ReactNode;
  aside?: ReactNode;
  /** Cross-site context stays visible alongside the record's primary fields. */
  source?: ReactNode;
  /** Stable title, status and metadata rows for standalone record lists. */
  layout?: "record" | "order";
  status?: ReactNode;
  message?: ReactNode;
  metadata?: ReactNode;
  children?: ReactNode;
  /** Selected secondary fields; unmounted after this record finishes collapsing. */
  details?: ReactNode;
  actions?: ReactNode;
}) {
  const compact = useContext(CompactRowContext);
  const fields = Children.toArray(children);
  return (
    <ItemContent className="min-w-0 w-full" data-summary-layout={layout}>
      <ItemHeader className="list-summary-heading">
        <div className="list-summary-identity">{identity}</div>
        {aside && <ItemActions className="list-summary-aside">{aside}</ItemActions>}
      </ItemHeader>
      {status && <div data-summary-status>{status}</div>}
      {compact && source && <div className="list-summary-source flex min-w-0 items-baseline gap-1.5"><span className="shrink-0">网站</span>{source}</div>}
      {message && <div data-summary-message>{message}</div>}
      {fields.length > 0 && <dl className="business-summary-fields">{fields}</dl>}
      {metadata}
      <ListSummaryDetails>{details}</ListSummaryDetails>
      {actions && <ItemActions className="w-full flex-wrap justify-end" data-summary-actions>{actions}</ItemActions>}
    </ItemContent>
  );
}

/** Also shared by overview records whose primary layout differs from ListSummary. */
export function ListSummaryDetails({ children }: { children?: ReactNode }) {
  const compact = useContext(CompactRowContext);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  function handleOpenChange(open: boolean) {
    if (!open && panelRef.current?.contains(panelRef.current.ownerDocument.activeElement)) {
      triggerRef.current?.focus();
    }
    setExpanded(open);
  }
  if (compact || Children.toArray(children).length === 0) return null;
  const label = expanded ? "收起信息" : "展开信息";
  return (
    <Collapsible open={expanded} onOpenChange={handleOpenChange} className="list-summary-details">
      <Tooltip>
        <CollapsibleTrigger
          ref={triggerRef}
          aria-label={label}
          render={<TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="list-summary-toggle" />} />}
        >
          <ChevronDown
            data-icon="inline-end"
            aria-hidden="true"
            className={cn("transition-transform duration-[var(--console-motion,200ms)] ease-[var(--console-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none", expanded && "rotate-180")}
          />
        </CollapsibleTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <CollapsibleContent
        ref={panelRef}
        className="-mx-1 h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-[var(--console-motion,200ms)] ease-[var(--console-ease,cubic-bezier(0.22,1,0.36,1))] data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none"
        inert={!expanded}
        aria-hidden={!expanded || undefined}
      >
        {/* Leave room for link focus outlines without shifting the field columns. */}
        <dl className="business-summary-fields px-1">{children}</dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ListSummaryField({
  label,
  children,
  visibleLabel = false,
  fullWidth = false,
}: {
  label: string;
  children: ReactNode;
  visibleLabel?: boolean;
  fullWidth?: boolean;
}) {
  return (
    <div className={cn("business-summary-field", fullWidth && "col-span-full")} data-visible-label={visibleLabel || undefined} data-full-width={fullWidth || undefined}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
