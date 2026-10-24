import { DailyAnalytics } from "@/components/daily-analytics";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useId, useLayoutEffect, useRef, useState } from "react";
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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
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
  scopeKey = "all",
}: {
  analytics: SystemAnalytics | undefined;
  chartType?: DashboardChartType;
  range: number;
  onRangeChange: (value: string) => void;
  pending: boolean;
  scopeKey?: string;
}) {
  const [metric, setMetric] = useState("amount");
  const [view, setView] = useState("chart");
  const [dailyVisited, setDailyVisited] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [chartFontSize, setChartFontSize] = useState(12);
  const [axisDimensions, setAxisDimensions] = useState({
    yWidth: 60,
    xHeight: 30,
    dateInset: 24,
  });
  useLayoutEffect(() => {
    const measure = () => {
      const rem =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;
      setChartFontSize(rem * 0.75);
      // Measure in SVG units: screen bounds can be scaled while ResponsiveContainer resizes.
      const bounds = (selector: string) =>
        [...(cardRef.current?.querySelectorAll<SVGGraphicsElement>(selector) ?? [])]
          .map((label) =>
            typeof label.getBBox === "function"
              ? label.getBBox()
              : label.getBoundingClientRect(),
          )
          .filter((label) => label.width > 0 && label.height > 0);
      const yLabels = bounds(".recharts-yAxis-tick-labels text");
      const xLabels = bounds(".recharts-xAxis-tick-labels text");
      if (!yLabels.length || !xLabels.length) return;
      // Include the 6px tick length, 8px gap and 4px of clearance around the labels.
      const dimensions = {
        yWidth: Math.ceil(Math.max(...yLabels.map((label) => label.width)) + 18),
        xHeight: Math.ceil(Math.max(...xLabels.map((label) => label.height)) + 18),
        dateInset: Math.ceil(
          Math.max(...xLabels.map((label) => label.width)) / 2 + 4,
        ),
      };
      setAxisDimensions((previous) =>
        previous.yWidth === dimensions.yWidth &&
        previous.xHeight === dimensions.xHeight &&
        previous.dateInset === dimensions.dateInset
          ? previous
          : dimensions,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    if (cardRef.current) observer?.observe(cardRef.current);
    const labelsObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    if (cardRef.current) {
      labelsObserver?.observe(cardRef.current, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      labelsObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
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
    <Card ref={cardRef} className="@container/card min-w-0" aria-busy={pending}>
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(String(value));
          if (value === "daily") setDailyVisited(true);
        }}
        className="gap-4"
      >
        <CardHeader className="trend-header">
          <div className="trend-title">
            <CardTitle role="heading" aria-level={2}>
              收款趋势
            </CardTitle>
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
              <PopoverContent
                align="start"
                aria-label="统计口径"
                className="flex flex-col gap-3"
              >
                <p className="text-sm">
                  按北京时间统计：订单按创建时间，收款按 PerPay 确认时间。
                </p>
                <p className="text-sm">
                  确认金额不是支付宝账单合计，未扣退款和费用，非净结算收入。确认笔数按确认次数计，不等于当前已确认订单数。
                </p>
                <p className="text-sm">
                  待付款仅统计当前开放的待付款订单。日均与单日最高不含今天；横条按完整区间（含今天）比较。
                </p>
              </PopoverContent>
            </Popover>
          </div>
          <TabsList
            className="trend-tabs"
            variant="line"
            aria-label="收款趋势视图"
          >
            <TabsTrigger value="chart">图表</TabsTrigger>
            <TabsTrigger value="daily">每日数据</TabsTrigger>
          </TabsList>
          <div className="trend-period">
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
                <SelectValue className="min-w-0" />
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
          </div>
          <CardDescription className="trend-dates" aria-live="polite">
            {pending
              ? "正在读取近 " + range + " 天…"
              : analytics?.daily.length
                ? analytics.daily[0]!.date +
                  " — " +
                  analytics.daily.at(-1)!.date
                : "暂无数据"}
          </CardDescription>
        </CardHeader>
        <TabsContent value="chart">
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm text-muted-foreground">
                    区间累计
                  </span>
                  <div
                    id={summaryId + metric}
                    data-metric-value
                    className="text-xl leading-tight font-semibold whitespace-normal tabular-nums wrap-anywhere"
                  >
                    {pending ? (
                      <Skeleton className="h-6 w-24" />
                    ) : !analytics ? (
                      "—"
                    ) : metric === "amount" ? (
                      money(analytics.confirmations.amount_cents)
                    ) : (
                      count(analytics.orders.created)
                    )}
                  </div>
                </div>
              </div>
              <ToggleGroup
                value={[metric]}
                onValueChange={(value) => {
                  if (value[0]) setMetric(value[0]);
                }}
                variant="outline"
                spacing={0}
                size="sm"
                aria-label="趋势指标"
                className="min-w-0 max-w-full items-stretch"
              >
                {metrics.map((item) => (
                  <ToggleGroupItem
                    key={item.value}
                    value={item.value}
                    aria-describedby={summaryId + item.value}
                    className="h-auto min-w-0 flex-1 shrink whitespace-normal"
                  >
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {metrics
                .filter((item) => item.value !== metric)
                .map((item) => (
                  <span
                    key={item.value}
                    id={summaryId + item.value}
                    className="sr-only"
                  >
                    {pending || !analytics
                      ? "—"
                      : item.value === "amount"
                        ? money(analytics.confirmations.amount_cents)
                        : count(analytics.orders.created)}
                  </span>
                ))}
            </div>

            {pending ? (
              <Skeleton className="trend-plot w-full" data-chart-state="loading" />
            ) : !analytics || !data.length ? (
              <Empty className="trend-plot" data-chart-state="empty">
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
                role="group"
                className="trend-plot aspect-auto w-full"
                aria-label={
                  metric === "amount"
                    ? "每日付款确认金额，左右方向键查看日期"
                    : "每日新建订单，左右方向键查看日期"
                }
              >
                <Chart
                  key={chartFontSize}
                  accessibilityLayer
                  data={data}
                  margin={{
                    top: chartFontSize,
                    right: axisDimensions.dateInset,
                    bottom: chartFontSize / 2,
                    left: 0,
                  }}
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        stopColor={seriesColor}
                        stopOpacity={0.18}
                      />
                      <stop
                        offset="95%"
                        stopColor={seriesColor}
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={chartFontSize * 3}
                    height={axisDimensions.xHeight}
                    fontSize={chartFontSize}
                    tickFormatter={(value: string) =>
                      value.slice(5).replace("-", "/")
                    }
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={axisDimensions.yWidth}
                    fontSize={chartFontSize}
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
                                  name === "amount"
                                    ? "bg-chart-1"
                                    : "bg-chart-2",
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
                      fillOpacity={0.85}
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
                      fillOpacity={1}
                      stroke={seriesColor}
                      strokeWidth={2}
                      activeDot={activeDot}
                      isAnimationActive={false}
                    />
                  )}
                </Chart>
              </ChartContainer>
            )}
          </CardContent>
        </TabsContent>
        {dailyVisited && (
          <TabsContent value="daily" keepMounted>
            <CardContent>
              <DailyAnalytics
                scopeKey={scopeKey}
                analytics={analytics}
                range={range}
                pending={pending}
              />
            </CardContent>
          </TabsContent>
        )}
      </Tabs>
    </Card>
  );
}
