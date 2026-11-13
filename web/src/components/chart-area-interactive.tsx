import { lazy, Suspense, useId, useState } from "react";
import { ChartArea, ChartColumn, ChartLine, Info } from "lucide-react";
import type { DashboardChartType, SystemAnalytics } from "@/api/client";
import { useChartType } from "@/hooks/use-chart-type";
import { useIsMobile } from "@/hooks/use-mobile";
import { money, count } from "@/lib/format";
import { buildTrendReport, type TrendView } from "@/lib/trend-analytics";
import { dailyDateLabel } from "@/lib/daily-analytics";
import { DailyAnalytics } from "@/components/daily-analytics";
import { CombinedTrendPlot } from "@/components/combined-trend-plot";
import {
  SelectionMotionGroup,
  SelectionMotionIndicator,
} from "@/components/selection-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";

const TrendPlot = lazy(() =>
  import("@/components/trend-plot").then((module) => ({
    default: module.TrendPlot,
  })),
);

const periods = [
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
];
const individualMetrics = [
  { value: "amount", label: "确认金额" },
  { value: "orders", label: "新建订单" },
] as const;
const metrics = [...individualMetrics, { value: "combined", label: "金额与订单" }] as const;
const chartTypes = [
  { value: "AREA", label: "面积图", icon: ChartArea },
  { value: "BAR", label: "柱状图", icon: ChartColumn },
  { value: "LINE", label: "折线图", icon: ChartLine },
] as const;

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
  const [metric, setMetric] = useState<TrendView>("amount");
  const [view, setView] = useState("chart");
  const [dailyVisited, setDailyVisited] = useState(false);
  const [effectiveType, setSelectedType] = useChartType(chartType);
  const mobile = useIsMobile();
  const selectedChartType = chartTypes.find(type => type.value === effectiveType) ?? chartTypes[0];
  const ChartTypeIcon = selectedChartType.icon;
  const summaryId = useId();
  const report = analytics && !pending ? buildTrendReport(analytics) : null;
  const singleMetric = metric === "combined" ? null : metric;
  const summary = singleMetric ? report?.[singleMetric] : undefined;
  const data = report?.data ?? [];
  const hasDays = data.length > 0;
  const includeYear =
    data[0]?.date.slice(0, 4) !== data.at(-1)?.date.slice(0, 4);
  const singleActiveDay =
    singleMetric && summary?.activeDays === 1 ? data.find((day) => day[singleMetric] > 0) : null;
  const format = (value: number | null | undefined) =>
    value == null
      ? "—"
      : metric === "amount"
        ? money(value)
        : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(
            value,
          );
  const totalValue = format(summary?.total);
  const averageValue = format(hasDays ? summary?.average : null);
  const peakValue = format(hasDays ? summary?.peak?.value : null);

  return (
    <Card className="trend-card @container/card min-w-0" aria-busy={pending}>
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(String(value));
          if (value === "daily") setDailyVisited(true);
        }}
        className="gap-4"
      >
        <CardHeader className="trend-header">
          <div className="trend-heading">
            <div className="trend-identity">
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
                      按北京时间统计：订单按创建时间，收款按确认时间。
                    </p>
                    <p className="text-sm">
                      确认金额不是支付宝账单合计，未扣退款和费用，非净结算收入。确认笔数按确认次数计，不等于当前已确认订单数。
                    </p>
                    <p className="text-sm">
                      待付款仅统计当前开放的待付款订单。日均与单日最高不含今天，包含零值日期；图表与每日横条按完整区间（含今天）展示。
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
              <CardDescription className="trend-dates" aria-live="polite">
                {pending
                  ? "正在读取近 " + range + " 天…"
                  : hasDays
                    ? <>
                        <time dateTime={data[0]!.date}>{data[0]!.date}</time>
                        {" — "}
                        <time dateTime={data.at(-1)!.date}>{data.at(-1)!.date}</time>
                      </>
                    : "暂无数据"}
              </CardDescription>
            </div>
            <div className="trend-controls">
              <div className="trend-period">
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
              <TabsList className="trend-tabs" aria-label="收款趋势视图">
                <TabsTrigger value="chart">图表</TabsTrigger>
                <TabsTrigger value="daily">每日数据</TabsTrigger>
              </TabsList>
            </div>
          </div>
          {view === "chart" && (
            <div className="trend-toolbar">
              <SelectionMotionGroup>
                <ToggleGroup
                  value={[metric]}
                  onValueChange={(value) => {
                    if (value[0] === "amount" || value[0] === "orders" || value[0] === "combined")
                      setMetric(value[0]);
                  }}
                  spacing={1}
                  size="sm"
                  aria-label="趋势指标"
                  className="trend-metrics"
                  data-selection-motion="fill"
                >
                  {metrics.map((item) => (
                    <ToggleGroupItem
                      key={item.value}
                      value={item.value}
                      aria-describedby={summaryId + item.value}
                    >
                      <SelectionMotionIndicator active={metric === item.value} />
                      {item.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </SelectionMotionGroup>
              {metric !== "combined" && (mobile ? <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={"图表类型：" + selectedChartType.label} />}>
                  <ChartTypeIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>图表类型</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={effectiveType} onValueChange={value => {
                      if (value === "AREA" || value === "BAR" || value === "LINE") setSelectedType(value);
                    }}>
                      {chartTypes.map(({ value, label, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                        <Icon />{label}
                      </DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu> : <SelectionMotionGroup>
                <ToggleGroup
                  value={[effectiveType]}
                  onValueChange={(value) => {
                    if (
                      value[0] === "AREA" ||
                      value[0] === "BAR" ||
                      value[0] === "LINE"
                    )
                      setSelectedType(value[0]);
                  }}
                  spacing={1}
                  size="sm"
                  aria-label="图表类型"
                  className="trend-types"
                  data-selection-motion="fill"
                >
                  {chartTypes.map(({ value, label, icon: Icon }) => (
                    <Tooltip key={value}>
                      <ToggleGroupItem
                        value={value}
                        aria-label={label}
                        render={<TooltipTrigger />}
                      >
                        <SelectionMotionIndicator active={effectiveType === value} />
                        <Icon aria-hidden="true" />
                      </ToggleGroupItem>
                      <TooltipContent role="tooltip" className="trend-type-tooltip">{label}</TooltipContent>
                    </Tooltip>
                  ))}
                </ToggleGroup>
              </SelectionMotionGroup>)}
            </div>
          )}
        </CardHeader>
        <TabsContent value="chart">
          <CardContent className="trend-content">
            {metric === "combined" ? (
              <dl className="trend-summary trend-summary-combined" aria-label="金额与订单汇总">
                {individualMetrics.map(({ value, label }) => {
                  const formatted = !report ? "—" : value === "amount" ? money(report.amount.total) : count(report.orders.total);
                  return (
                  <div className="trend-total" key={value}>
                    <dt>{label}</dt>
                    <dd id={summaryId + value} data-metric-value data-trend-metric={value}
                      data-value-length={pending ? undefined : formatted.length} className="trend-value leading-tight">
                      {pending ? <Skeleton className="h-9 w-32" /> : formatted}
                    </dd>
                    <dd className="trend-summary-note">含今天 · {value === "amount" ? "按确认时间" : "按创建时间"}</dd>
                  </div>
                );})}
              </dl>
            ) : <dl
              className="trend-summary"
              aria-label={metric === "amount" ? "确认金额汇总" : "新建订单汇总"}
            >
              <div className="trend-total">
                <dt>区间累计</dt>
                <dd
                  id={summaryId + metric}
                  data-metric-value
                  data-value-length={pending ? undefined : totalValue.length}
                  className="trend-value leading-tight"
                >
                  {pending ? (
                    <Skeleton className="h-9 w-32" />
                  ) : (
                    totalValue
                  )}
                </dd>
                <dd className="trend-summary-note">
                  {metric === "amount" ? "确认金额" : "新建订单"} · 含今天
                </dd>
              </div>
              <div data-trend-summary="average">
                <dt>{metric === "amount" ? "日均确认金额" : "日均新建订单"}</dt>
                <dd className="trend-value" data-value-length={pending ? undefined : averageValue.length}>
                  {pending ? (
                    <Skeleton className="h-6 w-20" />
                  ) : (
                    averageValue
                  )}
                </dd>
                <dd className="trend-summary-note">按已结束日期计算</dd>
              </div>
              <div data-trend-summary="peak">
                <dt>{metric === "amount" ? "单日最高金额" : "单日最多订单"}</dt>
                <dd className="trend-value" data-value-length={pending ? undefined : peakValue.length}>
                  {pending ? (
                    <Skeleton className="h-6 w-20" />
                  ) : (
                    peakValue
                  )}
                </dd>
                <dd className="trend-summary-note">
                  {summary?.peak?.date ? (
                    <time dateTime={summary.peak.date}>
                      {dailyDateLabel(summary.peak.date, includeYear)}
                    </time>
                  ) : (
                    "不含今天"
                  )}
                </dd>
              </div>
            </dl>}
            {individualMetrics
              .filter((item) => metric !== "combined" && item.value !== metric)
              .map((item) => (
                <span
                  key={item.value}
                  id={summaryId + item.value}
                  className="sr-only"
                >
                  {!report
                    ? "—"
                    : item.value === "amount"
                      ? money(report.amount.total)
                      : count(report.orders.total)}
                </span>
              ))}
            <span id={summaryId + "combined"} className="sr-only">
              {!report ? "—" : `确认金额 ${money(report.amount.total)}，新建订单 ${count(report.orders.total)} 笔`}
            </span>
            {pending ? (
              <Skeleton
                className="trend-plot w-full"
                data-chart-state="loading"
              />
            ) : !analytics || !report || !hasDays ? (
              <Empty className="trend-plot" data-chart-state="empty">
                <EmptyHeader>
                  <EmptyTitle>
                    {analytics ? "暂无每日数据" : "统计数据暂不可用"}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                {metric === "combined" ? (
                  <CombinedTrendPlot data={data} today={report.today} />
                ) : (
                  <Suspense fallback={<Skeleton className="trend-plot w-full" data-chart-state="loading" />}>
                    <TrendPlot
                      data={data}
                      metric={metric}
                      chartType={effectiveType}
                      today={report.today}
                    />
                  </Suspense>
                )}
                <div className="trend-caption">
                  <p>
                    {metric === "combined" ? `共 ${data.length} 天` : summary?.activeDays
                      ? `${metric === "amount" ? "有收款" : "有新订单"} ${summary.activeDays} 天 / 共 ${data.length} 天`
                      : metric === "amount"
                        ? "这段时间暂无确认收款"
                        : "这段时间暂无新建订单"}
                  </p>
                  {singleActiveDay && singleMetric ? (
                    <p data-trend-sparse>
                      <time dateTime={singleActiveDay.date}>
                        {singleActiveDay.date}
                      </time>
                      <span>{format(singleActiveDay[singleMetric])}</span>
                    </p>
                  ) : (
                    <p>按日展示 · 今天仍在累计</p>
                  )}
                </div>
              </>
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
