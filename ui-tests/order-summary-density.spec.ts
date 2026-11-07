import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

test.use({ hasTouch: true, isMobile: true });

test("mobile orders keep a compact summary without losing money, status or context", async ({ page, manifest }, info) => {
  const paidId = manifest.details.orderPaid!.split("/").at(-1)!;
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page, manifest);
  for (const width of [423, 390, 320]) for (const font of [100, 200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/orders");
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", font);
    const row = page.locator('[data-business-row]').filter({ has: page.locator(`a[data-row-link][href*="${paidId}"]`) });
    await expect(row).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);
    for (const name of ["应付金额", "实收金额", "网站", "创建时间"]) {
      await expect(row.locator("dt").filter({ hasText: new RegExp("^" + name + "$") })).toBeVisible();
    }
    await expect(row.locator('[data-summary-status]')).toContainText("收款已确认");
    const geometry = await row.evaluate(element => {
      const frame = element.getBoundingClientRect();
      const title = element.querySelector('.list-summary-identity')!.getBoundingClientRect();
      const status = element.querySelector('[data-summary-status]')!.getBoundingClientRect();
      const values = [...element.querySelectorAll('.list-money, time, .list-site-identity')].map(value => {
        const rect = value.getBoundingClientRect();
        return { text: value.textContent, left: rect.left, right: rect.right };
      });
      const metadata = [...element.querySelectorAll('.order-summary-metadata dt, .order-summary-metadata dd')].map(value => {
        const rect = value.getBoundingClientRect();
        return { center: rect.top + rect.height / 2 };
      });
      return { height: frame.height, left: frame.left, right: frame.right, metadata,
        sameHeadingRow: Math.min(title.bottom, status.bottom) > Math.max(title.top, status.top), values };
    });
    if (font === 100) {
      expect(geometry.height, "ordinary orders should not consume a large card per record").toBeLessThanOrEqual(width === 320 ? 160 : 140);
      expect(geometry.sameHeadingRow).toBe(true);
      if (width >= 390) expect(Math.max(...geometry.metadata.map(box => box.center)) - Math.min(...geometry.metadata.map(box => box.center)), "site and creation time share the same reading line despite the link's enlarged touch area").toBeLessThanOrEqual(1);
    }
    for (const value of geometry.values) {
      expect(value.left, value.text ?? "value").toBeGreaterThanOrEqual(geometry.left - 1);
      expect(value.right, value.text ?? "value").toBeLessThanOrEqual(geometry.right + 1);
    }
    const site = row.locator("a.list-site-identity");
    await site.scrollIntoViewIfNeeded();
    await page.clock.runFor(100);
    await expectTouchTarget(site);
    await page.screenshot({ path: info.outputPath(`orders-${width}-${font}.png`), animations: "disabled" });
    await record(page, info, { feature: "compact-order-summary", width, font, geometry });
  }
});
