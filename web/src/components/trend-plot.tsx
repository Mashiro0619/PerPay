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
import type { DashboardChartType } from "@/api/client";
import type { TrendDay, TrendMetric } from "@/lib/trend-analytics";
import { money, count } from "@/lib/format";
import { dailyWeekday } from "@/lib/daily-analytics";
import { useChartSeriesMotion } from "@/components/selection-motion";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const chartConfig = {
  amount: { label: "确认金额" },
  orders: { label: "新建订单" },
} satisfies ChartConfig;
const activeDot = {
  r: 5,
  stroke: "var(--card)",
  className:
    "motion-safe:transition-[cx,cy] motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none",
};

export function TrendPlot({
  data,
  metric,
  chartType,
  today,
}: {
  data: TrendDay[];
  metric: TrendMetric;
  chartType: DashboardChartType;
  today: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  useChartSeriesMotion(plotRef, `${metric}:${chartType}`);
  const [fontSize, setFontSize] = useState(12);
  const [fixedTooltip, setFixedTooltip] = useState(true);
  const [axis, setAxis] = useState({ yWidth: 60, xHeight: 30, dateInset: 24 });
  useLayoutEffect(() => {
    const measure = () => {
      const rem =
        Number.parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        ) || 16;
      setFontSize(rem * 0.75);
      // Reserve a full tooltip (max 20rem) on either side, including its offset.
      // This also accounts for enlarged text, where pixel-only breakpoints fail.
      setFixedTooltip((plotRef.current?.clientWidth ?? 0) < rem * 40 + 20);
      // SVG units stay correct while ResponsiveContainer's screen bounds resize.
      const bounds = (selector: string) =>
        [
          ...(plotRef.current?.querySelectorAll<SVGGraphicsElement>(selector) ??
            []),
        ]
          .map((label) =>
            typeof label.getBBox === "function"
              ? label.getBBox()
              : label.getBoundingClientRect(),
          )
          .filter((label) => label.width > 0 && label.height > 0);
      const ys = bounds(".recharts-yAxis-tick-labels text");
      const xs = bounds(".recharts-xAxis-tick-labels text");
      if (!ys.length || !xs.length) return;
      const next = {
        yWidth: Math.ceil(Math.max(...ys.map((label) => label.width)) + 18),
        xHeight: Math.ceil(Math.max(...xs.map((label) => label.height)) + 18),
        dateInset: Math.ceil(
          Math.max(...xs.map((label) => label.width)) / 2 + 4,
        ),
      };
      setAxis((previous) =>
        previous.yWidth === next.yWidth &&
        previous.xHeight === next.xHeight &&
        previous.dateInset === next.dateInset
          ? previous
          : next,
      );
    };
    measure();
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    const labels =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(measure);
    if (plotRef.current) {
      resize?.observe(plotRef.current);
      labels?.observe(plotRef.current, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
    window.addEventListener("resize", measure);
    return () => {
      resize?.disconnect();
      labels?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const gradientId = "trend-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const seriesColor = metric === "amount" ? "var(--chart-1)" : "var(--chart-2)";
  const maximum = Math.max(...data.map((day) => day[metric]), 0);
  const activeDays = data.filter((day) => day[metric] > 0).length;
  const Chart =
    chartType === "BAR"
      ? BarChart
      : chartType === "LINE"
        ? LineChart
        : AreaChart;
  // Sparse nonzero dates retain visible marks even in a 90-day range.
  const dot = ({
    cx,
    cy,
    payload,
  }: {
    cx?: number;
    cy?: number;
    payload?: TrendDay;
  }) => (
    <circle
      cx={cx}
      cy={cy}
      r={
        payload &&
        (data.length <= 7 || (activeDays <= 7 && payload[metric] > 0))
          ? 3.5
          : 0
      }
      fill={seriesColor}
      stroke="var(--card)"
      strokeWidth={1.5}
      data-trend-point={
        payload && payload[metric] > 0 ? payload.date : undefined
      }
    />
  );
  const axisFormat = new Intl.NumberFormat("zh-CN", {
    notation:
      maximum >= (metric === "amount" ? 100000 : 1000) ? "compact" : "standard",
    maximumFractionDigits: metric === "amount" && maximum < 1000 ? 2 : 1,
  });

  return (
    <div ref={plotRef} className="min-w-0">
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
          key={fontSize}
          accessibilityLayer
          data={data}
          margin={{
            top: fontSize,
            right: axis.dateInset,
            bottom: fontSize / 2,
            left: 0,
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={seriesColor} stopOpacity={0.18} />
              <stop offset="95%" stopColor={seriesColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="3 5" />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={fontSize * 3}
            padding={{ left: 8, right: 8 }}
            height={axis.xHeight}
            fontSize={fontSize}
            tickFormatter={(value: string) => value.slice(5).replace("-", "/")}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={axis.yWidth}
            fontSize={fontSize}
            tickCount={maximum > 0 && maximum < 4 ? maximum + 1 : 5}
            allowDecimals={false}
            domain={[
              0,
              maximum === 0 ? (metric === "amount" ? 100 : 4) : "auto",
            ]}
            tickFormatter={(value: number) =>
              (metric === "amount" ? "¥" : "") +
              axisFormat.format(metric === "amount" ? value / 100 : value)
            }
          />
          <ChartTooltip
            position={fixedTooltip ? { x: 0 } : undefined}
            cursor={
              chartType === "BAR"
                ? { fillOpacity: 0.5 }
                : {
                    stroke: "var(--muted-foreground)",
                    strokeDasharray: "3 4",
                    strokeOpacity: 0.5,
                  }
            }
            content={
              <ChartTooltipContent
                className="trend-tooltip"
                labelFormatter={(value) => {
                  const date = String(value);
                  return `${date.replaceAll("-", "/")} ${dailyWeekday(date)}${date === today ? " · 今日" : ""}`;
                }}
                formatter={(value, name) => (
                  <div className="trend-tooltip-value">
                    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-[2px]",
                          name === "amount" ? "bg-chart-1" : "bg-chart-2",
                        )}
                      />
                      {chartConfig[name as TrendMetric]?.label ?? name}
                    </span>
                    <span className="tabular-nums font-medium text-foreground">
                      {name === "amount"
                        ? money(Number(value))
                        : count(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          {chartType === "BAR" ? (
            <Bar
              className="trend-series-motion"
              dataKey={metric}
              fill={seriesColor}
              fillOpacity={0.85}
              activeBar={{ fillOpacity: 1 }}
              radius={[3, 3, 0, 0]}
              maxBarSize={32}
              isAnimationActive={false}
            />
          ) : chartType === "LINE" ? (
            <Line
              className="trend-series-motion"
              dataKey={metric}
              type="linear"
              stroke={seriesColor}
              strokeWidth={2}
              dot={dot}
              activeDot={activeDot}
              isAnimationActive={false}
            />
          ) : (
            <Area
              className="trend-series-motion"
              dataKey={metric}
              type="step"
              fill={"url(#" + gradientId + ")"}
              fillOpacity={1}
              stroke={seriesColor}
              strokeWidth={2}
              dot={dot}
              activeDot={activeDot}
              isAnimationActive={false}
            />
          )}
        </Chart>
      </ChartContainer>
    </div>
  );
}
