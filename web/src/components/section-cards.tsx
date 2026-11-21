import { ArrowUpRight, Info } from "lucide-react";
import type { SystemAnalytics, SystemStatus } from "@/api/client";
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
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function formatWorkBreakdown(workBreakdown: SystemStatus["work_items"] | undefined): string | null {
  if (!workBreakdown) return null;
  const parts: string[] = [];
  if (workBreakdown.financial_exceptions > 0) parts.push(`异常 ${count(workBreakdown.financial_exceptions)}`);
  if (workBreakdown.ledger_conflicts > 0) parts.push(`冲突 ${count(workBreakdown.ledger_conflicts)}`);
  if (workBreakdown.notification_failures > 0) parts.push(`通知 ${count(workBreakdown.notification_failures)}`);
  return parts.length ? parts.join(" · ") : null;
}

export function SectionCards({
  analytics,
  pending = false,
  workItems,
  workBreakdown,
  range = 30,
  clientId = null,
}: {
  analytics: SystemAnalytics | undefined;
  pending?: boolean;
  workItems?: number | null;
  workBreakdown?: SystemStatus["work_items"] | undefined;
  range?: 7 | 30 | 90;
  clientId?: string | null;
}) {
  const isCompact = useIsMobile();
  // API daily dates are Beijing dates; the last complete series entry is today's bucket.
  const today = analytics?.daily.at(-1);
  const completedDays = analytics && analytics.daily.length > 1 ? analytics.daily.slice(0, -1) : [];
  const averageAmount = completedDays.length
    ? Math.round(completedDays.reduce((sum, day) => sum + day.confirmed_amount_cents, 0) / completedDays.length)
    : null;
  const hasWorkItems = !pending && workItems != null && workItems > 0;
  const workBreakdownSummary = !clientId && hasWorkItems ? formatWorkBreakdown(workBreakdown) : null;

  const cards = [
    {
      title: "今日确认金额",
      description: "按 PerPay 的确认时间汇总，不是支付宝账单合计。",
      value: today ? money(today.confirmed_amount_cents) : "—",
      caption: !analytics
        ? "统计暂不可用"
        : averageAmount != null
          ? `近 ${range} 天日均 ${money(averageAmount)}`
          : "北京时间今日累计",
    },
    {
      title: "今日收款确认笔数",
      description: "按收款确认次数统计，不等于当前收款已确认的订单数；按 PerPay 的确认时间汇总，不是支付宝账单合计。",
      value: today ? count(today.confirmations) : "—",
      caption: !analytics
        ? "统计暂不可用"
        : `近 ${range} 天累计 ${count(analytics.confirmations.count)} 笔`,
    },
    {
      title: "当前待付款",
      value: analytics ? count(analytics.pending.orders) : "—",
      caption: !analytics
        ? "统计暂不可用"
        : analytics.pending.orders > 0
          ? "收款中待付款订单"
          : "当前无收款中订单",
      href: (clientId ? "/sites/" + encodeURIComponent(clientId) : "") + "/orders?payment=UNPAID&checkout=OPEN",
    },
    {
      title: "待处理",
      value: workItems == null ? "—" : count(workItems),
      caption: workItems == null
        ? "待处理统计暂不可用"
        : workItems > 0
          ? (workBreakdownSummary ?? "点击查看待处理队列")
          : "暂无待处理提醒",
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
            data-interactive={card.href && !pending ? "true" : undefined}
            className={cn(
              "overview-kpi-card",
              card.href && !pending && "group/card relative transition-colors hover:bg-muted/40",
            )}
          >
            <CardHeader>
              <CardDescription
                className="flex min-w-0 items-center justify-between gap-1"
              >
                {card.description ? <span className="truncate">{card.title}</span> : card.title}
                {card.description && (
                  <Popover>
                    <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="overview-kpi-info-trigger" aria-label={card.title + "统计口径"} />}>
                      <Info aria-hidden="true" />
                    </PopoverTrigger>
                    <PopoverContent align="start" aria-label={card.title + "统计口径"}>
                      <p>{card.description}</p>
                    </PopoverContent>
                  </Popover>
                )}
                {card.href && (
                  <span className="overview-kpi-link-cue" aria-hidden="true">
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 transition-transform group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5"
                    />
                  </span>
                )}
              </CardDescription>
              <CardTitle
                data-value-length={pending ? undefined : card.value.length}
                tabIndex={focusableValue ? 0 : undefined}
                role={card.href ? undefined : "group"}
                aria-label={pending || card.href ? undefined : `${card.title}：${card.value}`}
                className={cn(
                  "overview-metric-value min-w-0 text-xl font-semibold whitespace-nowrap tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  card.href && "[@media(pointer:coarse)]:min-h-[40px]",
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
              <div className="overview-kpi-caption truncate text-xs text-muted-foreground tabular-nums">
                {pending ? <span aria-hidden="true">{"\u00A0"}</span> : card.caption}
              </div>
            </CardHeader>
          </Card>
        );
      })}
    </div>
  );
}
