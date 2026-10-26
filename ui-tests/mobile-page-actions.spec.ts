import type { Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

async function openWithKeyboard(page: Page) {
  const trigger = page.getByRole("button", { name: "页面操作", exact: true });
  await trigger.press("Enter");
  const menu = page.getByRole("menu", { name: "页面操作", exact: true });
  await expect(menu).toBeVisible();
  return { trigger, menu };
}

async function setTextSize(page: Page, font: number) {
  await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
  await page.clock.runFor(100);
}

test.describe("mobile page action menus support real keyboard navigation", () => {
  test.use({ hasTouch: true, isMobile: true, reducedMotion: "reduce" });

  for (const [width, height, font] of [[320, 560, 200], [390, 844, 100]] as const) {
    test(`${width}x${height}, ${font}% text: route actions and appearance share the menu keyboard model`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => {
        if (localStorage.getItem("perpay:theme") === null) localStorage.setItem("perpay:theme", "light");
      });
      const writes: string[] = [];
      await page.route("**/api/admin/v1/**", async route => {
        if (["GET", "HEAD", "OPTIONS"].includes(route.request().method())) return route.continue();
        writes.push(route.request().method() + " " + new URL(route.request().url()).pathname);
        await route.fulfill({ status: 403, json: { error: { code: "keyboard_test_read_only", message: "只验证菜单键盘操作" } } });
      });
      await login(page, manifest);

      await page.goto(manifest.origin + "/admin/settings/display");
      await expect(page.getByRole("group", { name: "首页图表样式", exact: true })).toBeVisible();
      await setTextSize(page, font);
      const settings = await openWithKeyboard(page);
      const wizard = settings.menu.getByRole("menuitem", { name: "配置向导", exact: true });
      const settingsRefresh = settings.menu.getByRole("menuitem", { name: "刷新", exact: true });
      const settingsAppearance = settings.menu.getByRole("menuitem", { name: /^外观/ });
      await expect(settingsRefresh).toBeEnabled();
      await expect(wizard).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settingsRefresh).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(settingsAppearance).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(settingsRefresh).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(wizard).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(settingsAppearance).toBeFocused();

      await page.keyboard.press("ArrowRight");
      const light = page.getByRole("menuitemradio", { name: "浅色", exact: true });
      const dark = page.getByRole("menuitemradio", { name: "深色", exact: true });
      await expect(light).toBeFocused();
      await expect(light).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      await expect(light).toHaveCount(0);
      await expect(settingsAppearance).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(light).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(dark).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(settings.menu).toHaveCount(0);
      await expect(settings.trigger).toBeFocused();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("perpay:theme"))).toBe("dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await openWithKeyboard(page);
      await page.keyboard.press("Escape");
      await expect(settings.menu).toHaveCount(0);
      await expect(settings.trigger).toBeFocused();
      await page.reload();
      await expect(page.getByRole("group", { name: "首页图表样式", exact: true })).toBeVisible();
      await setTextSize(page, font);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(await page.evaluate(() => localStorage.getItem("perpay:theme"))).toBe("dark");
      await record(page, info, { feature: "mobile-page-actions-keyboard", width, height, font, route: "settings", themePersistedAfterReload: true });

      await page.goto(manifest.origin + "/admin/settings/onboarding/check");
      await expect(page.locator("[data-onboarding-workspace]")).toBeVisible();
      const onboardingUrl = page.url();
      await setTextSize(page, font);
      const onboarding = await openWithKeyboard(page);
      const tutorial = onboarding.menu.getByRole("menuitem", { name: "图文教程", exact: true });
      const onboardingRefresh = onboarding.menu.getByRole("menuitem", { name: "刷新", exact: true });
      const onboardingAppearance = onboarding.menu.getByRole("menuitem", { name: /^外观/ });
      await expect(onboardingRefresh).toBeEnabled();
      await expect(tutorial).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(onboardingRefresh).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(onboardingAppearance).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(onboardingRefresh).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(tutorial).toBeFocused();
      // The external tutorial is only focused; it is never activated.
      await page.keyboard.press("Escape");
      await expect(onboarding.menu).toHaveCount(0);
      await expect(onboarding.trigger).toBeFocused();
      await expect(page).toHaveURL(onboardingUrl);
      await record(page, info, { feature: "mobile-page-actions-keyboard", width, height, font, route: "onboarding" });

      const orderPath = manifest.details.orderPaid;
      expect(orderPath).toMatch(/^\/orders\/[^/]+$/);
      await page.goto(manifest.origin + "/admin" + orderPath);
      await expect(page.locator("[data-detail-card-grid]")).toBeVisible();
      await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
      await setTextSize(page, font);
      const order = await openWithKeyboard(page);
      const orderRefresh = order.menu.getByRole("menuitem", { name: "刷新", exact: true });
      const orderAppearance = order.menu.getByRole("menuitem", { name: /^外观/ });
      await expect(orderRefresh).toBeEnabled();
      await expect(orderRefresh).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(orderAppearance).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(orderRefresh).toBeFocused();
      const refreshed = page.waitForResponse(response => response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/admin/v1" + orderPath);
      await page.keyboard.press("Enter");
      await refreshed;
      await expect(order.menu).toHaveCount(0);
      await expect(order.trigger).toBeFocused();
      expect(writes, "menu navigation, appearance and refreshing never perform business writes").toEqual([]);
      await record(page, info, { feature: "mobile-page-actions-keyboard", width, height, font, route: "order", writes });
    });
  }
});
