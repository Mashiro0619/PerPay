import { test, expect, login, record } from "./fixtures";
test("chart plot has matching loading, empty and populated heights at mobile and desktop sizes", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/");
    const plot = page.locator('[data-slot="chart"]');
    await expect(plot).toBeVisible();
    const height = width < 768 ? 224 : 256;
    expect((await plot.boundingBox())!.height).toBe(height);
    const yAxis = plot.locator(".recharts-yAxis .recharts-cartesian-axis-tick");
    await expect(yAxis).toHaveCount(5);
    await record(page, info, { plotHeight: height });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/admin/v1/system/analytics?**", async route => {
      const response = await route.fetch(); const data = await response.json();
      data.data.daily = [];
      await pending;
      await route.fulfill({ response, json: data });
    });
    await page.reload();
    const loading = page.locator('[data-chart-state="loading"]');
    await expect(loading).toBeVisible();
    expect((await loading.boundingBox())!.height).toBe(height);
    release();
    const empty = page.locator('[data-chart-state="empty"]');
    await expect(empty).toBeVisible();
    expect((await empty.boundingBox())!.height).toBe(height);
    await page.unroute("**/api/admin/v1/system/analytics?**");
  }
});
