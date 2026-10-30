import { useCallback, useEffect, useState } from "react";
import type { DashboardChartType } from "@/api/client";

export const CHART_TYPE_STORAGE_KEY = "perpay:dashboard-chart-type";

function chartType(value: string | null): DashboardChartType | null {
  return value === "AREA" || value === "BAR" || value === "LINE" ? value : null;
}

export function useChartType(fallback: DashboardChartType) {
  const [selected, setSelected] = useState<DashboardChartType | null>(() => {
    try { return chartType(localStorage.getItem(CHART_TYPE_STORAGE_KEY)); }
    catch { return null; }
  });

  useEffect(() => {
    function storage(event: StorageEvent) {
      if (event.key !== null && event.key !== CHART_TYPE_STORAGE_KEY) return;
      try {
        if (event.storageArea !== null && event.storageArea !== localStorage) return;
      } catch { return; }
      setSelected(event.key === null ? null : chartType(event.newValue));
    }
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, []);

  const select = useCallback((value: DashboardChartType) => {
    setSelected(value);
    try { localStorage.setItem(CHART_TYPE_STORAGE_KEY, value); }
    catch { /* The current chart remains usable when browser storage is blocked. */ }
  }, []);

  // Existing instance defaults still apply until this browser makes a choice.
  return [selected ?? fallback, select] as const;
}
