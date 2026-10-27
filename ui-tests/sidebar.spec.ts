import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

async function iconRailGeometry(rail: Locator) {
  return rail.evaluate(rail => {
    const measure = (button: Element) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      return { label: button.getAttribute("aria-label") ?? button.textContent?.trim(),
        width: bounds.width, height: bounds.height, top: bounds.top, bottom: bounds.bottom,
        centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2,
        iconWidth: icon.width, iconHeight: icon.height, iconCenterX: icon.left + icon.width / 2,
        iconCenterY: icon.top + icon.height / 2,
        iconOffsetX: icon.left + icon.width / 2 - bounds.left - bounds.width / 2,
        iconOffsetY: icon.top + icon.height / 2 - bounds.top - bounds.height / 2,
      };
    };
    const workspace = rail.querySelector('nav[aria-label="网站选择"] button[aria-label^="切换业务网站"]')!;
    const navigation = [...rail.querySelectorAll('nav[aria-label="主导航"] a')];
    const globalWebsites = rail.querySelector('nav[aria-label="全局管理"] a[aria-label="业务网站"]')!;
    const sequence = [...navigation, workspace].map(measure);
    const verticalSpacing = sequence.slice(1).map((button, index) => ({
      from: sequence[index]!.label, to: button.label,
      gap: button.top - sequence[index]!.bottom,
      centerStep: button.iconCenterY - sequence[index]!.iconCenterY,
    }));
    const content = getComputedStyle(rail.querySelector('[data-slot="sidebar-content"]')!);
    const groupPadding = ["主导航", "网站选择"].map(label => {
      const style = getComputedStyle(rail.querySelector('nav[aria-label="' + label + '"] [data-slot="sidebar-group"]')!);
      return { label, top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) };
    });
    return { workspace: measure(workspace), targets: [...navigation, globalWebsites].map(measure),
      sequence, verticalSpacing, groupPadding,
      content: { gap: parseFloat(content.gap), top: parseFloat(content.paddingTop), bottom: parseFloat(content.paddingBottom) },
    };
  });
}

async function expectAlignedIcons(rail: Locator) {
  await expect.poll(async () => {
    const { workspace, targets, verticalSpacing } = await iconRailGeometry(rail);
    return targets.length === 5 && Math.abs(workspace.iconOffsetX) < 0.5 && Math.abs(workspace.iconOffsetY) < 0.5 &&
      targets.every(target => Math.abs(target.iconCenterX - workspace.iconCenterX) < 0.5 &&
        Math.abs(target.centerX - workspace.centerX) < 0.5 &&
        Math.abs(target.width - workspace.width) < 0.5 && Math.abs(target.height - workspace.height) < 0.5 &&
        Math.abs(target.iconOffsetX) < 0.5 && Math.abs(target.iconOffsetY) < 0.5) &&
      verticalSpacing.length === 4 && verticalSpacing.every(spacing => Math.abs(spacing.gap - 4) < 0.5 && Math.abs(spacing.centerStep - 36) < 0.5);
  }, { message: "rail icons align horizontally and navigation continues into the website switcher with a uniform 4px gap" }).toBe(true);
  const geometry = await iconRailGeometry(rail);
  expect(geometry.workspace.width).toBe(32);
  expect(geometry.workspace.height).toBe(32);
  expect(geometry.workspace.iconWidth).toBe(16);
  expect(geometry.workspace.iconHeight).toBe(16);
  expect(geometry.targets.map(target => target.label)).toEqual(["总览", "订单", "待处理", "通知", "业务网站"]);
  expect(geometry.sequence).toHaveLength(5);
  expect(geometry.content).toEqual({ gap: 4, top: 8, bottom: 8 });
  expect(geometry.groupPadding).toEqual([{ label: "主导航", top: 0, bottom: 0 }, { label: "网站选择", top: 0, bottom: 0 }]);
  return geometry;
}

test("icon rail keeps navigation, website scope and account actions reachable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
    await page.goto(manifest.origin + "/admin/");
    const sidebar = page.locator('[data-slot="sidebar"]');
    if (await sidebar.getAttribute("data-state") === "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    const expandedGeometry = await sidebar.evaluate(sidebar => {
      const content = getComputedStyle(sidebar.querySelector('[data-slot="sidebar-content"]')!);
      const groups = ["主导航", "网站选择"].map(label => {
        const style = getComputedStyle(sidebar.querySelector('nav[aria-label="' + label + '"] [data-slot="sidebar-group"]')!);
        return { label, top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom),
          left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
      });
      return { groups, content: { gap: parseFloat(content.gap), top: parseFloat(content.paddingTop), bottom: parseFloat(content.paddingBottom) } };
    });
    expect(expandedGeometry.groups).toEqual([
      { label: "主导航", top: 8, bottom: 8, left: 8, right: 8 },
      { label: "网站选择", top: 8, bottom: 8, left: 8, right: 8 },
    ]);
    expect(expandedGeometry.content).toEqual({ gap: 0, top: 0, bottom: 0 });
    await page.getByRole("button", { name: "切换导航", exact: true }).click();
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
    await page.getByRole("button", { name: /账户菜单$/, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "账户与安全" })).toBeVisible();
    await page.keyboard.press("Escape");
    await record(page, info, { theme, expandedGeometry, geometry, selectedGeometry });
  }
});
