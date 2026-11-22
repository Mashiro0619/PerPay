import type { TrendMetric } from "@/lib/trend-analytics";

export function TrendSeriesSymbol({ metric }: { metric: TrendMetric }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 12" className="h-3 w-5 shrink-0">
      {metric === "amount" ? (
        <>
          <rect x="2" y="6" width="4" height="5" rx="1" fill="var(--chart-1)" fillOpacity={0.38} />
          <rect x="8" y="2" width="4" height="9" rx="1" fill="var(--chart-1)" fillOpacity={0.62} />
          <rect x="14" y="4" width="4" height="7" rx="1" fill="var(--chart-1)" fillOpacity={0.46} />
        </>
      ) : (
        <>
          <path d="M1 8.5L7 5.5L13 6.5L19 2.5" fill="none" stroke="var(--chart-1)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="10" cy="6" r="2.25" fill="var(--card)" stroke="var(--chart-1)" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}
