import type { SystemAnalytics } from "@/api/client";
import { count, money } from "@/lib/format";
import { Link } from "@/navigation";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
export function SectionCards({
  analytics,
  pending = false,
  workItems,
}: {
  analytics: SystemAnalytics | undefined;
  pending?: boolean;
  workItems?: number | null;
}) {
  // API daily dates are Beijing dates; the last complete series entry is today's bucket.
  const today = analytics?.daily.at(-1);
  const cards = [
    {
      title: "今日确认金额",
      value: today ? money(today.confirmed_amount_cents) : "—",
    },
    { title: "今日确认笔数", value: today ? count(today.confirmations) : "—" },
    {
      title: "当前待付款",
      value: analytics ? count(analytics.pending.orders) : "—",
      href: "/orders?payment=UNPAID&checkout=OPEN",
    },
    {
      title: "需处理事项",
      value: workItems == null ? "—" : count(workItems),
      href: "/work-items",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title} aria-busy={pending}>
          <CardHeader>
            <CardDescription>{card.title}</CardDescription>
            <CardTitle className="overflow-x-auto text-xl font-semibold whitespace-nowrap tabular-nums">
              {pending ? (
                <Skeleton className="h-7 w-3/4" />
              ) : card.href ? (
                <Link to={card.href}>{card.value}</Link>
              ) : (
                card.value
              )}
            </CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
