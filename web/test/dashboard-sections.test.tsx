import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardSections, ListSiteOverviewResponse } from "../src/api/client";
import { auditChangeValues, auditFieldLabel } from "../src/lib/audit";
import {
  writeCachedDashboardSections,
  writeCachedDashboardWorkItemsLayout,
} from "../src/lib/dashboard-sections";
import { json } from "./fixtures";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";

afterEach(() => {
  window.localStorage.removeItem("perpay:dashboard-sections");
  window.localStorage.removeItem("perpay:dashboard-work-items-layout");
});

function mountOverviewWithSections(
  sections: DashboardSections,
  path = "/",
  workItemsLayout?: "STACKED" | "SIDE_BY_SIDE",
) {
  const base = configuredThrough(4);
  const customSettings = {
    ...base,
    display: {
      ...base.display,
      dashboard_sections: sections,
      ...(workItemsLayout ? { dashboard_work_items_layout: workItemsLayout } : {}),
    },
  };
  return mountOnboarding({
    stage: 4,
    path,
    handle: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/admin/v1/settings" && request.method === "GET") {
        return json({ data: customSettings });
      }
      if (url.pathname === "/api/admin/v1/sites") {
        return json({
          data: [
            { client_id: "site_a", revision: 0, configuration: { name: "示例网站 A", accepting_orders: true, notifications_enabled: false } },
            { client_id: "site_b", revision: 0, configuration: { name: "示例网站 B", accepting_orders: true, notifications_enabled: false } },
          ],
          page: { next_cursor: null },
        });
      }
      if (url.pathname === "/api/admin/v1/sites/overview") {
        return json({
          period: { from: "2026-09-11", to: "2026-10-10" },
          max_confirmed_amount_cents: 12000,
          data: [
            {
              client_id: "site_a",
              name: "示例网站 A",
              accepting_orders: true,
              notifications_enabled: false,
              confirmed_count: 3,
              confirmed_amount_cents: 12000,
              pending_orders: 1,
              work_items: 1,
            },
            {
              client_id: "site_b",
              name: "示例网站 B",
              accepting_orders: true,
              notifications_enabled: false,
              confirmed_count: 1,
              confirmed_amount_cents: 4500,
              pending_orders: 0,
              work_items: 0,
            },
          ],
          page: { next_cursor: null },
        } satisfies ListSiteOverviewResponse);
      }
      if (url.pathname === "/api/admin/v1/sites/site_a") {
        return json({
          data: {
            client_id: "site_a",
            revision: 0,
            secrets: { api_secret: true, webhook_secret: false },
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
            deleted_at: null,
            configuration: {
              name: "示例网站 A",
              accepting_orders: true,
              notifications_enabled: false,
              notification_origin: null,
              return_origin: null,
              collection: { mode: "FIXED", accounts: [{ account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", weight: 1 }] },
              policy: {
                orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
                display: { checkout_name: "示例网站 A", checkout_help_url: null, checkout_show_product_name: true },
                notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 5, retry_base_seconds: 10, retry_maximum_seconds: 600 },
              },
            },
          },
        });
      }
      if (url.pathname === "/api/admin/v1/sites/site_a/analytics" || url.pathname === "/api/admin/v1/system/analytics") {
        return json({
          data: {
            range_days: 30,
            from: "2026-09-01",
            to: "2026-09-08",
            orders: { created: 4, unpaid: 1, confirmed: 3, disputed: 0, closed: 0, expired: 0 },
            confirmations: { count: 3, amount_cents: 16500 },
            pending: { orders: 1, exceptions: 0, conflicts: 0, notifications: 0 },
            notifications: { acknowledged: 0, failed: 0, pending: 0 },
            daily: [
              {
                date: "2026-09-08",
                orders_created: 4,
                confirmations: 3,
                confirmed_amount_cents: 16500,
                notifications_acknowledged: 0,
                notifications_failed: 0,
              },
            ],
          },
        });
      }
      return undefined;
    },
  });
}

describe("dashboard section visibility", () => {
  it("hides disabled modules cleanly and omits empty layout wrappers", async () => {
    const view = mountOverviewWithSections({
      summary_cards: false,
      trend: false,
      site_overview: true,
      work_items: false,
      recent_orders: true,
    });

    expect(await screen.findByRole("heading", { name: "各网站概览" })).toBeVisible();
    await waitFor(() => {
      expect(view.container.querySelector("[data-overview-kpis]")).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "最近订单" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "收款趋势" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "全部待处理" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".overview-trend")).toBeNull();
    expect(view.container.querySelector(".overview-work-panel")).toBeNull();
    expect(view.container.querySelector(".overview-hero")).not.toBeNull();
    expect(view.container.querySelector(".overview-records")).not.toBeNull();
  });

  it("omits both hero and records containers when only summary cards are enabled", async () => {
    const view = mountOverviewWithSections({
      summary_cards: true,
      trend: false,
      site_overview: false,
      work_items: false,
      recent_orders: false,
    });

    await waitFor(() => {
      expect(view.container.querySelector("[data-overview-kpis]")).not.toBeNull();
      expect(view.container.querySelector(".overview-hero")).toBeNull();
      expect(view.container.querySelector(".overview-records")).toBeNull();
    });
  });

  it("shows a helpful link to display settings when a single-site view has no visible modules", async () => {
    mountOverviewWithSections(
      {
        summary_cards: false,
        trend: false,
        site_overview: true,
        work_items: false,
        recent_orders: false,
      },
      "/sites/site_a",
    );

    expect(await screen.findByRole("heading", { name: "当前视角没有已开启的总览模块" })).toBeVisible();
    expect(screen.getByRole("link", { name: "界面显示设置" })).toHaveAttribute("href", "/settings/display");
  });

  it("renders saved section switches directly inline on the display settings page", async () => {
    mountOverviewWithSections(
      {
        summary_cards: true,
        trend: false,
        site_overview: false,
        work_items: false,
        recent_orders: true,
      },
      "/settings/display",
    );

    const sectionsGroup = await screen.findByRole("group", { name: "总览显示模块" });
    expect(screen.getByText("已开启 2 / 5")).toBeVisible();
    expect(sectionsGroup.querySelector('[role="switch"]')).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "核心指标" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "最近订单" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "收款趋势" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "各网站概览" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "待处理" })).not.toBeChecked();
  });

  it("uses cached dashboard sections on cold load to avoid flashing hidden cards", async () => {
    writeCachedDashboardSections({
      summary_cards: false,
      trend: false,
      site_overview: false,
      work_items: false,
      recent_orders: true,
    });
    let siteOverviewRequests = 0;
    const view = mountOnboarding({
      stage: 4,
      path: "/",
      handle: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/admin/v1/settings") {
          return new Promise<Response>(() => {});
        }
        if (pathname === "/api/admin/v1/sites/overview") {
          siteOverviewRequests += 1;
        }
        return undefined;
      },
    });
    expect(await screen.findByRole("heading", { name: "最近订单" })).toBeVisible();
    expect(view.container.querySelector("[data-overview-kpis]")).toBeNull();
    expect(view.container.querySelector(".overview-hero")).toBeNull();
    expect(view.container.querySelector(".overview-work-panel")).toBeNull();
    expect(view.container.querySelector(".overview-orders-container")).not.toBeNull();
    expect(siteOverviewRequests).toBe(0);
  });

  it("applies dashboard_work_items_layout on the overview and displays it in settings summary", async () => {
    const view = mountOverviewWithSections(
      {
        summary_cards: true,
        trend: true,
        site_overview: true,
        work_items: true,
        recent_orders: true,
      },
      "/",
      "SIDE_BY_SIDE",
    );
    await waitFor(() => {
      expect(view.container.querySelector(".overview-records")).toHaveAttribute("data-work-layout", "side-by-side");
    });

    mountOverviewWithSections(
      {
        summary_cards: true,
        trend: true,
        site_overview: true,
        work_items: true,
        recent_orders: true,
      },
      "/settings/display",
      "SIDE_BY_SIDE",
    );
    const layoutGroup = await screen.findByRole("group", { name: "待处理排列方式" });
    expect(layoutGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent("与订单并排");
  });

  it("uses cached work-items layout on cold load before settings arrive", async () => {
    writeCachedDashboardWorkItemsLayout("SIDE_BY_SIDE");
    const view = mountOnboarding({
      stage: 4,
      path: "/",
      handle: (request) => {
        if (new URL(request.url).pathname === "/api/admin/v1/settings") {
          return new Promise<Response>(() => {});
        }
        return undefined;
      },
    });
    expect(await screen.findByRole("heading", { name: "最近订单" })).toBeVisible();
    expect(view.container.querySelector(".overview-records")).toHaveAttribute("data-work-layout", "side-by-side");
  });

  it("formats display audit labels and values in Chinese without leaking raw JSON", () => {
    expect(auditFieldLabel("dashboard_sections.trend")).toBe("总览模块：收款趋势");
    expect(auditFieldLabel("dashboard_work_items_layout")).toBe("待处理排列方式");
    expect(auditFieldLabel("target_version")).toBe("目标版本");
    expect(auditFieldLabel("previous_version")).toBe("更新前版本");
    expect(auditFieldLabel("create_backup")).toBe("更新前备份");
    expect(auditChangeValues({
      field: "dashboard_chart_type",
      kind: "value",
      before: "AREA",
      after: "BAR",
    })).toEqual(["面积图", "柱状图"]);
    expect(auditChangeValues({
      field: "dashboard_work_items_layout",
      kind: "value",
      before: "STACKED",
      after: "SIDE_BY_SIDE",
    })).toEqual(["独立成行", "与订单并排"]);
    expect(auditChangeValues({
      field: "dashboard_sections",
      kind: "value",
      before: { summary_cards: true, trend: true, site_overview: true, work_items: true, recent_orders: true },
      after: { summary_cards: true, trend: false, site_overview: false, work_items: true, recent_orders: true },
    })).toEqual(["全部显示（5 项）", "核心指标、待处理、最近订单"]);
  });
});
