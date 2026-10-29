import { Children, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { dateTime, money } from "@/lib/format";
import { ItemActions, ItemContent, ItemHeader, ItemTitle } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
  return (
    <div className="list-identity">
      <ItemTitle className="list-identity-title">{children}</ItemTitle>
      {meta && <div className="list-identity-meta">{meta}</div>}
      {description && <div className="list-identity-description">{description}</div>}
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
  children,
  details,
}: {
  identity: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  /** Selected secondary fields; unmounted after this record finishes collapsing. */
  details?: ReactNode;
}) {
  const hasFields = Children.toArray(children).length > 0;
  return (
    <ItemContent className="min-w-0 w-full">
      <ItemHeader className="list-summary-heading">
        <div className="list-summary-identity">{identity}</div>
        {aside && <ItemActions className="list-summary-aside">{aside}</ItemActions>}
      </ItemHeader>
      {hasFields && <dl className="business-summary-fields">{children}</dl>}
      <ListSummaryDetails>{details}</ListSummaryDetails>
    </ItemContent>
  );
}

/** Also shared by overview records whose primary layout differs from ListSummary. */
export function ListSummaryDetails({ children }: { children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  function handleOpenChange(open: boolean) {
    if (!open && panelRef.current?.contains(panelRef.current.ownerDocument.activeElement)) {
      triggerRef.current?.focus();
    }
    setExpanded(open);
  }
  if (Children.toArray(children).length === 0) return null;
  return (
    <Collapsible open={expanded} onOpenChange={handleOpenChange} className="list-summary-details">
      <CollapsibleTrigger
        ref={triggerRef}
        render={<Button type="button" variant="ghost" size="sm" className="list-summary-toggle" />}
      >
        {expanded ? "收起信息" : "展开信息"}
        <ChevronDown
          data-icon="inline-end"
          aria-hidden="true"
          className={cn("transition-transform duration-[var(--console-motion,200ms)] ease-[var(--console-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none", expanded && "rotate-180")}
        />
      </CollapsibleTrigger>
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
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="business-summary-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
