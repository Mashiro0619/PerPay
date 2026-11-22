import { useId } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import type { TrendDay, TrendMetric } from "@/lib/trend-analytics";
import { money, count } from "@/lib/format";
import { dailyWeekday } from "@/lib/daily-analytics";
import { TrendSeriesSymbol } from "@/components/trend-series-symbol";
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

export function CombinedTrendChart({
  data,
  today,
  layout,
  minimumWidth,
  overflowing,
  fixedTooltip,
  tooltipPortal,
  legendId,
}: {
  data: TrendDay[];
  today: string;
  layout: { fontSize: number; leftWidth: number; rightWidth: number; xHeight: number };
  minimumWidth: number;
  overflowing: boolean;
  fixedTooltip: boolean;
  tooltipPortal: HTMLDivElement | null;
  legendId: string;
}) {
  const gradientId = "combined-bar-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const amountMaximum = Math.max(...data.map(day => day.amount), 0);
  const ordersMaximum = Math.max(...data.map(day => day.orders), 0);
  const activeOrderDays = data.filter(day => day.orders > 0).length;
  const amountAxisFormat = new Intl.NumberFormat("zh-CN", {
    notation: amountMaximum >= 100000 ? "compact" : "standard",
    maximumFractionDigits: amountMaximum < 1000 ? 2 : 1,
  });
  const orderAxisFormat = new Intl.NumberFormat("zh-CN", {
    notation: ordersMaximum >= 1000 ? "compact" : "standard",
    maximumFractionDigits: ordersMaximum >= 1000 ? 1 : 0,
  });
  const dot = ({ cx, cy, payload }: { cx?: number; cy?: number; payload?: TrendDay }) => (
    <circle cx={cx} cy={cy}
      r={payload && (data.length <= 7 || (activeOrderDays <= 7 && payload.orders > 0)) ? 3.5 : 0}
      fill="var(--card)" stroke="var(--chart-1)" strokeWidth={2}
      data-trend-point={payload && payload.orders > 0 ? payload.date : undefined}
    />
  );

  return (
    <ChartContainer config={chartConfig} data-chart-type="COMBINED"
      role="group" className="trend-plot aspect-auto w-full"
      style={{ minWidth: minimumWidth }} aria-describedby={legendId}
      aria-label="每日确认金额与新建订单，左轴为元，右轴为笔数，左右方向键查看日期">
      <ComposedChart key={layout.fontSize} accessibilityLayer data={data}
        barCategoryGap="24%"
        margin={{ top: layout.fontSize, right: 0, bottom: layout.fontSize / 2, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.38} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.12} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="2 4" strokeOpacity={0.42} yAxisId="amount" />
        <XAxis xAxisId={0} dataKey="date" tickLine={false} axisLine={false}
          tickMargin={8} minTickGap={layout.fontSize * 3} padding={{ left: 8, right: 8 }}
          height={layout.xHeight} fontSize={layout.fontSize}
          tickFormatter={(value: string) => value.slice(5).replace("-", "/")} />
        <YAxis yAxisId="amount" className="trend-combined-amount-axis"
          tick={{ className: "trend-combined-amount-tick" }}
          orientation="left" tickLine={false} axisLine={false} tickMargin={8}
          width={layout.leftWidth} fontSize={layout.fontSize} allowDecimals={false}
          tickCount={amountMaximum > 0 && amountMaximum < 4 ? amountMaximum + 1 : 5}
          domain={[0, amountMaximum === 0 ? 100 : "auto"]}
          tickFormatter={(value: number) => "¥" + amountAxisFormat.format(value / 100)} />
        <YAxis yAxisId="orders" className="trend-combined-orders-axis"
          tick={{ className: "trend-combined-orders-tick" }}
          orientation="right" tickLine={false} axisLine={false} tickMargin={8}
          width={layout.rightWidth} fontSize={layout.fontSize} allowDecimals={false}
          tickCount={ordersMaximum > 0 && ordersMaximum < 4 ? ordersMaximum + 1 : 5}
          domain={[0, ordersMaximum === 0 ? 4 : "auto"]}
          tickFormatter={(value: number) => orderAxisFormat.format(value) + "笔"} />
        <ChartTooltip shared axisId={0} portal={overflowing ? tooltipPortal : undefined}
          position={!overflowing && fixedTooltip ? { x: 0 } : undefined}
          wrapperStyle={overflowing ? {
            position: "absolute", top: 0, left: 0, width: "max-content",
            maxWidth: "min(20rem, 100%)", pointerEvents: "none",
          } : { maxWidth: "100%" }} isAnimationActive={false}
          cursor={{ fill: "var(--muted)", fillOpacity: 0.45 }}
          content={
            <ChartTooltipContent className="trend-tooltip trend-combined-tooltip"
              labelFormatter={value => {
                const date = String(value);
                return `${date.replaceAll("-", "/")} ${dailyWeekday(date)}${date === today ? " · 今日" : ""}`;
              }}
              formatter={(value, name) => (
                <div className="trend-tooltip-value">
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <TrendSeriesSymbol metric={name === "amount" ? "amount" : "orders"} />
                    {chartConfig[name as TrendMetric]?.label ?? name}
                  </span>
                  <span className="min-w-0 break-all font-medium tabular-nums text-foreground">
                    {name === "amount" ? money(Number(value)) : count(Number(value)) + " 笔"}
                  </span>
                </div>
              )} />
          } />
        <Bar dataKey="amount" xAxisId={0} yAxisId="amount"
          fill={"url(#" + gradientId + ")"} stroke="none"
          radius={[4, 4, 0, 0]} maxBarSize={22} minPointSize={value => Number(value) > 0 ? 3 : 0}
          activeBar={{ fill: "var(--chart-1)", fillOpacity: 0.56 }} isAnimationActive={false} />
        <Line dataKey="orders" xAxisId={0} yAxisId="orders" type="monotone"
          stroke="var(--chart-1)" strokeWidth={2}
          dot={dot} activeDot={{ r: 4.5, fill: "var(--card)", stroke: "var(--chart-1)", strokeWidth: 2.25 }}
          isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
  );
}
