export const DASHBOARD_SECTION_KEYS = [
  "summary_cards",
  "trend",
  "site_overview",
  "work_items",
  "recent_orders",
] as const;

export type DashboardSectionKey = (typeof DASHBOARD_SECTION_KEYS)[number];

export interface DashboardSections {
  readonly summary_cards: boolean;
  readonly trend: boolean;
  readonly site_overview: boolean;
  readonly work_items: boolean;
  readonly recent_orders: boolean;
}

export const DEFAULT_DASHBOARD_SECTIONS: DashboardSections = Object.freeze({
  summary_cards: true,
  trend: true,
  site_overview: true,
  work_items: true,
  recent_orders: true,
});

export function normalizeDashboardSections(
  value: Partial<Record<DashboardSectionKey, unknown>> | null | undefined,
): DashboardSections {
  return {
    summary_cards: typeof value?.summary_cards === "boolean" ? value.summary_cards : true,
    trend: typeof value?.trend === "boolean" ? value.trend : true,
    site_overview: typeof value?.site_overview === "boolean" ? value.site_overview : true,
    work_items: typeof value?.work_items === "boolean" ? value.work_items : true,
    recent_orders: typeof value?.recent_orders === "boolean" ? value.recent_orders : true,
  };
}

export function hasVisibleDashboardSection(sections: DashboardSections): boolean {
  return DASHBOARD_SECTION_KEYS.some((key) => sections[key]);
}

export function serializeDashboardSections(sections: DashboardSections): string {
  return JSON.stringify({
    summary_cards: sections.summary_cards,
    trend: sections.trend,
    site_overview: sections.site_overview,
    work_items: sections.work_items,
    recent_orders: sections.recent_orders,
  });
}

export function parseDashboardSectionsJson(raw: string | null | undefined): DashboardSections {
  if (!raw) return { ...DEFAULT_DASHBOARD_SECTIONS };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_DASHBOARD_SECTIONS };
    }
    const normalized = normalizeDashboardSections(parsed as Partial<Record<DashboardSectionKey, unknown>>);
    return hasVisibleDashboardSection(normalized) ? normalized : { ...DEFAULT_DASHBOARD_SECTIONS };
  } catch {
    return { ...DEFAULT_DASHBOARD_SECTIONS };
  }
}
