import type { Page, TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
import type { AdminLoginSessionListEnvelope, AlipayAccountListEnvelope, AuditEventPage } from "../web/src/api/generated/types.gen";
import { test, expect, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectOverlayFits } from "./overlay-fixtures";

const legacyOverlayPaths = [
  /^\/(?:sites\/[^/]+\/)?orders\/[^/]+$/,
  /^\/(?:sites\/[^/]+\/)?notifications\/[^/]+$/,
  /^\/ledger\/[^/]+$/,
  /^\/(?:sites\/[^/]+\/)?reconciliation\/(?:transactions|matches|exceptions|candidates|conflicts|ledger)\/[^/]+$/,
  /^\/audit\/(?:core|activity)\/[^/]+$/,
  /^\/audit\/status$/,
  /^\/sites\/(?:new|defaults)$/,
  /^\/sites\/[^/]+\/(?:edit|summary)$/,
  /^\/settings\/[^/]+\/edit$/,
  /^\/settings\/security\/(?:password|access|sessions\/[^/]+)$/,
  /^\/settings\/accounts\/[^/]+$/,
  /^\/test-payment$/,
];

/** Assert the requested view, including legacy deep links, rather than its background shell. */
export function adminOverlayTarget(route: string): string | null {
  const requested = new URL(route, "http://admin.test");
  const target = requested.searchParams.get("overlay") ?? (legacyOverlayPaths.some(pattern => pattern.test(requested.pathname))
    ? requested.pathname + requested.search + requested.hash : null);
  if (!target) return null;
  const record = new URL(target, "http://admin.test");
  const source = record.pathname.match(/^\/reconciliation\/ledger\/([^/]+)$/)?.[1];
  return source ? "/reconciliation/transactions/" + source + record.search + (record.hash || "#source-" + source) : target;
}

export async function waitForAdminRoute(page: Page, route: string) {
  const target = adminOverlayTarget(route);
  const overlay = page.locator("[data-overlay-content]");
  const main = page.locator("#main-content");
  if (target) {
    await expect.poll(() => new URL(page.url()).searchParams.get("overlay"), "deep link keeps its exact record and query").toBe(target);
    await expect(overlay).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.locator("[data-admin-console]")).toHaveAttribute("inert", "");
  } else {
    await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBeNull();
    await expect(overlay).toHaveCount(0);
    await expect(main).toBeVisible();
    await expect(main).not.toHaveAttribute("inert");
  }
  const foreground = target ? overlay.locator("[data-overlay-detail]") : main;
  const heading = (target ? overlay : main).getByRole("heading", { level: 1 });
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeVisible();
  // The title and shell may precede the lazy route and its data. Require actual
  // content before checking that every loading placeholder has disappeared.
  await expect(foreground.locator('form, [data-slot="card"], [data-business-table], [data-detail-fields], [data-settings-summary], [data-slot="empty"], [data-onboarding-step-heading]').first()).toBeVisible();
  await expect(foreground.locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(foreground.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await expect(foreground.getByText(/^正在读取(?:详情|登录会话)?…$/)).toHaveCount(0);
  await expect(foreground.locator("[data-request-notice], [data-read-paused]")).toHaveCount(0);
  await expect(foreground.getByRole("alert").filter({ hasText: /未找到这条对账记录|账务冲突不存在|记录不存在|订单不存在|分组不存在|详情地址无效|设置分类不存在|网站不存在|日志不存在|请求失败/ })).toHaveCount(0);
  const pathname = new URL(target ?? route, "http://admin.test").pathname;
  if (pathname.includes("/onboarding/")) await expect(foreground.locator("[data-onboarding-step-heading]")).toBeVisible();
  if (/^\/sites\/[^/]+\/summary$/.test(pathname) || /^\/settings\/security\/sessions\//.test(pathname)) {
    await expect(foreground.locator("[data-detail-fields]").first()).toBeVisible();
  }
  if (pathname === "/audit") {
    const search = new URL(route, "http://admin.test").searchParams;
    const label = search.get("view") === "all" ? "全部记录" : search.get("category") === "requests" ? "接口访问"
      : search.get("category") === "background" ? "后台任务" : search.get("category") === "maintenance" ? "维护活动" : "操作审计";
    await expect(foreground.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    const selected = foreground.getByRole("tab", { name: label, exact: true });
    await expect.poll(() => selected.evaluate(tab => {
      const container = tab.closest(".audit-view-scroll")!.getBoundingClientRect(), bounds = tab.getBoundingClientRect();
      return bounds.left >= container.left - 1 && bounds.right <= container.right + 1;
    }), "the selected audit view remains fully visible after a direct link or resize").toBe(true);
  }
  await page.clock.runFor(100);
  return { presentation: target ? "overlay" : "workspace", title: await heading.textContent(), target };
}

/** Obtain real synthetic record identities through authenticated, read-only APIs. */
export async function adminRouteCatalog(page: Page, manifest: Manifest): Promise<string[]> {
  const paths = ["/alipay-accounts", "/sessions", "/audit-events?source=core&limit=1", "/audit-events?source=activity&limit=1"];
  const responses = await Promise.all(paths.map(path => page.request.get(manifest.origin + "/api/admin/v1" + path)));
  for (const [index, response] of responses.entries()) expect(response.status(), paths[index]).toBe(200);
  const accounts = await responses[0]!.json() as AlipayAccountListEnvelope;
  const sessions = await responses[1]!.json() as AdminLoginSessionListEnvelope;
  const core = await responses[2]!.json() as AuditEventPage;
  const activity = await responses[3]!.json() as AuditEventPage;
  const account = accounts.data[0];
  const session = sessions.data.find(item => item.is_current);
  const site = manifest.routes.find(route => /^\/sites\/[^/]+\/orders$/.test(route))?.split("/")[2];
  expect(account, "fixture has an actual Alipay account").toBeDefined();
  expect(session, "fixture session remains active").toBeDefined();
  expect(site, "fixture has a scoped website").toBeDefined();
  expect(core.data.length, "fixture contains saved core audit events").toBeGreaterThan(0);
  expect(activity.data.length, "fixture contains saved activity events").toBeGreaterThan(0);
  return [...new Set([
    ...manifest.routes,
    ...manifest.extendedRoutes,
    "/audit", "/audit?source=activity&category=requests", "/audit?source=activity&category=background", "/audit?category=maintenance", "/audit?view=all",
    "/audit/status?snapshot_at=" + encodeURIComponent(core.page.snapshot_at),
    ...[core.data[0]!, activity.data[0]!].map(event => `/audit/${event.source}/${encodeURIComponent(event.event_id)}`),
    ...["collection-policy", "backup", "display", "advanced"].map(section => `/settings/${section}/edit`),
    "/settings/security/password", "/settings/security/access", "/settings/security/sessions/" + encodeURIComponent(session!.session_id),
    "/settings/accounts/new", "/settings/accounts/" + encodeURIComponent(account!.id),
    `/sites/${site}/summary`,
    ...["basic", "collection", "orders", "integration", "display"].map(section => `/sites/${site}/edit?section=${section}`),
  ])];
}

/** Keep evidence for every route even when an earlier route has a real failure. */
export async function auditAdminRoutes(page: Page, manifest: Manifest, info: TestInfo, routes: string[], prefix: string) {
  const results: Array<{ route: string; url: string; failures: string[] }> = [];
  const errors: Array<{ route: string; message: string }> = [];
  let currentRoute = "";
  const pageError = (error: Error) => errors.push({ route: currentRoute, message: error.message });
  page.on("pageerror", pageError);
  try {
    for (const [index, route] of routes.entries()) await test.step(route, async () => {
      currentRoute = route;
      const id = `${prefix}-${String(index + 1).padStart(2, "0")}-${route.split("?")[0]!.replaceAll(/[^\w-]/g, "_") || "overview"}`;
      const failures: string[] = [];
      const startErrors = info.errors.length;
      const capture = async (stage: string, action: () => Promise<unknown>) => {
        try { await action(); }
        catch (error) { failures.push(stage + ": " + (error instanceof Error ? error.message : String(error))); }
      };
      await capture("readiness", async () => {
        await page.goto(manifest.origin + "/admin" + route);
        await waitForAdminRoute(page, route);
      });
      await capture("geometry", async () => {
        const overlay = adminOverlayTarget(route);
        const overlayGeometry = overlay ? await expectOverlayFits(page) : null;
        await record(page, info, { route, presentation: overlay ? "overlay" : "workspace", overlayGeometry });
      });
      await capture("screenshot", () => screenshot(page, info, id));
      await capture("accessibility", () => audit(page, info, id));
      failures.push(...info.errors.slice(startErrors).map(error => error.message ?? String(error)));
      results.push({ route, url: page.url(), failures });
      console.log(`[admin-route-matrix] ${index + 1}/${routes.length} ${failures.length ? "FAIL" : "PASS"} ${route}`);
    });
  } finally {
    page.off("pageerror", pageError);
    const path = info.outputPath(prefix + "-route-matrix.json");
    writeFileSync(path, JSON.stringify({ requested: routes.length, completed: results.length,
      passed: results.filter(result => !result.failures.length && !errors.some(error => error.route === result.route)).length,
      viewport: page.viewportSize(), results, pageErrors: errors }, null, 2));
    await info.attach(prefix + "-route-matrix", { path, contentType: "application/json" });
  }
  expect(results.filter(result => result.failures.length), "all requested admin routes loaded and passed geometry/accessibility").toEqual([]);
  expect(errors, "no admin route raised a browser runtime error").toEqual([]);
  expect(results).toHaveLength(routes.length);
}
