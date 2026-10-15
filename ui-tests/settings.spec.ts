import { test, expect, login, record } from "./fixtures";
test("settings categories expose horizontal scroll and retain manual keyboard activation", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  for (const route of manifest.routes.filter(route => /^\/settings\/[^/]+$/.test(route))) {
    await page.goto(manifest.origin + "/admin" + route);
    const list = page.getByRole("tablist", { name: "设置分类" });
    await expect(list).toBeVisible();
    const selected = list.locator('[aria-selected="true"]');
    const scroll = page.locator("[data-settings-tabs-scroll]");
    await expect.poll(async () => {
      const bounds = await selected.boundingBox(), region = await scroll.boundingBox();
      return bounds!.x >= region!.x - 1 && bounds!.x + bounds!.width <= region!.x + region!.width + 1;
    }).toBe(true);
    await selected.focus();
    const before = page.url();
    await page.keyboard.press("ArrowRight");
    expect(page.url()).toBe(before);
    await record(page, info, { route, selected: await selected.textContent() });
  }
  await page.goto(manifest.origin + "/admin/settings/provider");
  const next = page.getByRole("button", { name: "向后滚动设置分类" });
  await expect(next).toBeVisible();
  const scroll = page.locator("[data-settings-tabs-scroll]");
  await next.click();
  await expect.poll(() => scroll.evaluate(e => e.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(manifest.origin + "/admin/settings/display");
  const width = (await page.locator(".admin-settings-layout").boundingBox())!.width;
  expect(width).toBeLessThanOrEqual(896);
  await expect(page.getByRole("button", { name: "向后滚动设置分类" })).toBeHidden();
});
