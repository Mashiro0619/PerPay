import { useId, useLayoutEffect, useRef, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import type { TrendDay, TrendMetric } from "@/lib/trend-analytics";
import { money, count } from "@/lib/format";
import { dailyWeekday } from "@/lib/daily-analytics";
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

function SeriesSymbol({ metric }: { metric: TrendMetric }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 12" className="h-3 w-5 shrink-0">
      {metric === "amount" ? (
        <rect x="3" y="1" width="14" height="10" rx="1.5"
          fill="var(--chart-1)" fillOpacity={0.18} stroke="var(--chart-1)" />
      ) : (
        <>
          <path d="M0 6H20" fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="4 3" />
          <circle cx="10" cy="6" r="2.5" fill="var(--card)" stroke="var(--chart-2)" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

export function CombinedTrendPlot({ data, today }: { data: TrendDay[]; today: string }) {
  const legendId = useId();
  const scrollHintId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const [tooltipPortal, setTooltipPortal] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState({
    fontSize: 12, leftWidth: 60, rightWidth: 44, xHeight: 30, viewportWidth: 0,
  });

  useLayoutEffect(() => {
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const fontSize = rem * 0.75;
      const bounds = (selector: string) => Array.from(
        chart.current?.querySelectorAll<SVGGraphicsElement>(selector) ?? [],
        element => typeof element.getBBox === "function" ? element.getBBox() : element.getBoundingClientRect(),
      ).filter(box => box.width > 0 && box.height > 0);
      // Recharts renders labels in a separate SVG layer, outside the axis group.
      const amounts = bounds("text.trend-combined-amount-tick");
      const orders = bounds("text.trend-combined-orders-tick");
      const dates = bounds(".recharts-xAxis-tick-labels text");
      const next = {
        fontSize,
        leftWidth: Math.ceil((amounts.length ? Math.max(...amounts.map(box => box.width)) : fontSize * 4) + 14),
        rightWidth: Math.ceil((orders.length ? Math.max(...orders.map(box => box.width)) : fontSize * 3) + 14),
        xHeight: Math.ceil((dates.length ? Math.max(...dates.map(box => box.height)) : fontSize) + 18),
        viewportWidth: viewport.current?.clientWidth ?? 0,
      };
      setLayout(previous =>
        previous.fontSize === next.fontSize && previous.leftWidth === next.leftWidth &&
        previous.rightWidth === next.rightWidth && previous.xHeight === next.xHeight &&
        previous.viewportWidth === next.viewportWidth ? previous : next,
      );
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const labels = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    if (viewport.current) resize?.observe(viewport.current);
    if (chart.current) {
      resize?.observe(chart.current);
      labels?.observe(chart.current, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["width", "height", "style", "transform", "font-size"],
      });
    }
    window.addEventListener("resize", measure);
    return () => {
      resize?.disconnect();
      labels?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Each axis retains its own scale and readable labels. Only the plot scrolls
  // when enlarged text would leave less than nine rem for the actual data.
  const minimumWidth = layout.leftWidth + layout.rightWidth + layout.fontSize * 12;
  const overflowing = layout.viewportWidth > 0 && minimumWidth > layout.viewportWidth + 1;
  const fixedTooltip = layout.viewportWidth < layout.fontSize / 0.75 * 40 + 20;
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
    <div className="flex min-w-0 flex-col gap-3" data-combined-trend>
      <div id={legendId} role="list" aria-label="混合图图例"
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span role="listitem" className="flex min-w-0 max-w-full items-center gap-2">
          <SeriesSymbol metric="amount" />
          <span>确认金额（左轴 · 元）</span>
        </span>
        <span role="listitem" className="flex min-w-0 max-w-full items-center gap-2">
          <SeriesSymbol metric="orders" />
          <span>新建订单（右轴 · 笔）</span>
        </span>
      </div>
      <div className="relative min-w-0">
        <div ref={viewport}
          className="max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-combined-scroll data-combined-overflow={overflowing || undefined}
          role={overflowing ? "region" : undefined}
          aria-label={overflowing ? "混合图横向滚动区域" : undefined}
          aria-describedby={overflowing ? scrollHintId : undefined}
          tabIndex={overflowing ? 0 : undefined}>
          <ChartContainer ref={chart} config={chartConfig} data-chart-type="COMBINED"
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
                          <SeriesSymbol metric={name === "amount" ? "amount" : "orders"} />
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
        </div>
        <div ref={setTooltipPortal} className="pointer-events-none absolute inset-0" />
      </div>
      {overflowing && <p id={scrollHintId} className="text-xs text-muted-foreground">可左右滑动或聚焦滚动区域查看完整图表。</p>}
    </div>
  );
}
