import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function readableValue(value: Locator) {
  return value.evaluate(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      text: element.textContent,
      box: box.toJSON(),
      lines: [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0).map(line => line.toJSON()),
    };
  });
}

test.describe("payment site identity stays readable with enlarged text", () => {
  test.use({ hasTouch: true, isMobile: true, reducedMotion: "reduce" });

  for (const [width, height, font] of [[320, 560, 100], [320, 560, 200], [360, 560, 200], [640, 280, 150]] as const) {
    test(`${width}x${height}, ${font}% root text: selected site and decisions remain reachable`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/");
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      const actions = page.getByRole("button", { name: "页面操作", exact: true });
      await actions.click();
      const opener = page.getByRole("menuitem", { name: "测试收款", exact: true });
      await opener.click();
      await expect(page.getByRole("menu", { name: "页面操作", exact: true })).toHaveCount(0);
      const dialog = page.getByRole("dialog", { name: "测试收款", exact: true });
      const picker = dialog.getByRole("combobox", { name: "业务网站", exact: true });
      await picker.click();
      await page.getByRole("option", { name: "青禾生活馆", exact: true }).click();
      const value = picker.locator('[data-slot="select-value"]');
      await expect(value).toHaveText("青禾生活馆");
      await picker.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await page.clock.runFor(100);
      await expectTouchTarget(picker);
      const reading = await readableValue(value);
      expect(reading.lines.length).toBeGreaterThan(0);
      for (const line of reading.lines) {
        expect(line.left).toBeGreaterThanOrEqual(reading.box.left - 1);
        expect(line.right).toBeLessThanOrEqual(reading.box.right + 1);
        expect(line.top).toBeGreaterThanOrEqual(reading.box.top - 1);
        expect(line.bottom).toBeLessThanOrEqual(reading.box.bottom + 1);
      }
      const arrow = (await picker.locator("svg").boundingBox())!;
      expect(reading.box.right).toBeLessThanOrEqual(arrow.x);
      await record(page, info, { feature: "selected-payment-site", width, height, rootTextPercent: font, reading });
      const cancel = dialog.getByRole("button", { name: "取消", exact: true });
      await cancel.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await page.clock.runFor(100);
      await expectTouchTarget(cancel);
      await cancel.tap();
      await expect(dialog).toHaveCount(0);
      await expect(actions).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    });
  }
});
