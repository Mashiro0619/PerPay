import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DashboardSections, ListSiteOverviewResponse } from "../src/api/client";
import { json } from "./fixtures";
import { configuredThrough, mountOnboarding } from "./onboarding-fixture";

function mountOverviewWithSections(
  sections: DashboardSections,
  path = "/",
) {
  const base = configuredThrough(4);
  const customSettings = {
    ...base,
    display: {
      ...base.display,
      dashboard_sections: sections,
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

  it("displays concise summary rows on the display settings page", async () => {
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

    expect(await screen.findByText("总览显示模块", { exact: true, selector: "dt" })).toBeVisible();
    expect(screen.getByText("核心指标、最近订单", { exact: true, selector: "dd" })).toBeVisible();
  });
});
