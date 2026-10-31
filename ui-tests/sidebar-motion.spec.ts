import type { Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

type TransitionProbe = Window & { __sidebarViewTransitions?: number };

async function watchPageTransitions(page: Page) {
  await page.addInitScript(() => {
    (window as TransitionProbe).__sidebarViewTransitions = 0;
    const original = document.startViewTransition?.bind(document);
    if (original) document.startViewTransition = (...args) => {
      (window as TransitionProbe).__sidebarViewTransitions!++;
      return original(...args);
    };
  });
}

test("desktop sidebar preserves navigation and focus in icon mode without page snapshots", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await watchPageTransitions(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page, manifest);
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  const overview = navigation.getByRole("link", { name: "总览", exact: true });
  const orders = navigation.getByRole("link", { name: "订单", exact: true });
  await orders.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(orders).toHaveAttribute("aria-current", "page");
  await expect(overview).not.toHaveAttribute("aria-current");
  await expect(orders).toBeFocused();
  expect(await page.evaluate(() => (window as TransitionProbe).__sidebarViewTransitions)).toBe(0);

  const toggle = page.getByRole("button", { name: "切换导航", exact: true });
  await toggle.click();
  const rail = page.locator('[data-slot="sidebar"][data-collapsible="icon"]');
  await expect(rail).toBeVisible();
  await expect(orders).toHaveAttribute("aria-current", "page");
  await orders.focus();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(orders).toBeFocused();
  await overview.click();
  await expect(page).toHaveURL(manifest.origin + "/admin/");
  await expect(overview).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => (window as TransitionProbe).__sidebarViewTransitions)).toBe(0);
  expect(errors).toEqual([]);
  await record(page, info, { scenario: "sidebar-selection", errors });
});

test.describe("touch sidebar", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("mobile Sheet keeps menu actions accessible and restores its trigger focus", async ({ page, manifest }, info) => {
    await watchPageTransitions(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await login(page, manifest);
    const trigger = page.getByRole("button", { name: "切换导航", exact: true });
    await trigger.tap();
    const drawer = page.getByRole("dialog", { name: "导航菜单", exact: true });
    await expect(drawer).toBeVisible();
    const overview = drawer.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "总览", exact: true });
    await expect(overview).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "关闭导航", exact: true }).tap();
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.tap();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "订单", exact: true }).tap();
    await expect(page).toHaveURL(/\/admin\/orders$/);
    await expect(drawer).toBeHidden();
    expect(await page.evaluate(() => (window as TransitionProbe).__sidebarViewTransitions)).toBe(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.tap();
    await expect(drawer).toBeVisible();
    const orders = drawer.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "订单", exact: true });
    await expect(orders).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await record(page, info, { scenario: "mobile-sidebar-selection" });
  });
});
