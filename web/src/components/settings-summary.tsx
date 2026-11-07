import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Link } from "@/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type SettingsSummaryRow = readonly [label: string, value: ReactNode];

export function SettingsSummary({ title, description, rows, editTo, editLabel = "编辑", actions, hideHeading = false }: {
  title: string;
  description?: ReactNode;
  rows: readonly SettingsSummaryRow[];
  editTo?: string;
  editLabel?: string;
  actions?: ReactNode;
  /** The surrounding page already provides the visible section heading and actions. */
  hideHeading?: boolean;
}) {
  return (
    <Card size="sm" data-settings-summary>
      <CardHeader className={hideHeading ? "sr-only" : undefined}>
        <CardTitle role="heading" aria-level={2}>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {(editTo || actions) && <CardAction className="flex flex-wrap items-center gap-2">
          {actions}
          {editTo && <Link to={editTo} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={editLabel + title}>
            <Pencil data-icon="inline-start" />{editLabel}
          </Link>}
        </CardAction>}
      </CardHeader>
      <CardContent>
        <dl className="flex min-w-0 flex-col divide-y">
          {rows.map(([label, value]) => <div key={label} className="flex min-w-0 flex-wrap justify-between gap-x-6 gap-y-1 py-2 first:pt-0 last:pb-0">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="min-w-0 max-w-full break-words text-sm">{value ?? "未设置"}</dd>
          </div>)}
        </dl>
      </CardContent>
    </Card>
  );
}
