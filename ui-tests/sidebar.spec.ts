import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

async function iconRailGeometry(rail: Locator) {
  return rail.evaluate(rail => {
    const measure = (button: Element) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      return { label: button.getAttribute("aria-label") ?? button.textContent?.trim(),
        width: bounds.width, height: bounds.height, centerX: bounds.left + bounds.width / 2,
        iconWidth: icon.width, iconHeight: icon.height, iconCenterX: icon.left + icon.width / 2,
        iconOffsetX: icon.left + icon.width / 2 - bounds.left - bounds.width / 2,
        iconOffsetY: icon.top + icon.height / 2 - bounds.top - bounds.height / 2,
      };
    };
    const workspace = rail.querySelector('nav[aria-label="网站选择"] button[aria-label^="切换业务网站"]')!;
    const navigation = [...rail.querySelectorAll('nav[aria-label="主导航"] a')];
    const globalWebsites = rail.querySelector('nav[aria-label="全局管理"] a[aria-label="业务网站"]')!;
    return { workspace: measure(workspace), targets: [...navigation, globalWebsites].map(measure) };
  });
}

async function expectAlignedIcons(rail: Locator) {
  await expect.poll(async () => {
    const { workspace, targets } = await iconRailGeometry(rail);
    return targets.length === 5 && Math.abs(workspace.iconOffsetX) < 0.5 && Math.abs(workspace.iconOffsetY) < 0.5 &&
      targets.every(target => Math.abs(target.iconCenterX - workspace.iconCenterX) < 0.5 &&
        Math.abs(target.centerX - workspace.centerX) < 0.5 &&
        Math.abs(target.width - workspace.width) < 0.5 && Math.abs(target.height - workspace.height) < 0.5 &&
        Math.abs(target.iconOffsetX) < 0.5 && Math.abs(target.iconOffsetY) < 0.5);
  }, { message: "the website switcher, main navigation and global websites use centered, aligned icon buttons" }).toBe(true);
  const geometry = await iconRailGeometry(rail);
  expect(geometry.workspace.width).toBe(32);
  expect(geometry.workspace.height).toBe(32);
  expect(geometry.workspace.iconWidth).toBe(16);
  expect(geometry.workspace.iconHeight).toBe(16);
  expect(geometry.targets.map(target => target.label)).toEqual(["总览", "订单", "待处理", "通知", "业务网站"]);
  return geometry;
}

test("icon rail keeps navigation, website scope and account actions reachable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
    await page.goto(manifest.origin + "/admin/");
    if (await page.locator('[data-slot="sidebar"]').getAttribute("data-state") !== "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
    const rail = page.locator('[data-slot="sidebar"][data-collapsible="icon"]');
    await expect(rail).toBeVisible();
    const container = rail.locator('[data-slot="sidebar-container"]');
    await expect.poll(async () => (await container.boundingBox())!.width).toBeLessThanOrEqual(66);
    const geometry = await expectAlignedIcons(rail);
    const trigger = page.getByRole("button", { name: /切换业务网站/ });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "业务网站" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    const sitePath = manifest.routes.find(route => /^\/sites\/[^/]+\/orders$/.test(route))!.replace(/\/orders$/, "");
    const choice = page.locator(`[data-slot="popover-content"] a[href$="${sitePath}"]`);
    await choice.click();
    await expect(page).toHaveURL(new RegExp(sitePath + "[?#]?$"));
    const selectedGeometry = await expectAlignedIcons(rail);
    await page.getByRole("button", { name: "账户菜单", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "账户与安全" })).toBeVisible();
    await page.keyboard.press("Escape");
    await record(page, info, { theme, geometry, selectedGeometry });
  }
});
