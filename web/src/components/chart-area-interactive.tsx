import { useId, useState } from "react";
import { cn } from "cn";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Info } from "lucide-react";
import type { DashboardChartType, SystemAnalytics } from "@/api/client";
import { money, count } from "@/lib/format";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

const chartConfig = {
  amount: { label: "确认金额" },
  orders: { label: "新建订单" },
} satisfies ChartConfig;
// Native coordinate transitions can retarget mid-flight; transition-none also cancels them when motion is reduced.
const activeDot = {
  r: 5,
  stroke: "var(--card)",
  className:
    "motion-safe:transition-[cx,cy] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none",
};
const periods = [
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
];
const metrics = [
  { value: "amount", label: "确认金额" },
  { value: "orders", label: "新建订单" },
];

export function ChartAreaInteractive({
  analytics,
  chartType = "AREA",
  range,
  onRangeChange,
  pending,
}: {
  analytics: SystemAnalytics | undefined;
  chartType?: DashboardChartType;
  range: number;
  onRangeChange: (value: string) => void;
  pending: boolean;
}) {
  const [metric, setMetric] = useState("amount");
  const summaryId = useId();
  // Direct semantic tokens also work under our CSP, which forbids injected style blocks.
  const seriesColor = metric === "amount" ? "var(--chart-1)" : "var(--chart-2)";
  const Chart =
    chartType === "BAR"
      ? BarChart
      : chartType === "LINE"
        ? LineChart
        : AreaChart;
  const gradientId = "amount-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const data =
    analytics?.daily.map((day) => ({
      ...day,
      amount: day.confirmed_amount_cents / 100,
      orders: day.orders_created,
    })) ?? [];
  return (
    <Card className="@container/card min-w-0" aria-busy={pending}>
      <CardHeader className="flex flex-col gap-4 @[650px]/card:flex-row @[650px]/card:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <CardTitle role="heading" aria-level={2}>
            收款趋势
          </CardTitle>
          <CardDescription aria-live="polite">
            {pending
              ? "正在读取近 " + range + " 天…"
              : analytics?.daily.length
                ? analytics.daily[0]!.date +
                  " — " +
                  analytics.daily.at(-1)!.date
                : "暂无数据"}
          </CardDescription>
          <CardAction>
            <ToggleGroup
              value={[String(range)]}
              onValueChange={(value) => {
                if (value[0]) onRangeChange(value[0]);
              }}
              variant="outline"
              spacing={0}
              size="sm"
              className="hidden @[650px]/card:flex"
              aria-label="统计周期"
            >
              {periods.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select
              items={periods}
              value={String(range)}
              onValueChange={(value) => {
                if (value) onRangeChange(value);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label="统计周期"
                className="@[650px]/card:hidden"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {periods.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </CardAction>
        </div>
        <ToggleGroup
          value={[metric]}
          onValueChange={(value) => {
            if (value[0]) setMetric(value[0]);
          }}
          variant="outline"
          spacing={0}
          aria-label="趋势指标"
          className="grid w-full grid-cols-2 items-stretch @[650px]/card:w-1/2"
        >
          {metrics.map((item) => (
            <ToggleGroupItem
              key={item.value}
              value={item.value}
              aria-label={item.label}
              aria-describedby={summaryId + item.value}
              className="h-auto min-w-0 flex-col items-start gap-2 py-4"
            >
              <span className="text-xs text-muted-foreground">
                {item.label}
              </span>
              <span
                id={summaryId + item.value}
                className="max-w-full overflow-x-auto text-left text-xl leading-none font-semibold tabular-nums @[500px]/card:text-2xl"
              >
                {pending ? (
                  <Skeleton className="h-7 w-24" />
                ) : !analytics ? (
                  "—"
                ) : item.value === "amount" ? (
                  money(analytics.confirmations.amount_cents)
                ) : (
                  count(analytics.orders.created)
                )}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent className="flex min-h-[250px] flex-1 flex-col px-2 sm:px-4">
        {pending ? (
          <Skeleton className="h-[250px] w-full" />
        ) : !analytics || !data.length ? (
          <Empty className="min-h-[250px]">
            <EmptyHeader>
              <EmptyTitle>
                {analytics ? "暂无每日数据" : "统计数据暂不可用"}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer
            config={chartConfig}
            data-chart-type={chartType}
            className="aspect-auto min-h-[250px] w-full flex-1"
            aria-label={
              metric === "amount"
                ? "每日付款确认金额，左右方向键查看日期"
                : "每日新建订单，左右方向键查看日期"
            }
          >
            <Chart accessibilityLayer data={data}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={seriesColor} stopOpacity={0.8} />
                  <stop
                    offset="95%"
                    stopColor={seriesColor}
                    stopOpacity={0.1}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value: string) =>
                  value.slice(5).replace("-", "/")
                }
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={60}
                allowDecimals={metric === "amount"}
                tickFormatter={(value: number) =>
                  (metric === "amount" ? "¥" : "") +
                  new Intl.NumberFormat("zh-CN", {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(value)
                }
              />
              <ChartTooltip
                cursor={chartType === "BAR" ? { fillOpacity: 0.5 } : false}
                content={
                  <ChartTooltipContent
                    className="min-w-48 w-max"
                    labelFormatter={(value) =>
                      String(value).replaceAll("-", "/")
                    }
                    formatter={(value, name, item) => (
                      <div className="flex w-full items-center justify-between gap-6">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span
                            className={cn(
                              "size-2.5 shrink-0 rounded-[2px]",
                              name === "amount" ? "bg-chart-1" : "bg-chart-2",
                            )}
                          />
                          {chartConfig[name as keyof typeof chartConfig]
                            ?.label ?? name}
                        </span>
                        <span className="whitespace-nowrap font-mono font-medium tabular-nums text-foreground">
                          {name === "amount"
                            ? money(item.payload.confirmed_amount_cents)
                            : Number(value).toLocaleString("zh-CN")}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              {chartType === "BAR" ? (
                <Bar
                  dataKey={metric}
                  fill={seriesColor}
                  fillOpacity={0.55}
                  activeBar={{ fillOpacity: 1 }}
                  radius={4}
                  isAnimationActive={false}
                />
              ) : chartType === "LINE" ? (
                <Line
                  dataKey={metric}
                  type="monotone"
                  stroke={seriesColor}
                  strokeWidth={2}
                  dot={false}
                  activeDot={activeDot}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  dataKey={metric}
                  type="monotone"
                  fill={"url(#" + gradientId + ")"}
                  stroke={seriesColor}
                  activeDot={activeDot}
                  isAnimationActive={false}
                />
              )}
            </Chart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          按北京时间统计，确认金额不扣除退款或费用。
        </p>
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="统计口径" />
            }
          >
            <Info />
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-sm">
              按北京时间统计。付款确认金额不扣除退款或费用，不是净结算收入。订单按创建时间、付款按确认时间统计；待付款为当前开放且未付款的订单。
            </p>
          </PopoverContent>
        </Popover>
      </CardFooter>
    </Card>
  );
}
