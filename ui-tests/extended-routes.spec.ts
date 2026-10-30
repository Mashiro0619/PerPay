import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";

for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} ${viewport.width}: wizard, website settings and scoped details`, async ({ page, manifest }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme });
    await login(page, manifest);
    for (const [index, route] of manifest.extendedRoutes.entries()) {
      await page.goto(manifest.origin + "/admin" + route);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
      await expect(page.locator('#main-content h1, #main-content [role="heading"][aria-level="1"]')).toHaveCount(1);
      await expect(page.locator("#main-content")).not.toContainText(/未找到这条对账记录|记录不存在|订单不存在|分组不存在/);
      if (route.includes("/onboarding/")) await expect(page.locator("[data-onboarding-step-heading]")).toBeVisible();
      else if (route.includes("/settings/")) await expect(page.locator('[role="tab"][aria-selected="true"]')).toBeVisible();
      await record(page, info, { route, requested: { theme, viewport } });
      await screenshot(page, info, `extended-${index}`);
      await audit(page, info, `extended-${index}`);
    }
  });
}
