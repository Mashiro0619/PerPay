import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";

for (const width of [1440, 390]) test(`${width}: overview placeholders match their sections and cached navigation does not replay loading`, async ({ page, manifest }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const releases: (() => void)[] = [];
  let hold = true;
  await page.route("**/api/admin/v1/**", async route => {
    const url = new URL(route.request().url());
    const target = url.pathname.endsWith("/system/analytics") ||
      url.pathname.endsWith("/orders") && url.searchParams.get("limit") === "5" ||
      url.pathname.endsWith("/work-items") && url.searchParams.get("limit") === "4";
    if (!target || !hold) return route.continue();
    const response = await route.fetch();
    await new Promise<void>(resolve => releases.push(resolve));
    await route.fulfill({ response });
  });
  try {
    await login(page, manifest);
    await expect(page.locator("[data-overview-record-loading]")).toHaveCount(2);
    await expect(page.locator('[data-overview-kpis] [data-slot="skeleton"]')).toHaveCount(4);
    const kpis = page.locator('[data-overview-kpis] > [data-slot="card"]');
    const before = await kpis.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    const rows = await page.locator("[data-overview-record-loading]").evaluateAll(nodes => nodes.map(node => ({
      placeholders: node.querySelectorAll(':scope > [aria-hidden="true"]').length,
      bounds: node.getBoundingClientRect().toJSON(),
    })));
    expect(rows.map(row => row.placeholders)).toEqual([4, 5]);
    await screenshot(page, info, `overview-pending-${width}`);
    hold = false;
    releases.forEach(release => release());
    await expect(page.locator("[data-overview-record-loading]")).toHaveCount(0);
    await expect(page.locator('[data-overview-kpis] [data-slot="skeleton"]')).toHaveCount(0);
    const after = await kpis.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    for (let index = 0; index < before.length; index++) expect(Math.abs(before[index]!.height - after[index]!.height)).toBeLessThanOrEqual(1);
    await screenshot(page, info, `overview-ready-${width}`);
    // Query cache should keep the already loaded overview sections available
    // while its existing refetch-on-mount updates in the background.
    await page.locator('.overview-orders-panel a[href$="/orders"]').click();
    await expect(page.locator('[data-business-table="orders"]')).toBeVisible();
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as Window & { __readPlaceholders?: string[] }).__readPlaceholders = seen;
      new MutationObserver(records => { for (const item of records) for (const node of item.addedNodes) {
        if (node instanceof Element && (node.matches('[data-overview-record-loading]') || node.querySelector('[data-overview-record-loading]'))) seen.push("record placeholder");
      } }).observe(document.querySelector("#main-content")!, { childList: true, subtree: true });
    });
    await page.goBack();
    await expect(page.locator("[data-overview-layout]")).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __readPlaceholders?: string[] }).__readPlaceholders)).toEqual([]);
    await record(page, info, { feature: "overview-read-placeholders", width, rows, kpiBefore: before, kpiAfter: after, cacheNavigation: true });
  } finally { hold = false; releases.forEach(release => release()); }
});

test("an uncached list read pauses offline and resumes without displaying another filter's rows", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/orders");
  await expect(page.locator('[data-business-row]').first()).toBeVisible();
  try {
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.getByRole("searchbox", { name: "订单关键词搜索" }).fill("不存在的离线筛选");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator("[data-read-paused]")).toBeVisible();
    await expect(page.locator("#main-content [data-business-row]")).toHaveCount(0);
    await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
    await screenshot(page, info, "orders-waiting-network");
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/orders" && response.ok(), { timeout: 10_000 });
    await page.context().setOffline(false);
    await response;
    await expect(page.locator("[data-read-paused]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "没有符合条件的订单" })).toBeVisible();
    await record(page, info, { feature: "offline-list-resume", browserNetworkOffline: true, oldFilterRowsSuppressed: true });
  } finally { await page.context().setOffline(false); }
});

test("an initial read failure has no invented data and retry restores the requested scope", async ({ page, manifest }, info) => {
  let failure = true;
  await page.route("**/api/admin/v1/orders?*", async route => {
    if (failure && new URL(route.request().url()).searchParams.get("q") === "initial-read-test")
      return route.fulfill({ status: 503, json: { error: { code: "synthetic_read_failure", message: "读取暂不可用" } } });
    await route.continue();
  });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/orders?q=initial-read-test");
  await expect(page.getByText("读取暂不可用", { exact: true })).toBeVisible();
  await expect(page.locator("#main-content [data-business-row]")).toHaveCount(0);
  await expect(page.getByText("更新未完成，以下保留上次成功读取的内容。", { exact: true })).toHaveCount(0);
  failure = false;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("读取暂不可用", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "没有符合条件的订单" })).toBeVisible();
  await record(page, info, { feature: "initial-read-retry", inventedRows: false });
});
