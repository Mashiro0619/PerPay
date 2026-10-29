import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

type TransitionProbe = Window & { __sidebarViewTransitions?: number; __sidebarPositions?: { y: number; time: number }[] };

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

async function indicatorClearance(link: Locator) {
  return link.evaluate(element => {
    const bar = element.querySelector<HTMLElement>('[data-selection-indicator="sidebar"]')!;
    const mark = bar.getBoundingClientRect(), bounds = element.getBoundingClientRect();
    const content = [...element.children].filter(child => child !== bar).map(child => {
      const rect = child.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }).filter(rect => rect.width > 0 && rect.height > 0);
    const style = getComputedStyle(bar);
    return { mark: mark.toJSON(), bounds: bounds.toJSON(), content, mode: bar.dataset.selectionMode,
      pointerEvents: style.pointerEvents, hidden: bar.getAttribute("aria-hidden"),
      clear: content.length > 0 && content.every(rect => mark.right <= rect.left),
      contained: mark.left >= bounds.left && mark.right <= bounds.right && mark.top >= bounds.top && mark.bottom <= bounds.bottom };
  });
}

test("desktop sidebar selection moves vertically without page snapshots and stays clear in icon mode", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await watchPageTransitions(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await login(page, manifest);
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  const overview = navigation.getByRole("link", { name: "总览", exact: true });
  const orders = navigation.getByRole("link", { name: "订单", exact: true });
  await page.clock.runFor(300);
  const from = (await overview.locator('[data-selection-indicator="sidebar"]').boundingBox())!;
  const target = (await orders.boundingBox())!;
  await orders.evaluate(link => {
    const positions: { y: number; time: number }[] = [];
    (window as TransitionProbe).__sidebarPositions = positions;
    let started = false;
    const observer = new MutationObserver(() => {
      if (started || link.getAttribute("aria-current") !== "page") return;
      started = true;
      observer.disconnect();
      const began = performance.now();
      const sample = () => {
        const mark = link.querySelector('[data-selection-indicator="sidebar"]');
        if (mark) positions.push({ y: mark.getBoundingClientRect().y, time: performance.now() - began });
        if (positions.length < 20) requestAnimationFrame(sample);
      };
      sample();
    });
    observer.observe(link, { attributes: true, attributeFilter: ["aria-current"], childList: true });
  });
  await orders.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(orders).toHaveAttribute("aria-current", "page");
  await expect(overview).not.toHaveAttribute("aria-current");
  await expect(orders).toBeFocused();
  await page.clock.runFor(350);
  const during = await page.evaluate(() => (window as TransitionProbe).__sidebarPositions ?? []);
  const offset = from.y - (await overview.boundingBox())!.y;
  expect(during.some(point => point.y > from.y + 1 && point.y < target.y + offset - 1), "the selected indicator travels through an intermediate position after route commit").toBe(true);
  const after = await indicatorClearance(orders);
  expect(Math.abs(after.mark.y - target.y - offset)).toBeLessThanOrEqual(1);
  expect(after.mark.width).toBe(2);
  expect(after.clear).toBe(true);
  expect(after.contained).toBe(true);
  expect(after.pointerEvents).toBe("none");
  expect(after.hidden).toBe("true");
  expect(after.mode).toBe("motion");
  await expect(navigation.locator('[data-selection-indicator="sidebar"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as TransitionProbe).__sidebarViewTransitions)).toBe(0);

  const toggle = page.getByRole("button", { name: "切换导航", exact: true });
  await toggle.click();
  const rail = page.locator('[data-slot="sidebar"][data-collapsible="icon"]');
  await expect(rail).toBeVisible();
  await page.clock.runFor(300);
  const collapsed = await indicatorClearance(orders);
  expect(collapsed.clear).toBe(true);
  expect(collapsed.contained).toBe(true);
  expect(collapsed.mark.width).toBe(2);
  await orders.focus();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(orders.locator('[data-selection-indicator="sidebar"]')).toHaveAttribute("data-selection-mode", "static");
  await expect(orders).toBeFocused();
  await overview.click();
  await expect(page).toHaveURL(manifest.origin + "/admin/");
  await expect(overview).toHaveAttribute("aria-current", "page");
  await expect(overview.locator('[data-selection-indicator="sidebar"]')).toHaveAttribute("data-selection-mode", "static");
  await page.clock.runFor(50);
  expect((await indicatorClearance(overview)).clear).toBe(true);
  expect(await page.evaluate(() => (window as TransitionProbe).__sidebarViewTransitions)).toBe(0);
  expect(errors).toEqual([]);
  await record(page, info, { scenario: "sidebar-selection", from, target, during, after, collapsed, errors });
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
    await page.clock.runFor(300);
    const overview = drawer.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "总览", exact: true });
    const initial = await indicatorClearance(overview);
    expect(initial.clear).toBe(true);
    expect(initial.contained).toBe(true);
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
    await expect(orders.locator('[data-selection-indicator="sidebar"]')).toHaveAttribute("data-selection-mode", "static");
    const reduced = await indicatorClearance(orders);
    expect(reduced.clear).toBe(true);
    expect(reduced.contained).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await record(page, info, { scenario: "mobile-sidebar-motion", initial, reduced });
  });
});
