/** SVG attributes keep the amount comparison compatible with the administrator CSP. */
export function SiteAmountBar({ amount, maximum }: { amount: number; maximum: number }) {
  const width = maximum > 0 ? Math.max(0, Math.min(100, amount / maximum * 100)) : 0;
  return (
    <svg
      className="site-overview-amount-bar"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="site-overview-amount-track" width="100" height="4" />
      <rect className="site-overview-amount-fill" width={width} height="4" fill="currentColor" />
    </svg>
  );
}
