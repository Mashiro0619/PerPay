import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget, tapOutsideVisible, waitForControlAnimations } from "./touch-targets";

async function readableText(target: Locator) {
  const geometry = await target.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    return { left: text.left - box.left, top: text.top - box.top, right: text.right - box.left, bottom: text.bottom - box.top, width: box.width, height: box.height };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
  return geometry;
}

test.describe("compact mobile controls preserve their actual touch areas", () => {
  test.use({ hasTouch: true, isMobile: true, reducedMotion: "reduce" });

  for (const width of [320, 390]) {
    test(`${width}px: sidebar, select, menu and toolbar use compact geometry and real taps`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 700 });
      await login(page, manifest);
      const period = page.getByRole("combobox", { name: "统计周期", exact: true });
      await expect(period).toBeVisible();
      await period.evaluate(element => element.scrollIntoView({ block: "center" }));
      await page.clock.runFor(100);
      const selection = await expectTouchTarget(period);
      expect(selection.visual.height).toBeCloseTo(40, 1);
      await period.tap();
      const week = page.getByRole("option", { name: "近 7 天", exact: true });
      const option = await expectTouchTarget(week);
      expect(option.visual.height).toBeCloseTo(40, 1);
      await week.tap();
      await expect(period.locator('[data-slot="select-value"]')).toHaveText("近 7 天");

      const pageActions = page.getByRole("button", { name: "页面操作", exact: true });
      await pageActions.tap();
      const actions = page.getByRole("menu", { name: "页面操作", exact: true });
      const refresh = actions.getByRole("menuitem", { name: "刷新", exact: true });
      await expect(refresh).toBeEnabled();
      const menuRow = await expectTouchTarget(refresh);
      expect(menuRow.visual.height).toBeCloseTo(40, 1);
      await refresh.tap();
      await expect(actions).toHaveCount(0);
      await expect(pageActions).toBeFocused();

      await page.getByRole("button", { name: "切换导航", exact: true }).tap();
      const sidebar = page.getByRole("dialog", { name: "导航菜单", exact: true });
      const overview = sidebar.getByRole("link", { name: "总览", exact: true });
      const orders = sidebar.getByRole("link", { name: "订单", exact: true });
      const overviewTarget = await expectTouchTarget(overview);
      const orderTarget = await expectTouchTarget(orders);
      expect(overviewTarget.visual.height).toBeCloseTo(40, 1);
      expect(orderTarget.visual.height).toBeCloseTo(40, 1);
      expect(orderTarget.y - overviewTarget.y - overviewTarget.height).toBeCloseTo(2, 1);
      await orders.tap();
      await expect(page).toHaveURL(manifest.origin + "/admin/orders");
      await expect(sidebar).toHaveCount(0);
      const filter = page.getByRole("button", { name: "筛选与排序", exact: true });
      const filterTarget = await expectTouchTarget(filter);
      expect(filterTarget.visual.height).toBeCloseTo(32, 1);
      expect(filterTarget.height).toBeCloseTo(40, 1);
      await tapOutsideVisible(page, filter, "top");
      const filters = page.getByRole("dialog", { name: "筛选与排序", exact: true });
      await expect(filters).toBeVisible();
      await filters.getByRole("button", { name: "关闭对话框", exact: true }).tap();
      await expect(filter).toBeFocused();
      await record(page, info, { feature: "compact-controls", width, selection, option, menuRow, overviewTarget, orderTarget, filterTarget });
    });
  }

  test("200% text grows without clipping controls or losing navigation", async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await login(page, manifest);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.clock.runFor(100);
    const period = page.getByRole("combobox", { name: "统计周期", exact: true });
    await period.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.clock.runFor(100);
    await expectTouchTarget(period);
    const selection = await readableText(period.locator('[data-slot="select-value"]'));
    await period.tap();
    const week = page.getByRole("option", { name: "近 7 天", exact: true });
    await expectTouchTarget(week);
    await readableText(week);
    await week.tap();
    await expect(period.locator('[data-slot="select-value"]')).toHaveText("近 7 天");
    await page.getByRole("button", { name: "页面操作", exact: true }).tap();
    const menu = page.getByRole("menu", { name: "页面操作", exact: true });
    const refresh = menu.getByRole("menuitem", { name: "刷新", exact: true });
    await expectTouchTarget(refresh);
    const menuText = await readableText(refresh);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "切换导航", exact: true }).tap();
    const sidebar = page.getByRole("dialog", { name: "导航菜单", exact: true });
    const orders = sidebar.getByRole("link", { name: "订单", exact: true });
    await orders.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.clock.runFor(100);
    await expectTouchTarget(orders);
    const navigationText = await readableText(orders.locator("span"));
    await orders.tap();
    await expect(page).toHaveURL(manifest.origin + "/admin/orders");
    await expect(page.getByRole("searchbox")).toBeVisible();
    await record(page, info, { feature: "compact-controls-enlarged-text", selection, menuText, navigationText });
  });
  for (const [width, height] of [[320, 560], [640, 280]] as const) {
    test(`${width}x${height}, 200% text: every sidebar section scrolls into a usable touch area`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await login(page, manifest);
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      await page.clock.runFor(100);
      const trigger = page.getByRole("button", { name: "切换导航", exact: true });
      await trigger.tap();
      const sidebar = page.getByRole("dialog", { name: "导航菜单", exact: true });
      const targets = [
        sidebar.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "订单", exact: true }),
        sidebar.getByRole("navigation", { name: "网站选择", exact: true }).getByRole("link", { name: "全部网站", exact: true }),
        sidebar.getByRole("navigation", { name: "全局管理", exact: true }).getByRole("link", { name: "运行状态", exact: true }),
        sidebar.getByRole("navigation", { name: "设置导航", exact: true }).getByRole("link", { name: "设置", exact: true }),
        sidebar.getByRole("button", { name: /账户菜单$/, exact: true }),
      ];
      const geometry = [];
      for (const target of targets) {
        await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await page.clock.runFor(100);
        geometry.push(await expectTouchTarget(target));
      }
      await targets.at(-1)!.tap();
      const security = page.getByRole("menuitem", { name: "账户与安全", exact: true });
      await expectTouchTarget(security);
      await page.keyboard.press("Escape");
      await expect(targets.at(-1)!).toBeFocused();
      const close = sidebar.getByRole("button", { name: "关闭导航", exact: true });
      await expectTouchTarget(close);
      await close.tap();
      await expect(trigger).toBeFocused();
      await trigger.tap();
      const orders = targets[0]!;
      await orders.evaluate(element => element.scrollIntoView({ block: "center" }));
      await page.clock.runFor(100);
      await expectTouchTarget(orders);
      await orders.tap();
      await expect(page).toHaveURL(manifest.origin + "/admin/orders");
      await expect(sidebar).toHaveCount(0);
      await record(page, info, { feature: "compact-sidebar-short-enlarged-text", width, height, geometry });
    });
  }
});

test.describe("desktop control density", () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });

  test("mouse controls retain their original component sizes", async ({ page, manifest }, info) => {
    await login(page, manifest);
    const orders = page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "订单", exact: true });
    const sidebarHeight = (await orders.boundingBox())!.height;
    expect(sidebarHeight).toBeCloseTo(32, 1);
    await orders.click();
    await expect(page).toHaveURL(manifest.origin + "/admin/orders");
    const filter = page.getByRole("button", { name: "显示列", exact: true });
    const filterHeight = (await filter.boundingBox())!.height;
    expect(filterHeight).toBeCloseTo(28, 1);
    const appearance = page.getByRole("button", { name: /^外观，当前/ });
    const appearanceHeight = (await appearance.boundingBox())!.height;
    expect(appearanceHeight).toBeCloseTo(32, 1);
    await appearance.click();
    const light = page.getByRole("menuitemradio", { name: "浅色", exact: true });
    await waitForControlAnimations(light);
    const menuHeight = (await light.boundingBox())!.height;
    expect(menuHeight).toBeCloseTo(28, 1);
    await light.click();
    await expect(light).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(appearance).toBeFocused();
    await record(page, info, { feature: "compact-controls-desktop", sidebarHeight, filterHeight, appearanceHeight, menuHeight });
  });
});
