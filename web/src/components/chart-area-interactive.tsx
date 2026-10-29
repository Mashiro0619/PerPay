import { useId, useState } from "react";
import { ChartArea, ChartColumn, ChartLine, Info } from "lucide-react";
import type { DashboardChartType, SystemAnalytics } from "@/api/client";
import { money, count } from "@/lib/format";
import { buildTrendReport, type TrendMetric } from "@/lib/trend-analytics";
import { dailyDateLabel } from "@/lib/daily-analytics";
import { DailyAnalytics } from "@/components/daily-analytics";
import { TrendPlot } from "@/components/trend-plot";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/admin-empty";
import { Skeleton } from "@/components/ui/skeleton";

const periods = [
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
];
const metrics = [
  { value: "amount", label: "确认金额" },
  { value: "orders", label: "新建订单" },
] as const;
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
  const [metric, setMetric] = useState<TrendMetric>("amount");
  const [view, setView] = useState("chart");
  const [dailyVisited, setDailyVisited] = useState(false);
  // The saved default can arrive asynchronously. A local choice lasts for this visit.
  const [selectedType, setSelectedType] = useState<DashboardChartType | null>(
    null,
  );
  const effectiveType = selectedType ?? chartType;
  const summaryId = useId();
  const report = analytics && !pending ? buildTrendReport(analytics) : null;
  const summary = report?.[metric];
  const data = report?.data ?? [];
  const hasDays = data.length > 0;
  const includeYear =
    data[0]?.date.slice(0, 4) !== data.at(-1)?.date.slice(0, 4);
  const singleActiveDay =
    summary?.activeDays === 1 ? data.find((day) => day[metric] > 0) : null;
  const format = (value: number | null | undefined) =>
    value == null
      ? "—"
      : metric === "amount"
        ? money(value)
        : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(
            value,
          );

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
                  待付款仅统计当前开放的待付款订单。日均与单日最高不含今天，包含零值日期；图表与每日横条按完整区间（含今天）展示。
                </p>
              </PopoverContent>
            </Popover>
          </div>
          <CardDescription className="trend-dates" aria-live="polite">
            {pending
              ? "正在读取近 " + range + " 天…"
              : hasDays
                ? data[0]!.date + " — " + data.at(-1)!.date
                : "暂无数据"}
          </CardDescription>
          <SelectionMotionGroup>
            <TabsList
              className="trend-tabs"
              variant="line"
              aria-label="收款趋势视图"
              data-selection-motion="underline"
            >
              <TabsTrigger value="chart">
                <SelectionMotionIndicator
                  active={view === "chart"}
                  variant="underline"
                />
                图表
              </TabsTrigger>
              <TabsTrigger value="daily">
                <SelectionMotionIndicator
                  active={view === "daily"}
                  variant="underline"
                />
                每日数据
              </TabsTrigger>
            </TabsList>
          </SelectionMotionGroup>
          <div className="trend-period">
            <SelectionMotionGroup>
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
                data-selection-motion="fill"
              >
                {periods.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value}>
                    <SelectionMotionIndicator
                      active={String(range) === item.value}
                    />
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </SelectionMotionGroup>
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
        </CardHeader>
        <TabsContent value="chart">
          <CardContent className="trend-content">
            <div className="trend-toolbar">
              <SelectionMotionGroup>
                <ToggleGroup
                  value={[metric]}
                  onValueChange={(value) => {
                    if (value[0] === "amount" || value[0] === "orders")
                      setMetric(value[0]);
                  }}
                  variant="outline"
                  spacing={0}
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
              <SelectionMotionGroup>
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
                  variant="outline"
                  spacing={0}
                  size="sm"
                  aria-label="图表类型"
                  className="trend-types"
                  data-selection-motion="fill"
                >
                  {chartTypes.map(({ value, label, icon: Icon }) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      aria-label={label}
                      title={label}
                    >
                      <SelectionMotionIndicator active={effectiveType === value} />
                      <Icon data-icon="inline-start" />
                      <span>{label}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </SelectionMotionGroup>
            </div>
            <dl
              className="trend-summary"
              aria-label={metric === "amount" ? "确认金额汇总" : "新建订单汇总"}
            >
              <div className="trend-total">
                <dt>区间累计</dt>
                <dd
                  id={summaryId + metric}
                  data-metric-value
                  className="whitespace-normal wrap-anywhere leading-tight"
                >
                  {pending ? (
                    <Skeleton className="h-9 w-32" />
                  ) : (
                    format(summary?.total)
                  )}
                </dd>
                <dd className="trend-summary-note">
                  {metric === "amount" ? "确认金额" : "新建订单"} · 含今天
                </dd>
              </div>
              <div data-trend-summary="average">
                <dt>{metric === "amount" ? "日均确认金额" : "日均新建订单"}</dt>
                <dd>
                  {pending ? (
                    <Skeleton className="h-6 w-20" />
                  ) : (
                    format(hasDays ? summary?.average : null)
                  )}
                </dd>
                <dd className="trend-summary-note">按已结束日期计算</dd>
              </div>
              <div data-trend-summary="peak">
                <dt>{metric === "amount" ? "单日最高金额" : "单日最多订单"}</dt>
                <dd>
                  {pending ? (
                    <Skeleton className="h-6 w-20" />
                  ) : (
                    format(hasDays ? summary?.peak?.value : null)
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
            </dl>
            {metrics
              .filter((item) => item.value !== metric)
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
                <TrendPlot
                  data={data}
                  metric={metric}
                  chartType={effectiveType}
                  today={report.today}
                />
                <div className="trend-caption">
                  <p>
                    {summary?.activeDays
                      ? `${metric === "amount" ? "有收款" : "有新订单"} ${summary.activeDays} 天 / 共 ${data.length} 天`
                      : metric === "amount"
                        ? "这段时间暂无确认收款"
                        : "这段时间暂无新建订单"}
                  </p>
                  {singleActiveDay ? (
                    <p data-trend-sparse>
                      <time dateTime={singleActiveDay.date}>
                        {singleActiveDay.date}
                      </time>
                      <span>{format(singleActiveDay[metric])}</span>
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
