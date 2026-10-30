import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchGap, expectTouchSlot, expectTouchTarget, tapOutsideVisible } from "./touch-targets";

async function centered(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  return expectTouchTarget(target);
}

async function tapMenuItemEdge(page: Page, target: Locator) {
  const geometry = await expectTouchTarget(target);
  expect(geometry.visual.height).toBeCloseTo(40, 1);
  expect(geometry.generated, "menu rows use their own complete touch area").toBe(false);
  const point = { x: geometry.visual.x + geometry.visual.width / 2, y: geometry.visual.y + 1 };
  expect(await target.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit !== null && (hit === element || element.contains(hit));
  }, point)).toBe(true);
  await page.touchscreen.tap(point.x, point.y);
  return { geometry, point };
}

test.describe("compact mobile button visuals and separate touch targets", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 560 }, reducedMotion: "reduce" });

  for (const width of [320, 360, 390, 430]) {
    test(`${width}px: settings page menu rows use compact 40px touch areas`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 560 });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/settings/display");
      const more = page.getByRole("button", { name: "页面操作", exact: true });
      await more.click();
      const actions = page.getByRole("menu", { name: "页面操作", exact: true });
      const wizard = actions.getByRole("menuitem", { name: "配置向导", exact: true });
      const refresh = actions.getByRole("menuitem", { name: "刷新", exact: true });
      await expect(refresh).toBeEnabled();
      await expect.poll(() => actions.evaluate(element => element.scrollTop)).toBe(0);

      const wizardGeometry = await expectTouchTarget(wizard);
      const refreshGeometry = await expectTouchTarget(refresh);
      for (const geometry of [wizardGeometry, refreshGeometry]) {
        expect(geometry.visual.height).toBeCloseTo(40, 1);
        expect(geometry.generated).toBe(false);
      }
      expect(refreshGeometry.y).toBeGreaterThanOrEqual(wizardGeometry.y + wizardGeometry.height - .5);

      const response = page.waitForResponse(response => response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/admin/v1/settings");
      const refreshTap = await tapMenuItemEdge(page, refresh);
      await response;
      await expect(actions).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.click();
      await expect(refresh).toBeEnabled();
      await expect(actions).toBeVisible();
      await expect(page).toHaveURL(manifest.origin + "/admin/settings/display");
      await record(page, info, { evidence: "browser touch viewport", buttonScale: { requestedWidth: width, wizardGeometry, refreshGeometry, refreshTap } });

      const wizardTap = await tapMenuItemEdge(page, wizard);
      await expect(page.locator("[data-onboarding-workspace]")).toBeVisible();
      await expect(actions).toHaveCount(0);
      await info.attach("settings-wizard-edge-tap", { body: Buffer.from(JSON.stringify(wizardTap, null, 2)), contentType: "application/json" });
    });

    test(`${width}px: toolbar, display controls and checkout use compact visuals with 40px touch slots`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 560 });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/orders");
      const search = page.getByRole("button", { name: "搜索", exact: true });
      const keyword = page.getByRole("searchbox");
      const mode = page.getByRole("button", { name: "查询方式：关键词", exact: true });
      const filter = page.getByRole("button", { name: "筛选与排序", exact: true });
      const more = page.getByRole("button", { name: "更多订单操作", exact: true });
      await expect(search).toBeVisible();
      const searchGeometry = await expectTouchSlot(search);
      const filterGeometry = await expectTouchSlot(filter);
      const moreGeometry = await expectTouchSlot(more);
      expect(searchGeometry.visual.height).toBeCloseTo(36, 1);
      expect(filterGeometry.visual.height).toBeCloseTo(32, 1);
      expect(moreGeometry.visual.height).toBeCloseTo(32, 1);
      expect(moreGeometry.visual.width).toBeCloseTo(32, 1);
      await expectTouchGap(filter, more, "horizontal");

      // The input-group action retains its own layout space beside the editable input.
      const modeGeometry = await expectTouchTarget(mode);
      expect(modeGeometry.visual.height).toBeCloseTo(40, 1);
      const inputBox = (await keyword.boundingBox())!;
      const inputPoint = { x: inputBox.x + 3, y: inputBox.y + inputBox.height / 2 };
      expect(await keyword.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, inputPoint)).toBe(true);
      // Chromium can retarget touches within a few pixels of an adjacent
      // button, including with the original 44px visuals. Tap the text inset.
      const inputTapPoint = { ...inputPoint, x: inputBox.x + 12 };
      await page.touchscreen.tap(inputTapPoint.x, inputTapPoint.y);
      await expect(keyword).toBeFocused();
      const modePoint = { x: modeGeometry.visual.x + modeGeometry.visual.width - 1, y: modeGeometry.visual.y + modeGeometry.visual.height / 2 };
      await page.touchscreen.tap(modePoint.x, modePoint.y);
      await expect(page.getByRole("menuitemradio", { name: "关键词", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      const filterTap = await tapOutsideVisible(page, filter, "top");
      const filters = page.getByRole("dialog", { name: "筛选与排序", exact: true });
      await expect(filters).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      const filterClose = filters.getByRole("button", { name: "关闭对话框", exact: true });
      expect((await expectTouchTarget(filterClose)).visual.height).toBeCloseTo(32, 1);
      await tapOutsideVisible(page, filterClose, "left");
      await expect(filters).toHaveCount(0);
      await expect(filter).toBeFocused();

      const moreTap = await tapOutsideVisible(page, more, "bottom");
      await expect(page.getByRole("menuitem", { name: "导出 CSV", exact: true })).toBeVisible();
      await expect(filters).toHaveCount(0);
      await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
      const display = page.getByRole("dialog", { name: "列表显示", exact: true });
      const density = display.getByRole("group", { name: "列表密度", exact: true });
      const compact = density.getByRole("button", { name: "紧凑", exact: true });
      const comfortable = density.getByRole("button", { name: "舒适", exact: true });
      const compactGeometry = await centered(compact, page);
      const comfortableGeometry = await expectTouchTarget(comfortable);
      expect(compactGeometry.visual.height).toBeCloseTo(32, 1);
      expect(comfortableGeometry.visual.height).toBeCloseTo(32, 1);
      await expectTouchGap(compact, comfortable, "horizontal");
      await tapOutsideVisible(page, comfortable, "top");
      await expect(comfortable).toHaveAttribute("aria-pressed", "true");
      await expect(compact).toHaveAttribute("aria-pressed", "false");
      await tapOutsideVisible(page, compact, "bottom");
      await expect(compact).toHaveAttribute("aria-pressed", "true");
      await expect(comfortable).toHaveAttribute("aria-pressed", "false");
      const done = display.getByRole("button", { name: "完成", exact: true });
      const doneGeometry = await centered(done, page);
      expect(doneGeometry.visual.height).toBeCloseTo(36, 1);
      await done.click();
      await expect(display).toHaveCount(0);
      await expect(more).toBeFocused();

      await keyword.fill("轻账");
      await search.click();
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("轻账");
      await record(page, info, { evidence: "browser touch viewport", buttonScale: { requestedWidth: width, searchGeometry, filterTap, moreTap, modeGeometry, compactGeometry, comfortableGeometry, doneGeometry } });

      await page.goto(manifest.origin + manifest.checkouts.open!);
      await expect(page.locator("[data-qr-image]")).toBeVisible();
      const query = page.getByRole("button", { name: "查询付款状态", exact: true });
      const enlarge = page.getByRole("button", { name: "放大二维码", exact: true });
      const save = page.getByRole("button", { name: "保存二维码", exact: true });
      const queryGeometry = await expectTouchSlot(query);
      const enlargeGeometry = await expectTouchSlot(enlarge);
      const saveGeometry = await expectTouchSlot(save);
      expect(queryGeometry.visual.height).toBeCloseTo(36, 1);
      expect(enlargeGeometry.visual.height).toBeCloseTo(32, 1);
      expect(saveGeometry.visual.height).toBeCloseTo(32, 1);
      expect(queryGeometry.y + queryGeometry.height).toBeLessThanOrEqual(560);
      await expectTouchGap(enlarge, save, "horizontal");
      const download = page.waitForEvent("download");
      const saveTap = await tapOutsideVisible(page, save, "bottom");
      await download;
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const enlargeTap = await tapOutsideVisible(page, enlarge, "top");
      const qr = page.getByRole("dialog", { name: "支付宝付款二维码", exact: true });
      await expect(qr).toBeVisible();
      const qrClose = qr.getByRole("button", { name: "关闭对话框", exact: true });
      const closeTap = await tapOutsideVisible(page, qrClose, "left");
      await expect(qr).toHaveCount(0);
      await expect(enlarge).toBeFocused();
      await record(page, info, { evidence: "browser touch viewport", buttonScale: { requestedWidth: width, queryGeometry, enlargeTap, saveTap, closeTap } });
    });
  }

  test("joined choices keep their touch regions inside each horizontal slot", async ({ page, manifest }, info) => {
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/settings/display");
    const group = page.getByRole("group", { name: "首页图表样式", exact: true });
    const choices = ["面积图", "柱状图", "折线图"].map(name => group.getByRole("button", { name, exact: true }));
    const geometry = [];
    for (const choice of choices) {
      const target = await expectTouchTarget(choice);
      expect(target.visual.height).toBeCloseTo(40, 1);
      expect(target.x).toBeCloseTo(target.visual.x, 1);
      expect(target.width).toBeCloseTo(target.visual.width, 1);
      for (const x of [target.visual.x + 2, target.visual.x + target.visual.width - 2]) {
        expect(await choice.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || element.contains(hit);
        }, { x, y: target.visual.y + target.visual.height / 2 })).toBe(true);
      }
      geometry.push(target);
    }
    await choices[1]!.tap();
    await expect(choices[1]!).toHaveAttribute("aria-pressed", "true");
    await expect(choices[0]!).toHaveAttribute("aria-pressed", "false");
    await choices[0]!.tap();
    await expect(choices[0]!).toHaveAttribute("aria-pressed", "true");
    await record(page, info, { evidence: "browser touch viewport", joinedChoices: geometry });
  });

  test("the first technical-detail copy action retains its full touch target at the scroll start", async ({ page, manifest }, info) => {
    // The retired global secret dialog is no longer reachable. Exercise the
    // same shared CopyValue control in a real synthetic ledger detail dialog.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
        (window as Window & { __copiedText?: string }).__copiedText = value;
      } } });
    });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin" + manifest.details.ledgerAssociated);
    const view = page.getByRole("button", { name: "更多操作，支付宝流水记录操作", exact: true });
    await view.click();
    await page.getByRole("menuitem", { name: "技术详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "技术详情", exact: true });
    const body = dialog.locator("[data-admin-dialog-scroll]");
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
    const copy = dialog.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true });
    await expect(dialog.getByRole("heading", { name: "技术详情", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused();
    await copy.hover();
    await page.clock.runFor(200);
    const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: /^复制内部流水编号（PerPay）$/ });
    await expect(tooltip).toBeVisible();
    const copyGeometry = await expectTouchSlot(copy);
    const tooltipBounds = (await tooltip.boundingBox())!;
    const overlapWidth = Math.min(copyGeometry.x + copyGeometry.width, tooltipBounds.x + tooltipBounds.width) - Math.max(copyGeometry.x, tooltipBounds.x);
    const overlapHeight = Math.min(copyGeometry.y + copyGeometry.height, tooltipBounds.y + tooltipBounds.height) - Math.max(copyGeometry.y, tooltipBounds.y);
    expect(overlapWidth <= 0 || overlapHeight <= 0, "the open tooltip stays outside the complete 40px copy touch target").toBe(true);
    expect(copyGeometry.visual.height).toBeCloseTo(32, 1);
    const bodyBox = (await body.boundingBox())!;
    expect(copyGeometry.y).toBeGreaterThanOrEqual(bodyBox.y);
    const copyTap = await tapOutsideVisible(page, copy, "top");
    await expect(dialog.getByRole("status").filter({ hasText: "已复制" })).toHaveText("已复制");
    expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(manifest.details.ledgerAssociated!.split("/").at(-1));
    await record(page, info, { evidence: "real ledger technical dialog with synthetic domain data and clipboard", buttonScale: { copyGeometry, copyTap, tooltipBounds } });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(view).toBeFocused();
  });

  test("200% text retains complete scrollable touch targets without fixed visual-size assertions", async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: 320, height: 560 });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/orders");
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await page.clock.runFor(100);
    const more = page.getByRole("button", { name: "更多订单操作", exact: true });
    await more.click();
    await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
    const display = page.getByRole("dialog", { name: "列表显示", exact: true });
    const density = await centered(display.getByRole("button", { name: "舒适", exact: true }), page);
    const close = await expectTouchTarget(display.getByRole("button", { name: "关闭对话框", exact: true }));
    const done = display.getByRole("button", { name: "完成", exact: true });
    const completion = await centered(done, page);
    await info.attach("enlarged-text-touch-targets", { body: Buffer.from(JSON.stringify({ density, close, completion }, null, 2)), contentType: "application/json" });
    await done.click();
    await expect(display).toHaveCount(0);
    await expect(more).toBeFocused();
  });
});
