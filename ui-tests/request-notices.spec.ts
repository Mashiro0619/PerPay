import type { Page, TestInfo } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

const reads = [
  ["session", "/api/admin/v1/session", "会话"],
  ["settings", "/api/admin/v1/settings", "设置"],
  ["status", "/api/admin/v1/system/status", "运行状态"],
  ["analytics", "/api/admin/v1/system/analytics", "统计"],
  ["orders", "/api/admin/v1/orders", "订单"],
  ["work-items", "/api/admin/v1/work-items", "待处理"],
  ["sites", "/api/admin/v1/sites", "网站"],
  ["site-overview", "/api/admin/v1/sites/overview", "网站概览"],
] as const;

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const width of [1440, 390]) {
  test.describe(`shared service notice at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });

    test("concurrent read failures stay in one notice through retry and recovery", async ({ page, manifest }, info) => {
      // The mobile site's list only mounts while its navigation Sheet is open.
      const activeReads = reads.filter(([key]) => width !== 390 || key !== "sites");
      let outage = false;
      const recovered = new Set<string>();
      const attempts = new Map<string, number>();
      const failures = new Map<string, number>();
      const requestIds = new Map<string, string>();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/admin/v1/**", async route => {
        const request = route.request();
        const read = reads.find(([, path]) => path === new URL(request.url()).pathname);
        if (request.method() !== "GET" || !read) return route.fallback();
        const [key, , label] = read;
        attempts.set(key, (attempts.get(key) ?? 0) + 1);
        if (!outage || recovered.has(key)) return route.fallback();
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        const requestId = `browser-${key}-${count}`;
        requestIds.set(key, requestId);
        await route.fulfill({ status: 503, json: { error: {
          code: "synthetic_backend_failure", message: `${label}读取暂不可用`, request_id: requestId,
        } } });
      });

      await login(page, manifest);
      const notice = page.locator("main [data-request-notice]");
      const kpis = page.locator('[data-overview-kpis] [data-slot="card-title"]');
      await expect(kpis).toHaveCount(4);
      await expect.poll(async () => (await kpis.allTextContents()).every(value => value.trim() !== "" && value.trim() !== "—")).toBe(true);
      await expect.poll(() => activeReads.every(([key]) => attempts.has(key))).toBe(true);
      const healthyValues = await kpis.allTextContents();
      await expect(notice).toHaveCount(0);

      // A real reconnect refetches stale session/settings reads while preserving
      // the authenticated workspace and the last successful overview data.
      await page.clock.setFixedTime(new Date(manifest.epoch + 61_000));
      await page.context().setOffline(true);
      await expect(page.getByRole("status", { name: "服务连接提示", exact: true })).toHaveText(/等待网络恢复/);
      await expect(notice).toHaveCount(1);
      await expect(page.getByRole("alert")).toHaveCount(0);
      outage = true;
      await page.context().setOffline(false);
      await expect.poll(() => activeReads.every(([key]) => requestIds.has(key))).toBe(true);
      await page.clock.runFor(1500);
      const retry = notice.getByRole("button", { name: "重试", exact: true });
      await expect(notice).toHaveAttribute("role", "alert");
      await expect(notice).toContainText("服务暂时不可用，请稍后重试。");
      await expect(notice).toContainText("更新未完成，以下保留上次成功读取的内容。");
      await expect(retry).toBeEnabled();
      await expect(page.getByRole("alert")).toHaveCount(1);
      await expect(kpis).toHaveText(["—", "—", "—", "—"]);
      await expect(page.locator("[data-overview-layout]").getByRole("alert")).toHaveCount(0);
      await expect(page.locator('.trend-card [data-slot="chart"]')).toBeVisible();
      await notice.getByRole("button", { name: "错误详情", exact: true }).click();
      await expect(notice.getByRole("listitem")).toHaveCount(activeReads.length);
      for (const [key] of activeReads) await expect(notice).toContainText(`请求编号：${requestIds.get(key)}`);

      if (width === 390) {
        await page.getByRole("button", { name: "切换导航", exact: true }).click();
        await expect.poll(() => requestIds.has("sites")).toBe(true);
        await page.clock.runFor(1500);
        await expect(notice.locator("li")).toHaveCount(activeReads.length);
      }
      const sidebar = width === 390 ? page.getByRole("dialog", { name: "导航菜单", exact: true })
        : page.locator('[data-slot="sidebar-inner"]');
      await expect(sidebar).toBeVisible();
      if (width === 390) {
        // Modal recovery stays in the active focus scope; the page notice is
        // hidden from assistive technology while the navigation Sheet is open.
        const localNotice = sidebar.getByRole("alert");
        await expect(localNotice).toHaveCount(1);
        await expect(localNotice).toContainText("网站读取暂不可用");
        await expect(page.getByRole("alert")).toHaveCount(1);
        await expect(page.getByRole("button", { name: "重试", exact: true })).toHaveCount(1);
        const localRetry = localNotice.getByRole("button", { name: "重试", exact: true });
        await localRetry.focus();
        await expect(localRetry).toBeFocused();
        const beforeLocalRetry = failures.get("sites")!;
        await localRetry.press("Enter");
        await expect.poll(() => failures.get("sites")!).toBeGreaterThan(beforeLocalRetry);
        await page.clock.runFor(1500);
        await expect(localNotice).toHaveCount(1);
        await capture(page, info, "navigation-outage-390");
      } else {
        await expect(sidebar.getByRole("alert")).toHaveCount(0);
      }
      await expect(sidebar.getByRole("navigation", { name: "全局管理", exact: true })
        .getByRole("link", { name: "运行状态", exact: true })).toHaveAccessibleDescription("状态未知");
      if (width === 390) await page.keyboard.press("Escape");
      await expect(retry).toBeVisible();
      await expect(notice.getByRole("listitem")).toHaveCount(activeReads.length);
      await capture(page, info, `outage-details-${width}`);
      await notice.getByRole("button", { name: "错误详情", exact: true }).click();
      await page.clock.runFor(350);
      await expect(notice.getByRole("button", { name: "错误详情", exact: true })).toHaveAttribute("aria-expanded", "false");
      await expect(notice.getByRole("listitem")).toHaveCount(0);
      await capture(page, info, `outage-${width}`);
      await record(page, info, { scenario: "shared-service-outage", width, requestIds: Object.fromEntries(requestIds) });

      const beforeRetry = new Map(failures);
      await retry.click();
      await expect.poll(() => activeReads.every(([key]) => (failures.get(key) ?? 0) > beforeRetry.get(key)!)).toBe(true);
      await page.clock.runFor(1500);
      await expect(retry).toBeEnabled();
      await expect(notice).toHaveCount(1);
      await expect(page.getByRole("alert")).toHaveCount(1);
      await expect(notice.getByRole("button", { name: "重试", exact: true })).toHaveCount(1);
      await notice.getByRole("button", { name: "错误详情", exact: true }).click();
      await expect(notice.getByRole("listitem")).toHaveCount(activeReads.length);
      await expect(kpis).toHaveText(["—", "—", "—", "—"]);
      for (const [key] of activeReads) await expect(notice).toContainText(`请求编号：${requestIds.get(key)}`);

      // A successful request removes only its own diagnostics; other failed
      // reads still have one warning and remain eligible for the shared retry.
      recovered.add("status");
      const stillFailedReads = activeReads.filter(([key]) => key !== "status");
      const beforePartial = new Map(attempts);
      await retry.click();
      await expect.poll(() => activeReads.every(([key]) => attempts.get(key)! > beforePartial.get(key)!)).toBe(true);
      await page.clock.runFor(1500);
      await expect(notice).toHaveCount(1);
      await expect(page.getByRole("alert")).toHaveCount(1);
      await expect(retry).toBeEnabled();
      await expect(notice.getByRole("listitem")).toHaveCount(stillFailedReads.length);
      await expect(notice).not.toContainText(`请求编号：${requestIds.get("status")}`);
      await expect(kpis).toHaveText(["—", "—", "—", healthyValues[3]!]);
      await capture(page, info, `partial-recovery-${width}`);

      outage = false;
      const beforeRecovery = new Map(attempts);
      await retry.click();
      await expect(notice).toHaveCount(0);
      await expect(kpis).toHaveText(healthyValues);
      expect(stillFailedReads.every(([key]) => attempts.get(key)! > beforeRecovery.get(key)!)).toBe(true);
      expect(attempts.get("status")).toBe(beforeRecovery.get("status"));
      if (width === 390) {
        await page.getByRole("button", { name: "切换导航", exact: true }).click();
        await expect.poll(() => attempts.get("sites")! > beforeRecovery.get("sites")!).toBe(true);
        await expect(page.getByRole("dialog", { name: "导航菜单", exact: true }).getByRole("alert")).toHaveCount(0);
        await expect(notice).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
      await expect(page).toHaveURL(manifest.origin + "/admin/");
      expect(errors).toEqual([]);
      await capture(page, info, `recovery-${width}`);
      await record(page, info, { scenario: "shared-service-recovery", width, healthyValues,
        attempts: Object.fromEntries(attempts), failedReads: Object.fromEntries(failures), errors });
    });

    test("selected-site metadata and site-list failures share one navigation recovery", async ({ page, manifest }, info) => {
      const clientId = manifest.details.matchSite!.split("/")[2]!;
      const metadataPath = `/api/admin/v1/sites/${clientId}`;
      let outage = false;
      const failures = new Map<string, number>();
      await page.route("**/api/admin/v1/sites**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (!outage || request.method() !== "GET" || !["/api/admin/v1/sites", metadataPath].includes(path))
          return route.fallback();
        failures.set(path, (failures.get(path) ?? 0) + 1);
        await route.fulfill({ status: 503, json: { error: {
          code: "synthetic_backend_failure", message: path === metadataPath ? "当前网站读取暂不可用" : "网站列表读取暂不可用",
          request_id: `navigation-${path === metadataPath ? "metadata" : "list"}-${failures.get(path)}`,
        } } });
      });
      await login(page, manifest);
      const loadedSite = page.waitForResponse(response => new URL(response.url()).pathname === metadataPath && response.status() === 200);
      await page.goto(manifest.origin + "/admin/system?selected_site=" + encodeURIComponent(clientId));
      await loadedSite;
      await page.clock.runFor(50);
      await expect(page.locator("[data-content-width]")).toBeVisible();
      if (width === 1440) await page.getByRole("button", { name: "切换导航", exact: true }).click();
      await page.clock.setFixedTime(new Date(manifest.epoch + 61_000));
      outage = true;
      await page.context().setOffline(true);
      await expect(page.getByRole("status", { name: "服务连接提示", exact: true })).toContainText("等待网络恢复");
      await page.context().setOffline(false);
      await expect.poll(() => failures.get(metadataPath) ?? 0).toBeGreaterThan(0);
      if (width === 390) await page.getByRole("button", { name: "切换导航", exact: true }).click();
      else await page.getByRole("button", { name: /^切换业务网站，当前/ }).click();
      const overlay = width === 390 ? page.getByRole("dialog", { name: "导航菜单", exact: true })
        : page.locator('[data-slot="popover-content"]');
      await expect(overlay).toBeVisible();
      await expect.poll(() => failures.get("/api/admin/v1/sites") ?? 0).toBeGreaterThan(0);
      await page.clock.runFor(1500);
      const notice = overlay.getByRole("alert");
      await expect(notice).toHaveCount(1);
      const retry = notice.getByRole("button", { name: "重试", exact: true });
      await expect(overlay.getByRole("button", { name: "重试", exact: true })).toHaveCount(1);
      await notice.getByRole("button", { name: "错误详情", exact: true }).click();
      await expect(notice.getByRole("listitem")).toHaveCount(2);
      await expect(notice).toContainText("当前网站读取暂不可用");
      await expect(notice).toContainText("网站列表读取暂不可用");
      await capture(page, info, `selected-site-outage-${width}`);
      const before = new Map(failures);
      await retry.focus();
      await expect(retry).toBeFocused();
      await retry.press("Enter");
      await expect.poll(() => [...before].every(([path, count]) => failures.get(path)! > count)).toBe(true);
      await page.clock.runFor(1500);
      await expect(notice).toHaveCount(1);
      outage = false;
      await retry.click();
      await expect(notice).toHaveCount(0);
      await capture(page, info, `selected-site-recovery-${width}`);
      await record(page, info, { scenario: "selected-site-navigation-recovery", width });
    });

    test("leaving a failed page clears its warning without retrying inactive reads", async ({ page, manifest }, info) => {
      let outage = false;
      let failedReads = 0;
      await page.route("**/api/admin/v1/system/analytics**", async route => {
        if (!outage) return route.fallback();
        failedReads += 1;
        await route.fulfill({ status: 503, json: { error: {
          code: "synthetic_backend_failure", message: "统计读取暂不可用", request_id: `analytics-${failedReads}`,
        } } });
      });
      await login(page, manifest);
      await expect(page.locator('.trend-card [data-slot="chart"]')).toBeVisible();
      outage = true;
      await page.clock.setFixedTime(new Date(manifest.epoch + 61_000));
      await page.context().setOffline(true);
      await expect(page.getByRole("status", { name: "服务连接提示", exact: true })).toContainText("等待网络恢复");
      await page.context().setOffline(false);
      const notice = page.locator("[data-request-notice]");
      await expect(notice).toHaveCount(1);
      await expect(notice).toContainText("统计读取暂不可用");
      const before = failedReads;
      await notice.getByRole("link", { name: "运行状态", exact: true }).click();
      await expect(page).toHaveURL(manifest.origin + "/admin/system");
      await expect(notice).toHaveCount(0);
      await page.clock.runFor(1500);
      expect(failedReads).toBe(before);
      await record(page, info, { scenario: "page-notice-unmount", width, failedReads });
    });
  });
}
