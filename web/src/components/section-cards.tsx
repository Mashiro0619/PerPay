import { CircleCheck, Clock3 } from "lucide-react";
import type { SystemAnalytics } from "@/api/client";
import { count } from "@/lib/format";
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
  pending = false,
}: {
  analytics: SystemAnalytics | undefined;
  pending?: boolean;
}) {
  const values = analytics
    ? [count(analytics.confirmations.count), count(analytics.pending.orders)]
    : [];
  const icons = [CircleCheck, Clock3];
  return (
    <div className="grid grid-cols-1 gap-3 px-4 lg:px-6 @sm/main:grid-cols-2">
      {["确认次数", "当前待付款"].map((title, index) => {
        const Icon = icons[index]!;
        return (
          <Card key={title} className="@container/card" aria-busy={pending}>
            <CardHeader>
              <CardDescription>{title}</CardDescription>
              <CardAction>
                <Icon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </CardAction>
              <CardTitle className="overflow-x-auto text-xl font-semibold whitespace-nowrap tabular-nums @[200px]/card:text-2xl">
                {pending ? (
                  <Skeleton className="h-9 w-3/4" />
                ) : (
                  (values[index] ?? "—")
                )}
              </CardTitle>
            </CardHeader>
          </Card>
        );
      })}
    </div>
  );
}
