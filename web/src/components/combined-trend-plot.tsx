import { lazy, Suspense, useId, useLayoutEffect, useRef, useState } from "react";
import type { TrendDay } from "@/lib/trend-analytics";
import { TrendSeriesSymbol } from "@/components/trend-series-symbol";
import { Skeleton } from "@/components/ui/skeleton";

const CombinedTrendChart = lazy(() =>
  import("@/components/combined-trend-chart").then((module) => ({
    default: module.CombinedTrendChart,
  })),
);

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

  return (
    <div className="flex min-w-0 flex-col gap-3" data-combined-trend>
      <div id={legendId} role="list" aria-label="混合图图例"
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span role="listitem" className="flex min-w-0 max-w-full items-center gap-2">
          <TrendSeriesSymbol metric="amount" />
          <span>确认金额（左轴 · 元）</span>
        </span>
        <span role="listitem" className="flex min-w-0 max-w-full items-center gap-2">
          <TrendSeriesSymbol metric="orders" />
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
          <div ref={chart} className="min-w-0" style={{ minWidth: minimumWidth }}>
            <Suspense fallback={<Skeleton className="trend-plot w-full" data-chart-state="loading" />}>
              <CombinedTrendChart
                data={data}
                today={today}
                layout={layout}
                minimumWidth={minimumWidth}
                overflowing={overflowing}
                fixedTooltip={fixedTooltip}
                tooltipPortal={tooltipPortal}
                legendId={legendId}
              />
            </Suspense>
          </div>
        </div>
        <div ref={setTooltipPortal} className="pointer-events-none absolute inset-0" />
      </div>
      {overflowing && <p id={scrollHintId} className="text-xs text-muted-foreground">可左右滑动或聚焦滚动区域查看完整图表。</p>}
    </div>
  );
}
