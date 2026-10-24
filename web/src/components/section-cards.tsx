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
  clientId = null,
}: {
  analytics: SystemAnalytics | undefined;
  pending?: boolean;
  workItems?: number | null;
  clientId?: string | null;
}) {
  // API daily dates are Beijing dates; the last complete series entry is today's bucket.
  const today = analytics?.daily.at(-1);
  const cards = [
    {
      title: "今日确认金额",
      description: "按 PerPay 的确认时间汇总，不是支付宝账单合计。",
      value: today ? money(today.confirmed_amount_cents) : "—",
    },
    { title: "今日收款确认笔数", description: "按收款确认次数统计，不等于当前收款已确认的订单数；按 PerPay 的确认时间汇总，不是支付宝账单合计。", value: today ? count(today.confirmations) : "—" },
    {
      title: "当前待付款",
      value: analytics ? count(analytics.pending.orders) : "—",
      href: (clientId ? "/sites/" + encodeURIComponent(clientId) : "") + "/orders?payment=UNPAID&checkout=OPEN",
    },
    {
      title: "待处理",
      value: workItems == null ? "—" : count(workItems),
      href: (clientId ? "/sites/" + encodeURIComponent(clientId) : "") + "/work-items",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" data-overview-kpis>
      {cards.map((card) => (
        <Card key={card.title} aria-busy={pending}>
          <CardHeader>
            <CardDescription title={card.description}>{card.title}</CardDescription>
            <CardTitle
              tabIndex={pending || card.href || card.value === "—" ? undefined : 0}
              role={card.href ? undefined : "group"}
              aria-label={pending || card.href ? undefined : `${card.title}：${card.value}`}
              className="min-w-0 text-xl font-semibold whitespace-normal tabular-nums wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
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
