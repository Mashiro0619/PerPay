import { test, expect, login, record } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${theme} ${viewport.width}: all valid admin routes`, async ({ page, manifest }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
    await login(page, manifest);
    for (const route of manifest.routes) {
      await page.goto(manifest.origin + "/admin" + route);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.locator("#main-content")).not.toContainText("未找到这条对账记录");
      await record(page, info, { route });
      await info.attach(route.replaceAll(/[^\w-]/g, "_") || "overview", { body: await page.screenshot(), contentType: "image/png" });
    }
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    await info.attach("accessibility", { body: JSON.stringify({ passes: accessibility.passes, violations: accessibility.violations, incomplete: accessibility.incomplete, inapplicable: accessibility.inapplicable }), contentType: "application/json" });
    expect(accessibility.violations).toEqual([]);
  });
}
