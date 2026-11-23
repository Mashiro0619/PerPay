import {
  DASHBOARD_SECTION_KEYS,
  DEFAULT_DASHBOARD_SECTIONS,
  hasVisibleDashboardSection,
  normalizeDashboardSections,
  parseDashboardSectionsJson,
  serializeDashboardSections,
  type DashboardSectionKey,
  type DashboardSections,
} from "../../../src/shared/dashboard-sections";

export {
  DASHBOARD_SECTION_KEYS,
  DEFAULT_DASHBOARD_SECTIONS,
  hasVisibleDashboardSection,
  normalizeDashboardSections,
  parseDashboardSectionsJson,
  serializeDashboardSections,
  type DashboardSectionKey,
  type DashboardSections,
};

export const DASHBOARD_SECTION_META: ReadonlyArray<{
  readonly key: DashboardSectionKey;
  readonly label: string;
  readonly description: string;
}> = [
  {
    key: "summary_cards",
    label: "核心指标",
    description: "今日确认金额、收款确认笔数、当前待付款与待处理统计卡片。",
  },
  {
    key: "trend",
    label: "收款趋势",
    description: "按日收款趋势图表与每日数据日历。",
  },
  {
    key: "site_overview",
    label: "各网站概览",
    description: "全部网站总览下的各网站实收与待处理排行。",
  },
  {
    key: "work_items",
    label: "待处理",
    description: "需要跟进的异常、冲突与通知失败提醒列表。",
  },
  {
    key: "recent_orders",
    label: "最近订单",
    description: "最新订单的金额、收款与通知状态记录。",
  },
];

export function formatDashboardSectionsSummary(
  value: Partial<Record<DashboardSectionKey, unknown>> | null | undefined,
): string {
  const sections = normalizeDashboardSections(value);
  const enabled = DASHBOARD_SECTION_META.filter((item) => sections[item.key]);
  if (enabled.length === DASHBOARD_SECTION_META.length) {
    return `全部显示（${enabled.length} 项）`;
  }
  return enabled.map((item) => item.label).join("、");
}

const STORAGE_KEY = "perpay:dashboard-sections";

export function readCachedDashboardSections(): DashboardSections | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const normalized = normalizeDashboardSections(parsed as Partial<Record<DashboardSectionKey, unknown>>);
    return hasVisibleDashboardSection(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export function writeCachedDashboardSections(sections: DashboardSections): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeDashboardSections(sections));
  } catch {
    // Ignore storage quota or private browsing errors.
  }
}
