import type { ReactNode } from "react";
import { cn } from "cn";
import { dateTime, money } from "@/lib/format";

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
      <div className="list-identity-title">{children}</div>
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
      aria-label={formatted}
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
}: {
  identity: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="list-summary">
      <div className="list-summary-heading">
        <div className="list-summary-identity">{identity}</div>
        {aside && <div className="list-summary-aside">{aside}</div>}
      </div>
      {children && <dl className="business-summary-fields">{children}</dl>}
    </div>
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
