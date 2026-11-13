import type { TrendMetric } from "@/lib/trend-analytics";

export function TrendSeriesSymbol({ metric }: { metric: TrendMetric }) {
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
