import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CopyValue } from "@/components/copy-value";

export type Field = {
  /** At most eight characters; put qualifiers into `hint`. */
  label: string;
  value: ReactNode;
  kind?: "text" | "money" | "id" | "time";
  /** Text placed on the clipboard by the row's copy button. */
  copy?: string | null | undefined;
  hint?: ReactNode;
};

const valueKinds = {
  text: "",
  money: "font-medium tabular-nums",
  id: "font-mono text-[0.8125rem]",
  time: "tabular-nums",
} as const;

/**
 * One column of "label left, value right" rows whose values share a left edge.
 * The whole list stacks labels above values only when its container is narrow,
 * never row by row.
 */
export function FieldList({ items, className }: {
  items: ReadonlyArray<Field | false | null | undefined>;
  className?: string;
}) {
  const fields = items.filter((item): item is Field => !!item);
  if (!fields.length) return null;
  return <div className={cn("@container/fields min-w-0", className)} data-detail-fields data-record-fields>
    <dl className="grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 @max-[22rem]/fields:grid-cols-1">
      {fields.map(field => {
        const empty = field.value === "" || field.value == null || field.value === false;
        return <div key={field.label} className="group/field col-span-full grid min-w-0 grid-cols-subgrid items-baseline" data-field-kind={field.kind ?? "text"}>
          <dt className="py-1 text-[0.8125rem] leading-5 text-muted-foreground @max-[22rem]/fields:pb-0">{field.label}</dt>
          <dd className="min-w-0 py-1 text-sm leading-5 @max-[22rem]/fields:pt-0">
            <div className="flex min-w-0 items-start gap-1">
              <span className={cn("min-w-0 whitespace-pre-wrap wrap-anywhere", valueKinds[field.kind ?? "text"])}>{empty ? "—" : field.value}</span>
              {field.copy && <span data-field-copy className="-my-0.5 shrink-0 opacity-0 transition-opacity duration-(--motion-instant) group-focus-within/field:opacity-100 group-hover/field:opacity-100 has-[[data-copy-state]:not([data-copy-state=idle])]:opacity-100 pointer-coarse:opacity-100">
                <CopyValue buttonOnly size="icon-xs" value={field.copy} label={"复制" + field.label} />
              </span>}
            </div>
            {field.hint && <p className="text-xs leading-4 text-muted-foreground">{field.hint}</p>}
          </dd>
        </div>;
      })}
    </dl>
  </div>;
}
