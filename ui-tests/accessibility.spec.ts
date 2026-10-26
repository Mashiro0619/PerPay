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

test("sidebar footer stays fully visible on desktop and reachable on mobile", async ({ page, manifest }, info) => {
  for (const [width, height] of [[1280, 720], [1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await login(page, manifest);
    if (width < 1024) await page.getByRole("button", { name: "切换导航", exact: true }).click();
    const footer = page.locator('[data-slot="sidebar-footer"]:visible');
    const targets = footer.locator("a, button");
    await expect(targets).toHaveCount(5);
    const geometry = [];
    for (const target of await targets.all()) {
      if (width < 1024) await target.scrollIntoViewIfNeeded();
      await expect(target).toBeVisible();
      const bounds = await target.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        let top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === "visible") continue;
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { label: element.getAttribute("aria-label") ?? element.textContent, height: bounds.height, visibleHeight: bottom - top };
      });
      expect(bounds.visibleHeight, JSON.stringify({ viewport: { width, height }, target: bounds })).toBeGreaterThanOrEqual(bounds.height - .5);
      geometry.push(bounds);
    }
    await record(page, info, { width, height, sidebarFooter: geometry });
  }
});
