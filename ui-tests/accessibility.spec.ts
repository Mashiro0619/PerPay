import { test, expect, login, record } from "./fixtures";
import { audit } from "./audit";
import AxeBuilder from "@axe-core/playwright";
import { waitForControlAnimations } from "./touch-targets";

test("sidebar and record menu names include their visible labels", async ({ page, manifest }, info) => {
  const order = manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route))!;
  for (const mode of ["expanded", "collapsed", "mobile"] as const) {
    await page.setViewportSize(mode === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin" + order);
    await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /订单操作$/ })).toBeVisible();
    if (mode === "mobile" || mode === "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
    const account = page.getByRole("button", { name: /账户菜单$/ });
    await page.clock.runFor(50);
    await waitForControlAnimations(account);
    if (mode === "mobile") {
      const website = page.getByRole("button", { name: /^业务网站 .*，(?:收起|展开)$/ });
      await website.scrollIntoViewIfNeeded();
      const result = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
      await info.attach("mobile-website-label-content-name", { body: JSON.stringify(result), contentType: "application/json" });
      expect.soft(result.violations, "mobile website").toEqual([]);
      expect(result.passes.some(rule => rule.id === "label-content-name-mismatch")).toBe(true);
    }
    await account.scrollIntoViewIfNeeded();
    // This WCAG 2.1 A rule is not covered by the general audit's AA tag list.
    const result = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
    await info.attach(`${mode}-label-content-name`, { body: JSON.stringify(result), contentType: "application/json" });
    expect.soft(result.violations, mode).toEqual([]);
    expect(result.passes.some(rule => rule.id === "label-content-name-mismatch")).toBe(true);
    if (mode === "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
  }
});

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
