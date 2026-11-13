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
      fill="var(--card)" stroke="var(--chart-2)" strokeWidth={2}
      data-trend-point={payload && payload.orders > 0 ? payload.date : undefined}
    />
  );

  return (
    <ChartContainer config={chartConfig} data-chart-type="COMBINED"
      role="group" className="trend-plot aspect-auto w-full"
      style={{ minWidth: minimumWidth }} aria-describedby={legendId}
      aria-label="每日确认金额与新建订单，左轴为元，右轴为笔数，左右方向键查看日期">
      <ComposedChart key={layout.fontSize} accessibilityLayer data={data}
        margin={{ top: layout.fontSize, right: 0, bottom: layout.fontSize / 2, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 5" yAxisId="amount" />
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
          cursor={{ fill: "var(--muted-foreground)", fillOpacity: 0.08 }}
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
          fill="var(--chart-1)" fillOpacity={0.18} stroke="var(--chart-1)" strokeOpacity={0.75}
          radius={[2, 2, 0, 0]} maxBarSize={28} minPointSize={value => Number(value) > 0 ? 3 : 0}
          activeBar={{ fillOpacity: 0.3 }} isAnimationActive={false} />
        <Line dataKey="orders" xAxisId={0} yAxisId="orders" type="linear"
          stroke="var(--chart-2)" strokeWidth={2.5} strokeDasharray="6 4"
          dot={dot} activeDot={{ r: 5, fill: "var(--card)", stroke: "var(--chart-2)", strokeWidth: 2 }}
          isAnimationActive={false} />
      </ComposedChart>
    </ChartContainer>
  );
}
