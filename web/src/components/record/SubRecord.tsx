import type { ReactNode } from "react";
import { Link } from "@/navigation";
import { ActionButton, ActionMenu, type RecordAction } from "./ActionMenu";

/**
 * One child record inside a section, such as an association or a delivery.
 * Nest only one level. `id` makes it a deep-link target; <Sections> marks a
 * located record with `data-anchor-hit` for a moment.
 */
export function SubRecord({ id, title, status, description, href, hrefLabel = "查看详情", actions = [], actionsLabel = "更多操作", children }: {
  id?: string;
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  href?: string | undefined;
  hrefLabel?: string;
  /** One action is shown as a text button; two or more are collected in a menu. */
  actions?: readonly RecordAction[];
  actionsLabel?: string;
  children?: ReactNode;
}) {
  return <article id={id} tabIndex={id ? -1 : undefined} data-sub-record
    className="flex min-w-0 flex-col gap-2 rounded-lg border px-4 py-3 outline-none transition-colors duration-1000 data-anchor-hit:bg-accent data-anchor-hit:duration-0">
    <header className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-32 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="min-w-0 text-sm font-medium wrap-anywhere">{title}</h3>
          {status}
        </div>
        {description && <p className="text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>}
      </div>
      {/* On a narrow record the link and the action move below the title, and below each other, instead of pushing past its edge. */}
      {(href || actions.length > 0) && <div className="-my-1 -mr-2 flex max-w-[calc(100%+0.5rem)] min-w-0 flex-wrap items-center justify-end gap-1">
        {href && <Link to={href} className="px-2 text-[0.8125rem] leading-7 underline underline-offset-4">{hrefLabel}<span aria-hidden="true"> ›</span></Link>}
        {actions.length === 1 ? <ActionButton action={actions[0]!} /> : <ActionMenu actions={actions} label={actionsLabel} />}
      </div>}
    </header>
    {children}
  </article>;
}
