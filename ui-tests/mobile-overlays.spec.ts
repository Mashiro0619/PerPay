import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

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
  return expectTouchTarget(target);
}

async function scrollTo(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
  await page.clock.runFor(50);
  return reachable(target);
}

test.describe("mobile overlay regression with synthetic visible viewport", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 560 }, reducedMotion: "reduce" });

  for (const [width, height, font] of [[640, 280, 150], [640, 280, 200], [320, 560, 200], [360, 560, 100]] as const) {
    test(`list display remains operable at ${width}x${height} and ${font}% text`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/orders");
      await expect(page.getByRole("searchbox")).toBeVisible();
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      await page.clock.runFor(200);
      const pageWidthBefore = await page.evaluate(() => document.documentElement.scrollWidth);
      const more = page.getByRole("button", { name: "更多订单操作", exact: true });
      await more.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await page.clock.runFor(100);
      await more.click();
      await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
      const display = page.getByRole("dialog", { name: "列表显示", exact: true });
      await expect(display).toBeVisible();
      const close = display.getByRole("button", { name: "关闭对话框", exact: true });
      const scrollControl = async (target: Locator) => {
        await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await page.clock.runFor(200);
        // Capture a rendered frame after focus can pan the mobile viewport.
        await page.screenshot();
        await page.clock.runFor(100);
        const geometry = await reachable(target);
        const closeGeometry = await reachable(close);
        const boundary = await display.locator("[data-list-display-scroll]").boundingBox();
        const closeToContent = boundary!.y - closeGeometry.y - closeGeometry.height;
        expect(closeToContent, "the complete close target keeps 8px before the adjacent content scroller").toBeGreaterThanOrEqual(7.5);
        const closeToControl = geometry.y - closeGeometry.y - closeGeometry.height;
        expect(closeToControl, "the revealed content target remains separate from the close target").toBeGreaterThanOrEqual(7.5);
        expect(await display.evaluate(element => element.scrollTop), "focus scrolling stays in the content region").toBe(0);
        return { ...geometry, closeToContent, closeToControl };
      };

      const comfortable = display.getByRole("button", { name: "舒适", exact: true });
      const density = await scrollControl(comfortable);
      await comfortable.click();
      await expect(comfortable).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(() => localStorage.getItem("perpay:list-density"))).toBe("comfortable");

      const received = display.getByRole("checkbox", { name: "实收金额", exact: true });
      await expect(received).toBeChecked();
      const receivedLabel = display.locator('[data-slot="field-label"]').filter({ hasText: /^实收金额$/ });
      const field = await scrollControl(receivedLabel);
      // Tap the measured label without auto-scrolling its associated hidden input again.
      const fieldBox = (await receivedLabel.boundingBox())!;
      await page.touchscreen.tap(fieldBox.x + fieldBox.width / 2, fieldBox.y + fieldBox.height / 2);
      await expect(received).not.toBeChecked();
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("perpay.table-columns.v2.orders") ?? "{}").received_amount_cents)).toBe(false);

      const reset = display.getByRole("button", { name: "恢复默认列", exact: true });
      const resetGeometry = await scrollControl(reset);
      await reset.click();
      await expect(received).toBeChecked();
      await expect.poll(() => page.evaluate(() => localStorage.getItem("perpay.table-columns.v2.orders"))).toBe("{}");

      const done = display.getByRole("button", { name: "完成", exact: true });
      const doneGeometry = await scrollControl(done);
      const displayBounds = (await display.boundingBox())!;
      const doneBottomSpace = displayBounds.y + displayBounds.height - doneGeometry.y - doneGeometry.height;
      expect(doneBottomSpace, "the final action's entire touch extension keeps 8px inside the popup edge").toBeGreaterThanOrEqual(7.5);
      const layout = await display.evaluate(element => {
        const scroll = element.querySelector<HTMLElement>("[data-list-display-scroll]")!;
        return {
          viewport: { width: visualViewport!.width, height: visualViewport!.height },
          popup: { width: element.clientWidth, scrollWidth: element.scrollWidth },
          scroll: { width: scroll.clientWidth, scrollWidth: scroll.scrollWidth, height: scroll.clientHeight },
          pageWidth: document.documentElement.scrollWidth,
        };
      });
      expect(layout.scroll.height).toBeGreaterThanOrEqual(64);
      expect(layout.scroll.scrollWidth).toBeLessThanOrEqual(layout.scroll.width + 1);
      expect(layout.popup.scrollWidth).toBeLessThanOrEqual(layout.popup.width + 1);
      expect(layout.pageWidth).toBeLessThanOrEqual(pageWidthBefore + 1);
      await info.attach("list-display-geometry", {
        body: Buffer.from(JSON.stringify({ evidence: "browser touch viewport with enlarged text", width, height, font, pageWidthBefore, layout, density, field, resetGeometry, doneGeometry, doneBottomSpace }, null, 2)),
        contentType: "application/json",
      });
      await info.attach(`list-display-${width}-${height}-${font}`, { body: await page.screenshot(), contentType: "image/png" });
      await done.click();
      await expect(display).toHaveCount(0);
      await expect(more).toBeFocused();

      await more.click();
      await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
      await scrollControl(display.getByRole("button", { name: "舒适", exact: true }));
      await close.click();
      await expect(display).toHaveCount(0);
      await expect(more).toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem("perpay:list-density"))).toBe("comfortable");
    });
  }

  test("navigation close and page action menus remain reachable in a panned viewport", async ({ page, manifest }, info) => {
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
    const actions = page.getByRole("menu", { name: "页面操作", exact: true });
    const refresh = actions.getByRole("menuitem", { name: "刷新", exact: true });
    await expect(refresh).toHaveText("刷新");
    const refreshTarget = await scrollTo(refresh, page);
    const appearanceTrigger = actions.getByRole("menuitem", { name: /^外观/ });
    const appearance = await scrollTo(appearanceTrigger, page);
    await appearanceTrigger.click();
    const system = page.getByRole("menuitemradio", { name: "跟随系统", exact: true });
    const systemTarget = await scrollTo(system, page);
    await record(page, info, { evidence: "browser synthetic visualViewport", area: panned, navigationClose, refreshTarget, appearance, systemTarget });
    await page.keyboard.press("Escape");
    await expect(system).toHaveCount(0);
    await expect(actions).toBeVisible();
    await expect(appearanceTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await expect(actions).toHaveCount(0);
  });

  test("enlarged checkout QR keeps its complete close target usable after body scrolling", async ({ page, manifest }, info) => {
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
    await expect(explanation).toHaveText(/保存立即生效/);
    const scroll = dialog.locator("[data-admin-dialog-scroll]");
    await expect.poll(() => scroll.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(64);
    await scroll.evaluate(element => element.scrollTop = element.scrollHeight);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
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
