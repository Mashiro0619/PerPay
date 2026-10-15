import { test, expect, login, record } from "./fixtures";
import { audit } from "./audit";
test("chart, avatar, amount list and dangerous action semantics stay accessible in both themes", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const order = manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route))!;
    const settings = manifest.routes.find(route => /^\/sites\/[^/]+\/settings$/.test(route))!;
    for (const [index, route] of ["/", order, settings].entries()) {
      await page.goto(manifest.origin + "/admin" + route);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
      if (route === "/") await expect(page.locator(".recharts-surface")).toBeVisible();
      await audit(page, info, `${theme}-${index}`);
      await record(page, info, { theme, route });
    }
  }
});
