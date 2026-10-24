import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

type VisibleArea = { width: number; height: number; left: number; top: number };
const panned: VisibleArea = { width: 280, height: 260, left: 24, top: 32 };

/** Synthetic geometry only: this does not stand in for Android IME or pinch testing. */
async function visibleArea(page: Page, area: VisibleArea) {
  await page.evaluate(area => {
    const viewport = window.visualViewport!;
    for (const [key, value] of Object.entries({
      width: area.width, height: area.height,
      offsetLeft: area.left, offsetTop: area.top,
    })) Object.defineProperty(viewport, key, { configurable: true, value });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  }, area);
  await page.clock.runFor(100);
}

async function reachable(target: Locator) {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect(), viewport = window.visualViewport!;
    const points = [.25, .5, .75].flatMap(x => [.25, .5, .75].map(y => {
      const hit = document.elementFromPoint(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
      return hit !== null && (hit === element || element.contains(hit));
    }));
    return {
      width: bounds.width, height: bounds.height,
      fits: bounds.left >= viewport.offsetLeft - 1 && bounds.top >= viewport.offsetTop - 1 &&
        bounds.right <= viewport.offsetLeft + viewport.width + 1 &&
        bounds.bottom <= viewport.offsetTop + viewport.height + 1,
      hits: points.every(Boolean),
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.fits, "entire target is inside the synthetic visible browser area").toBe(true);
  expect(geometry.hits, "nine interior points hit the control or its children").toBe(true);
  return geometry;
}

async function scrollTo(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
  await page.clock.runFor(50);
  return reachable(target);
}

test.describe("mobile overlay regression with synthetic visible viewport", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 560 }, reducedMotion: "reduce" });

  test("navigation and page actions sheets keep hit-tested close controls in a panned viewport", async ({ page, manifest }, info) => {
    await login(page, manifest);
    const navigation = page.getByRole("button", { name: "切换导航", exact: true });
    await navigation.click();
    const menu = page.getByRole("dialog", { name: "导航菜单", exact: true });
    await expect(menu).toBeVisible();
    await visibleArea(page, panned);
    const closeNavigation = menu.getByRole("button", { name: "关闭导航", exact: true });
    const navigationClose = await reachable(closeNavigation);
    await closeNavigation.click();
    await expect(navigation).toBeFocused();

    const more = page.getByRole("button", { name: "页面操作", exact: true });
    await more.click();
    const actions = page.getByRole("dialog", { name: "页面操作", exact: true });
    const close = actions.getByRole("button", { name: "关闭对话框", exact: true });
    const actionsClose = await reachable(close);
    const refresh = actions.getByRole("button", { name: "刷新", exact: true });
    await expect(refresh).toHaveText("刷新");
    await scrollTo(actions.getByRole("button", { name: /外观，当前/ }), page);
    await reachable(close);
    await record(page, info, { evidence: "browser synthetic visualViewport", area: panned, navigationClose, actionsClose });
    await close.click();
    await expect(more).toBeFocused();
    await expect(actions).toHaveCount(0);
  });

  test("enlarged checkout QR keeps its 44px close usable after body scrolling", async ({ page, manifest }, info) => {
    await page.goto(manifest.origin + manifest.checkouts.open!);
    const trigger = page.getByRole("button", { name: "放大二维码", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "支付宝付款二维码", exact: true });
    await expect(dialog).toBeVisible();
    await visibleArea(page, panned);
    const close = dialog.getByRole("button", { name: "关闭对话框", exact: true });
    const before = await reachable(close);
    const body = dialog.locator("[data-qr-dialog-body]");
    await body.evaluate(element => element.scrollTop = element.scrollHeight);
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await reachable(close);
    await record(page, info, { evidence: "browser synthetic visualViewport", area: panned, before, after });
    await close.click();
    await expect(trigger).toBeFocused();
  });

  test("administrator confirmation keeps its explanation scrollable and both actions reachable", async ({ page, manifest }, info) => {
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/settings/security");
    const rules = page.getByRole("textbox", { name: "允许的 IP / 网段", exact: true });
    await rules.fill(Array.from({ length: 30 }, (_, index) => `192.0.2.${index + 1}`).join("\n"));
    const save = page.getByRole("button", { name: "保存白名单", exact: true });
    await save.click();
    const dialog = page.getByRole("dialog", { name: "确认保存访问规则？", exact: true });
    await expect(dialog).toBeVisible();
    const small = { ...panned, height: 220 };
    await visibleArea(page, small);
    const close = dialog.getByRole("button", { name: "关闭对话框", exact: true });
    const closeGeometry = await reachable(close);
    const explanation = dialog.locator("[data-admin-dialog-body]");
    await expect(explanation).toHaveText(/保存后立即生效/);
    await explanation.evaluate(element => element.scrollTop = element.scrollHeight);
    const confirmGeometry = await scrollTo(dialog.getByRole("button", { name: "确认保存", exact: true }), page);
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const cancelGeometry = await scrollTo(cancel, page);
    await record(page, info, { evidence: "browser synthetic visualViewport", area: small, closeGeometry, confirmGeometry, cancelGeometry });
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(save).toBeFocused();
    await expect(rules).toHaveValue(/192\.0\.2\.30/);
  });

  test("dirty navigation alert keeps both decisions reachable and restores the category focus", async ({ page, manifest }, info) => {
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/settings/display");
    const name = page.getByRole("textbox", { name: "支付系统名称", exact: true });
    await name.fill("保留的手机草稿");
    const category = page.getByRole("combobox", { name: "设置分类", exact: true });
    await category.click();
    await page.getByRole("option", { name: "查账设置", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await expect(dialog).toBeVisible();
    const small = { ...panned, height: 220 };
    await visibleArea(page, small);
    const discardGeometry = await scrollTo(dialog.getByRole("button", { name: "放弃修改并继续", exact: true }), page);
    const stay = dialog.getByRole("button", { name: "继续编辑", exact: true });
    const stayGeometry = await scrollTo(stay, page);
    await record(page, info, { evidence: "browser synthetic visualViewport", area: small, discardGeometry, stayGeometry });
    await stay.click();
    await expect(dialog).toHaveCount(0);
    await expect(category).toBeFocused();
    await expect(name).toHaveValue("保留的手机草稿");
    expect(new URL(page.url()).pathname).toBe("/admin/settings/display");
  });

  test("trend tab text stays on one line and each view remains reachable at 320 and 360px", async ({ page, manifest }, info) => {
    await login(page, manifest);
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 560 });
      await page.goto(manifest.origin + "/admin/");
      const tabs = page.getByRole("tablist", { name: "收款趋势视图", exact: true });
      await expect(tabs).toBeVisible();
      const geometry = await tabs.getByRole("tab").evaluateAll(elements => elements.map(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        return { text: element.textContent, lines: new Set(lines.map(rect => Math.round(rect.y))).size };
      }));
      expect(geometry).toHaveLength(2);
      expect(geometry.every(tab => tab.lines === 1), "tab text occupies exactly one rendered line").toBe(true);
      const daily = tabs.getByRole("tab", { name: "每日数据", exact: true });
      await daily.click();
      await expect(daily).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("region", { name: "每日数据", exact: true })).toBeVisible();
      const chart = tabs.getByRole("tab", { name: "图表", exact: true });
      await chart.click();
      await expect(chart).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[data-slot="chart"]')).toBeVisible();
      await record(page, info, { evidence: "browser touch viewport", width, trendTabs: geometry });
    }
  });
});
