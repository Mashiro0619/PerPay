import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Link } from "@/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type SettingsSummaryRow = readonly [label: string, value: ReactNode];

export function SettingsSummary({ title, description, badge, topContent, rows, editTo, editLabel = "编辑", actions, hideHeading = false }: {
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  topContent?: ReactNode;
  rows: readonly SettingsSummaryRow[];
  editTo?: string;
  editLabel?: string;
  actions?: ReactNode;
  /** The surrounding page already provides the visible section heading and actions. */
  hideHeading?: boolean;
}) {
  return (
    <Card size="sm" data-settings-summary>
      <CardHeader className={hideHeading ? "sr-only" : undefined} data-settings-summary-header>
        <CardTitle role="heading" aria-level={2} className={badge ? "flex flex-wrap items-center gap-2" : undefined}>
          <span>{title}</span>
          {badge}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {(editTo || actions) && <CardAction className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {actions}
          {editTo && <Link to={editTo} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={editLabel + title}>
            <Pencil data-icon="inline-start" />{editLabel}
          </Link>}
        </CardAction>}
      </CardHeader>
      <CardContent className={topContent ? "flex min-w-0 flex-col gap-4" : undefined}>
        {topContent}
        <dl className="flex min-w-0 flex-col divide-y divide-border/70">
          {rows.map(([label, value]) => <div key={label} className="grid min-w-0 grid-cols-1 items-baseline gap-x-6 gap-y-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="min-w-0 max-w-full break-words text-sm tabular-nums">{value ?? "未设置"}</dd>
          </div>)}
        </dl>
      </CardContent>
    </Card>
  );
}
