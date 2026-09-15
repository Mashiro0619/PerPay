import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "../navigation";

import type { AdminWorkItem } from "../api/client";
import { dateTime } from "../lib/format";
import { notificationErrorName } from "../lib/detail-summary";
import { workItemHref, workItemTitle } from "../lib/labels";
import { Badge, EmptyState } from "./ui";

export function WorkItemList({ items, headingLevel = 2, actions, emptyTitle }: {
  items: AdminWorkItem[]; headingLevel?: 2 | 3; actions?: ((item: AdminWorkItem) => ReactNode) | undefined; emptyTitle?: string | undefined;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  if (!items.length) return <EmptyState title={emptyTitle ?? "暂无待处理提醒"} headingLevel={headingLevel} />;
  return <ul className="work-item-list">{items.map((item) => <li key={`${item.type}:${item.resource_id}`}><Link className="work-item" to={workItemHref(item)}>
    <div><div className="work-item-heading"><Badge value={item.type} /><time dateTime={item.ignored_at ?? item.actionable_at}>{dateTime(item.ignored_at ?? item.actionable_at)}</time></div><Heading className="work-item-title">{workItemTitle(item)}</Heading>
      {item.type === "NOTIFICATION_FAILURE" && <p>{item.last_error_code ? notificationErrorName(item.last_error_code) + " · " : ""}已尝试 {item.attempt_count} 次{item.next_attempt_at && !item.ended ? " · 下次 " + dateTime(item.next_attempt_at) : ""}</p>}{item.ignored_at && <p>{item.ended ? "已结束" : "已忽略"} · {item.ignored_by ?? "管理员"}</p>}</div>
    <ChevronRight size={18} aria-hidden="true" />
  </Link>{actions?.(item)}</li>)}</ul>;
}
