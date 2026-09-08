import { ChevronRight } from "lucide-react";
import { Link } from "../navigation";

import type { AdminWorkItem } from "../api/client";
import { dateTime, shortId } from "../lib/format";
import { workItemHref, workItemTitle } from "../lib/labels";
import { Badge, EmptyState } from "./ui";

export function WorkItemList({ items, headingLevel = 2 }: { items: AdminWorkItem[]; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  if (!items.length) return <EmptyState title="暂时没有待处理事项" headingLevel={headingLevel} />;
  return <ul className="work-item-list">{items.map((item) => <li key={`${item.type}:${item.resource_id}`}><Link className="work-item" to={workItemHref(item)}>
    <div><div className="work-item-heading"><Badge value={item.type} /><time>{dateTime(item.actionable_at)}</time></div><Heading className="work-item-title">{workItemTitle(item)}</Heading>
      <p>{item.order_id ? `订单 ${shortId(item.order_id)}` : item.ledger_entry_id ? `流水 ${shortId(item.ledger_entry_id)}` : `记录 ${shortId(item.resource_id)}`}</p></div>
    <ChevronRight size={18} aria-hidden="true" />
  </Link></li>)}</ul>;
}
