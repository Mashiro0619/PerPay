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

  for (const width of [320, 423]) {
    test(`${width}px: search addon icons retain padding and a separate editable input`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 839 });
      await login(page, manifest);
      const measurements = [];
      for (const path of ["/orders", "/reconciliation", "/notifications"]) {
        await page.goto(manifest.origin + "/admin" + path);
        const input = page.getByRole("searchbox");
        await expect(input).toBeVisible();
        const group = input.locator('xpath=..');
        const addon = group.locator('[data-slot="input-group-addon"]');
        const icons = addon.locator("svg");
        await expect(icons).toHaveCount(path === "/notifications" ? 1 : 2);
        const geometry = await group.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const input = element.querySelector("input")!.getBoundingClientRect();
          const button = element.querySelector('[data-slot="input-group-addon"] button')?.getBoundingClientRect();
          const icons = [...element.querySelectorAll('[data-slot="input-group-addon"] svg')].map(icon => {
            const box = icon.getBoundingClientRect();
            return { left: box.left, right: box.right, centerY: box.top + box.height / 2 };
          });
          return { left: bounds.left, centerY: bounds.top + bounds.height / 2, inputLeft: input.left,
            button: button ? { left: button.left, right: button.right } : null, icons };
        });
        expect(geometry.icons[0]!.left - geometry.left, "the leading icon retains visible inset from the input border").toBeGreaterThanOrEqual(6);
        for (const icon of geometry.icons) {
          if (geometry.button) {
            expect(icon.left, "both icons remain inside the query-mode button").toBeGreaterThanOrEqual(geometry.button.left);
            expect(icon.right).toBeLessThanOrEqual(geometry.button.right);
          }
          expect(icon.right, "icons stay within the addon rather than entering the editable input").toBeLessThanOrEqual(geometry.inputLeft + 1);
          expect(Math.abs(icon.centerY - geometry.centerY), "icons remain vertically centered").toBeLessThanOrEqual(1);
        }
        const inputBox = (await input.boundingBox())!;
        await page.touchscreen.tap(inputBox.x + 12, inputBox.y + inputBox.height / 2);
        await expect(input).toBeFocused();
        if (path !== "/notifications") {
          const mode = page.getByRole("button", { name: "查询方式：关键词", exact: true });
          await expectTouchTarget(mode);
          await mode.tap();
          await expect(page.getByRole("menuitemradio", { name: "关键词", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
        }
        measurements.push({ path, ...geometry });
      }
      await record(page, info, { evidence: "browser touch viewport", searchAddons: measurements });
    });
  }

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

      await keyword.fill("桌面软件");
      await search.click();
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("桌面软件");
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

  test("overview chart type menu keeps its trigger and choices independently tappable", async ({ page, manifest }, info) => {
    await login(page, manifest);
    const trigger = page.getByRole("button", { name: /^图表类型：/ });
    await expect(trigger).toBeVisible();
    // The controls precede their analytics and metric cards. Finish that
    // shared layout before scrolling them into the viewport for hit testing.
    await expect(page.locator(".trend-card")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    await trigger.scrollIntoViewIfNeeded();
    await page.clock.runFor(100);
    const triggerGeometry = await expectTouchTarget(trigger);
    const geometry = [];
    for (const name of ["面积图", "柱状图", "折线图"]) {
      await trigger.tap();
      const choice = page.getByRole("menuitemradio", { name, exact: true });
      const target = await expectTouchTarget(choice, { hitTest: false });
      expect([1, 3, 4, 5, 7].every(index => target.points[index]!.hit), "the button center and four edge midpoints belong to that control").toBe(true);
      expect(target.x).toBeGreaterThanOrEqual(target.slot.x - .5);
      expect(target.x + target.width).toBeLessThanOrEqual(target.slot.x + target.slot.width + .5);
      for (const x of [target.visual.x + 2, target.visual.x + target.visual.width - 2]) {
        expect(await choice.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || element.contains(hit);
        }, { x, y: target.visual.y + target.visual.height / 2 })).toBe(true);
      }
      geometry.push(target);
      await choice.tap();
      await expect(trigger).toHaveAccessibleName("图表类型：" + name);
    }
    await trigger.tap();
    await expect(page.getByRole("menuitemradio", { name: "折线图", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "面积图", exact: true })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("menuitemradio", { name: "面积图", exact: true }).tap();
    await record(page, info, { evidence: "browser touch viewport", triggerGeometry, menuChoices: geometry });
  });

  test("the first technical copy action retains its full touch target in the independent reader", async ({ page, manifest }, info) => {
    // The parent record keeps its geometry while the reader owns the scroll area.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
        (window as Window & { __copiedText?: string }).__copiedText = value;
      } } });
    });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin" + manifest.details.ledgerAssociated);
    await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(manifest.details.ledgerAssociated);
    const sourceUrl = page.url();
    const dialog = page.locator("[data-overlay-content]");
    await expect(dialog.locator('[data-detail-section="transaction"]')).toBeVisible();
    await expect(dialog.getByRole("tablist")).toHaveCount(0);
    const technical = dialog.locator('[data-detail-section="transaction"] [data-ledger-summary] [data-technical-information]');
    const view = technical.locator('button[aria-haspopup="dialog"]');
    await view.scrollIntoViewIfNeeded();
    await view.focus();
    const parentBefore = await dialog.evaluate(element => ({ height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, scrollTop: element.querySelector('[data-overlay-detail]')!.scrollTop }));
    await page.keyboard.press("Enter");
    await expect(view).toHaveAttribute("aria-expanded", "true");
    const reader = page.getByRole("dialog", { name: "流水技术信息", exact: true });
    await expect(reader.locator('pre[aria-label="流水技术信息"]')).toBeVisible();
    const body = reader.locator(":scope > [data-admin-dialog-body]");
    await expect(body).toHaveCSS("overflow-y", "auto");
    await body.evaluate(element => element.scrollTop = 0);
    const sectionStart = await body.evaluate(element => ({
      scrollTop: element.scrollTop,
      bodyTop: element.getBoundingClientRect().top,
    }));
    expect(sectionStart.scrollTop).toBe(0);
    const copy = reader.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true });
    await expect(reader.getByRole("heading", { name: "流水技术信息", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(reader.getByRole("button", { name: "关闭流水技术信息", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused();
    await expect(copy).toHaveAccessibleName("复制内部流水编号（PerPay）");
    await expect(copy).toHaveAttribute("title", "复制内部流水编号（PerPay）");
    await copy.hover();
    await page.clock.runFor(200);
    // The copy action uses its native title; no custom tooltip covers
    // its touch extension. The complete surface is still probed below.
    await expect(page.locator('[data-slot="tooltip-content"]:visible')).toHaveCount(0);
    const copyGeometry = await expectTouchSlot(copy);
    expect(copyGeometry.visual.height).toBeCloseTo(32, 1);
    const bodyBox = (await body.boundingBox())!;
    expect(copyGeometry.y).toBeGreaterThanOrEqual(bodyBox.y);
    expect(await reader.evaluate(element => element.scrollTop), "the reader shell remains stationary while its body scrolls").toBe(0);
    const copyTap = await tapOutsideVisible(page, copy, "top");
    await expect(copy).toBeFocused();
    await expect(reader.getByRole("status").filter({ hasText: "已复制" })).toHaveText("已复制");
    expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(manifest.details.ledgerAssociated!.split("/").at(-1));
    await record(page, info, { evidence: "real ledger overlay with independent technical dialog, synthetic domain data and clipboard", buttonScale: { copyGeometry, copyTap, sectionStart, nativeTitle: true } });
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
    await expect(view).toHaveAttribute("aria-expanded", "false");
    await expect(technical.locator("pre")).toHaveCount(0);
    await expect(view).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    expect(await dialog.evaluate(element => ({ height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, scrollTop: element.querySelector('[data-overlay-detail]')!.scrollTop }))).toEqual(parentBefore);
    await expect(page).toHaveURL(sourceUrl);
  });

  for (const width of [320, 390, 430]) {
    test(`${width}px: short chart, reminder and settings choices keep compact visuals without stretching`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, manifest);
      const card = page.locator(".trend-card");
      const tabs = card.getByRole("tablist", { name: "收款趋势视图", exact: true });
      await expect(tabs).toBeVisible();
      const tabsBox = (await tabs.boundingBox())!;
      expect(tabsBox.height).toBeCloseTo(40, 1);
      expect(tabsBox.width).toBeLessThan(180);
      for (const name of ["图表", "每日数据"]) {
        const target = tabs.getByRole("tab", { name, exact: true });
        expect((await centered(target, page)).visual.height).toBeCloseTo(32, 1);
      }
      await tabs.getByRole("tab", { name: "每日数据", exact: true }).tap();
      await expect(card.getByRole("region", { name: "每日数据", exact: true })).toBeVisible();
      await tabs.getByRole("tab", { name: "图表", exact: true }).tap();
      const types = card.getByRole("button", { name: /^图表类型：/ });
      const typeGeometry = [];
      for (const [name, value] of [["面积图", "AREA"], ["柱状图", "BAR"], ["折线图", "LINE"]] as const) {
        const geometry = await centered(types, page);
        expect(geometry.visual.width).toBeCloseTo(32, 1);
        expect(geometry.visual.height).toBeCloseTo(32, 1);
        typeGeometry.push(geometry);
        await tapOutsideVisible(page, types, "top");
        await page.getByRole("menuitemradio", { name, exact: true }).tap();
        await expect(card.locator('[data-slot="chart"]')).toHaveAttribute("data-chart-type", value);
      }
      await record(page, info, { compactChoices: "trend", width, tabsBox, typeGeometry });
      if (width === 320) {
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await page.clock.runFor(100);
        expect((await tabs.boundingBox())!.height).toBeLessThanOrEqual(80);
        for (const name of ["图表", "每日数据"]) {
          const label = await tabs.getByRole("tab", { name, exact: true }).evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const lines = [...range.getClientRects()].filter(line => line.width && line.height);
            return {
              lineCount: new Set(lines.map(line => Math.round(line.top))).size,
              contained: lines.every(line => line.left >= bounds.left - 1 && line.right <= bounds.right + 1 && line.top >= bounds.top - 1 && line.bottom <= bounds.bottom + 1),
            };
          });
          expect(label.lineCount, `${name} remains a complete label at doubled text`).toBe(1);
          expect(label.contained).toBe(true);
        }
        await record(page, info, { compactChoices: "trend-doubled-text", width });
      }

      await page.goto(manifest.origin + "/admin/work-items");
      const range = page.locator("[data-list-mobile-leading]").getByRole("group", { name: "显示范围", exact: true });
      await expect(range).toBeVisible();
      const rangeBox = (await range.boundingBox())!;
      expect(rangeBox.width).toBeLessThan(200);
      for (const name of ["待处理", "已忽略"]) {
        const target = range.getByRole("button", { name, exact: true });
        expect((await centered(target, page)).visual.height).toBeCloseTo(32, 1);
        await target.tap();
        await expect(target).toHaveAttribute("aria-pressed", "true");
      }
      await record(page, info, { compactChoices: "work-items", width, rangeBox });

      await page.goto(manifest.origin + "/admin/settings/display");
      await page.getByRole("link", { name: "编辑界面显示", exact: true }).click();
      const editor = page.locator("[data-overlay-content]");
      const defaults = editor.getByRole("group", { name: "收款趋势默认图形", exact: true });
      const defaultGeometry = [];
      for (const name of ["面积图", "柱状图", "折线图"]) {
        const target = defaults.getByRole("button", { name, exact: true });
        const geometry = await centered(target, page);
        expect(geometry.visual.height).toBeCloseTo(32, 1);
        expect(geometry.visual.width).toBeLessThan(120);
        defaultGeometry.push(geometry);
        await target.tap();
        await expect(target).toHaveAttribute("aria-pressed", "true");
      }
      expect(Math.max(...defaultGeometry.map(geometry => geometry.visual.y)) - Math.min(...defaultGeometry.map(geometry => geometry.visual.y))).toBeLessThanOrEqual(1);
      await record(page, info, { compactChoices: "display-default", width, defaultGeometry });
    });
  }

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
