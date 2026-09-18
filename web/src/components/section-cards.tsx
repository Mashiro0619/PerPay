import { Banknote, ClipboardList, CircleCheck, Clock3 } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { money, count } from "@/lib/format";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SectionCards({
  analytics,
}: {
  analytics: SystemAnalytics | undefined;
}) {
  const values = analytics
    ? [
        money(analytics.confirmations.amount_cents),
        count(analytics.orders.created),
        count(analytics.confirmations.count),
        count(analytics.pending.orders),
      ]
    : [];
  const icons = [Banknote, ClipboardList, CircleCheck, Clock3];
  return (
    <div className="grid grid-cols-1 gap-3 px-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @sm/main:grid-cols-2 @3xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      {["付款确认金额", "新建订单", "付款确认次数", "当前待付款"].map(
        (title, index) => {
          const Icon = icons[index]!;
          return (
            <Card key={title} className="@container/card">
              <CardHeader>
                <CardDescription>{title}</CardDescription>
                <CardAction>
                  <Icon
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </CardAction>
                <CardTitle className="overflow-x-auto text-xl font-semibold whitespace-nowrap tabular-nums @[200px]/card:text-2xl">
                  {values[index] ?? <Skeleton className="h-9 w-3/4" />}
                </CardTitle>
              </CardHeader>
            </Card>
          );
        },
      )}
    </div>
  );
}
