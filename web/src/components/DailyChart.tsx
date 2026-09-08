import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { SystemAnalytics } from "../api/client";
import { areaGeometry, chartIndex, chartScale, type ChartBounds } from "../lib/chart";
import { BUSINESS_TIME_ZONE, count, money } from "../lib/format";
import { playMotion } from "../lib/motion";
import { Button, EmptyState } from "./ui";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: BUSINESS_TIME_ZONE, month: "2-digit", day: "2-digit" });
const tickFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });

export function DailyChart({ analytics }: { analytics: SystemAnalytics }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(620);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  const previousRange = useRef(analytics.range_days);
  const helpId = useId();
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (previousRange.current === analytics.range_days) return;
    previousRange.current = analytics.range_days;
    const plot = container.current?.querySelector(".chart-interaction");
    if (plot) return playMotion(plot, [{ opacity: 0.65 }, { opacity: 1 }], { duration: 180 });
  }, [analytics.range_days]);

  const selectedIndex = analytics.daily.findIndex((day) => day.date === selectedDate);
  const index = selectedIndex < 0 ? analytics.daily.length - 1 : selectedIndex;
  const current = analytics.daily[index];
  const amounts = analytics.daily.map((day) => day.confirmed_amount_cents);
  const orders = analytics.daily.map((day) => day.orders_created);
  const amountScale = chartScale(amounts);
  const orderScale = chartScale(orders);
  const amountBounds = { left: 62, right: width - 14, top: 38, bottom: 136 };
  const orderBounds = { ...amountBounds, top: 208, bottom: 290 };
  const amountGeometry = areaGeometry(amounts, amountBounds, amountScale.maximum);
  const orderGeometry = areaGeometry(orders, orderBounds, orderScale.maximum);

  function choose(next: number) {
    setAnnounce(true);
    const destination = Math.max(0, Math.min(next, analytics.daily.length - 1));
    setSelectedDate(destination === analytics.daily.length - 1 ? null : analytics.daily[destination]?.date ?? null);
  }
  function point(event: PointerEvent<SVGSVGElement>) {
    const rectangle = event.currentTarget.getBoundingClientRect();
    if (!rectangle.width) return;
    setAnnounce(false);
    const destination = chartIndex((event.clientX - rectangle.left) / rectangle.width * width, amountBounds, analytics.daily.length);
    setSelectedDate(destination === analytics.daily.length - 1 ? null : analytics.daily[destination]?.date ?? null);
  }
  function grid(bounds: ChartBounds, scale: ReturnType<typeof chartScale>, divisor: number) {
    return scale.ticks.map((tick) => {
      const vertical = bounds.bottom - tick / scale.maximum * (bounds.bottom - bounds.top);
      return <g key={tick}><line x1={bounds.left} y1={vertical} x2={bounds.right} y2={vertical} className="chart-grid-line" />
        <text x={bounds.left - 12} y={vertical + 4} textAnchor="end" className="chart-label">{tickFormatter.format(tick / divisor)}</text></g>;
    });
  }
  return <div className="daily-chart" ref={container}>
    {!current ? <EmptyState headingLevel={3} title="暂无每日统计" description="请重新加载统计数据。" /> : <>
      <div className="chart-readout" aria-live={announce ? "polite" : "off"} aria-atomic="true">
        <time dateTime={current.date}>{current.date}<span>北京时间</span></time>
        <span><span className="chart-dot" />确认金额<strong>{money(current.confirmed_amount_cents)}</strong></span>
        <span><span className="chart-dot chart-dot--orders" />新建订单<strong>{count(current.orders_created)} 笔</strong></span>
      </div>
      <div className="chart-interaction" tabIndex={0} role="group" aria-label="每日金额与新建订单趋势" aria-describedby={helpId} onKeyDown={(event) => {
        const destination = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? analytics.daily.length - 1 : null;
        if (destination === null) return;
        event.preventDefault();
        choose(destination);
      }}>
        <svg viewBox={`0 0 ${width} 330`} aria-hidden="true" onPointerMove={point} onPointerDown={point}>
          <text x="0" y="16" className="chart-series-title">付款确认金额 · 元</text>
          {grid(amountBounds, amountScale, 100)}
          <path d={amountGeometry.area} className="chart-area" data-series="amount" />
          <path d={amountGeometry.line} pathLength={1} className="chart-line" />
          <text x="0" y="186" className="chart-series-title">新建订单 · 笔</text>
          {grid(orderBounds, orderScale, 1)}
          <path d={orderGeometry.area} className="chart-area chart-area--orders" data-series="orders" />
          <path d={orderGeometry.line} pathLength={1} className="chart-line chart-line--orders" />
          {amountGeometry.points[index] && <g className="chart-cursor" transform={`translate(${amountGeometry.points[index].horizontal} 0)`}><line className="chart-crosshair" x1="0" x2="0" y1={amountBounds.top} y2={orderBounds.bottom} /></g>}
          {[amountGeometry, orderGeometry].map((geometry, seriesIndex) => {
            const active = geometry.points[index];
            return active && <g key={seriesIndex} className="chart-cursor" transform={`translate(${active.horizontal} ${active.vertical})`}>
              <circle r="9" className={`chart-point-halo ${seriesIndex === 1 ? "chart-point-halo--orders" : ""}`} />
              <circle r="4" className={`chart-point ${seriesIndex === 1 ? "chart-point--orders" : ""}`} />
            </g>;
          })}
          {analytics.daily.map((day, dayIndex) => {
            if (![0, Math.floor((analytics.daily.length - 1) / 2), analytics.daily.length - 1].includes(dayIndex)) return null;
            return <text key={day.date} x={amountGeometry.points[dayIndex]!.horizontal} y="316" textAnchor={dayIndex === 0 ? "start" : dayIndex === analytics.daily.length - 1 ? "end" : "middle"} className="chart-label">{dateFormatter.format(new Date(`${day.date}T00:00:00+08:00`))}</text>;
          })}
          {!amounts.some(Boolean) && <text x={(amountBounds.left + amountBounds.right) / 2} y="92" textAnchor="middle" className="chart-label">暂无付款确认记录</text>}
          {!orders.some(Boolean) && <text x={(orderBounds.left + orderBounds.right) / 2} y="256" textAnchor="middle" className="chart-label">暂无新建订单</text>}
        </svg>
      </div>
      <div className="chart-controls"><p id={helpId}>悬停、轻点或使用 ← → 查看每日数据</p><div>
        <Button variant="quiet" className="icon-button" aria-label="前一天" disabled={index === 0} onClick={() => choose(index - 1)}><ChevronLeft size={17} aria-hidden="true" /></Button>
        <Button variant="quiet" className="icon-button" aria-label="后一天" disabled={index === analytics.daily.length - 1} onClick={() => choose(index + 1)}><ChevronRight size={17} aria-hidden="true" /></Button>
      </div></div>
    </>}
    <details className="chart-data"><summary>查看每日数据表 · 北京时间</summary><div className="table-scroll" role="region" aria-label="每日收款数据" tabIndex={0}>
      <table className="data-table"><thead><tr><th scope="col">日期（北京时间）</th><th scope="col" className="numeric">新建订单</th><th scope="col" className="numeric">确认次数</th><th scope="col" className="numeric">确认金额</th></tr></thead><tbody>{analytics.daily.map((day) => <tr key={day.date}><td>{day.date}</td><td className="numeric">{count(day.orders_created)}</td><td className="numeric">{count(day.confirmations)}</td><td className="numeric">{money(day.confirmed_amount_cents)}</td></tr>)}</tbody></table>
    </div></details>
  </div>;
}
