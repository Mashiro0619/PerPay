import { useId, useState } from "react";
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
import { ChevronDown, Info } from "lucide-react";
import type { DashboardChartType, SystemAnalytics } from "@/api/client";
import { money } from "@/lib/format";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

const chartConfig = {
  amount: { label: "确认金额" },
  orders: { label: "新建订单" },
} satisfies ChartConfig;
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
    <Card className="@container/card" aria-busy={pending}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          收款趋势
        </CardTitle>
        <CardDescription aria-live="polite">
          {pending
            ? "正在读取近 " + range + " 天…"
            : analytics?.daily.length
              ? analytics.daily[0]!.date + " — " + analytics.daily.at(-1)!.date
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
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-2 sm:px-4">
        <ToggleGroup
          value={[metric]}
          onValueChange={(value) => {
            if (value[0]) setMetric(value[0]);
          }}
          variant="outline"
          spacing={0}
          size="sm"
          aria-label="趋势指标"
          className="mx-2 w-fit sm:mx-0"
        >
          {metrics.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {pending || !analytics ? (
          <Skeleton className="h-[250px] w-full" />
        ) : (
          <ChartContainer
            config={chartConfig}
            data-chart-type={chartType}
            className="aspect-auto h-[250px] w-full"
            aria-label={
              metric === "amount"
                ? "每日付款确认金额，左右方向键查看日期"
                : "每日新建订单，左右方向键查看日期"
            }
          >
            <Chart accessibilityLayer data={data}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--primary)"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--primary)"
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
                tickFormatter={(value: number) =>
                  (metric === "amount" ? "¥" : "") +
                  new Intl.NumberFormat("zh-CN", {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  }).format(value)
                }
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    className="min-w-48 w-max"
                    labelFormatter={(value) =>
                      String(value).replaceAll("-", "/")
                    }
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-6">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <span className="size-2.5 shrink-0 rounded-[2px] bg-primary" />
                          {chartConfig[name as keyof typeof chartConfig]
                            ?.label ?? name}
                        </span>
                        <span className="whitespace-nowrap font-mono font-medium tabular-nums text-foreground">
                          {name === "amount"
                            ? money(Math.round(Number(value) * 100))
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
                  fill="var(--primary)"
                  radius={4}
                  isAnimationActive={false}
                />
              ) : chartType === "LINE" ? (
                <Line
                  dataKey={metric}
                  type="monotone"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  dataKey={metric}
                  type="monotone"
                  fill={"url(#" + gradientId + ")"}
                  stroke="var(--primary)"
                  isAnimationActive={false}
                />
              )}
            </Chart>
          </ChartContainer>
        )}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        <Collapsible className="w-full">
          <div className="flex items-center justify-between gap-2">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
              <ChevronDown data-icon="inline-start" />
              每日数据
            </CollapsibleTrigger>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="统计口径"
                  />
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
          </div>
          <CollapsibleContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">确认金额</TableHead>
                  <TableHead className="text-right">确认次数</TableHead>
                  <TableHead className="text-right">新建订单</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((day) => (
                  <TableRow key={day.date}>
                    <TableCell>{day.date}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(day.confirmed_amount_cents)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.confirmations}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.orders}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CollapsibleContent>
        </Collapsible>
      </CardFooter>
    </Card>
  );
}
