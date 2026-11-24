import { cn } from "cn";

/**
 * Visually truncates long identifiers in the middle while keeping the full
 * text in the DOM for find-in-page, copy, and assistive technology.
 */
export function ShortId({
  value,
  className,
  title,
}: {
  value: string | null | undefined;
  className?: string;
  title?: string;
}) {
  if (!value) return <>—</>;
  if (value.length <= 16) {
    return <span className={cn("short-id", className)} title={title}>{value}</span>;
  }
  const prefix = value.slice(0, -6);
  const suffix = value.slice(-6);
  return (
    <span className={cn("short-id", className)} title={title ?? value}>
      <span className="short-id-head">{prefix}</span>
      {suffix}
    </span>
  );
}
