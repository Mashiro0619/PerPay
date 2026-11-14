import { ArrowUpRight } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { useIsMobile } from "@/hooks/use-mobile";
import { count, money } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  const isCompact = useIsMobile();
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
    <div className="grid grid-cols-1 gap-4" data-overview-kpis>
      {cards.map((card) => {
        const focusableValue =
          !pending &&
          !card.href &&
          card.value !== "—" &&
          (isCompact || card.value.length > 10);
        return (
          <Card
            key={card.title}
            aria-busy={pending}
            className={card.href && !pending ? "group/card relative transition-colors hover:bg-muted/40" : undefined}
          >
            <CardHeader>
              <CardDescription
                title={card.description}
                className={card.href ? "flex items-center justify-between gap-1.5" : undefined}
              >
                {card.title}
                {card.href && (
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5"
                  />
                )}
              </CardDescription>
              <CardTitle
                data-value-length={pending ? undefined : card.value.length}
                tabIndex={focusableValue ? 0 : undefined}
                role={card.href ? undefined : "group"}
                aria-label={pending || card.href ? undefined : `${card.title}：${card.value}`}
                className={cn(
                  "overview-metric-value min-w-0 text-xl font-semibold whitespace-nowrap tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  !card.href && "overflow-x-auto",
                )}
              >
                {pending ? (
                  <Skeleton className="h-lh w-3/4" />
                ) : card.href ? (
                  <Link
                    to={card.href}
                    className="after:absolute after:inset-0 group-hover/card:underline"
                  >
                    {card.value}
                  </Link>
                ) : (
                  card.value
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        );
      })}
    </div>
  );
}
