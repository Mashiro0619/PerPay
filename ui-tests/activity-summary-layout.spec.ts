import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

test.use({ hasTouch: true, isMobile: true });

for (const surface of [
  { name: "work-items", path: "/work-items", list: "待处理提醒列表" },
  { name: "notifications", path: "/notifications?status=RETRY_WAIT", list: "通知列表" },
]) {
  test(`${surface.name} keeps record context readable in compact mobile rows`, async ({ page, manifest }, info) => {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await login(page, manifest);
    for (const width of [423, 390, 320]) for (const font of [100, 200]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(manifest.origin + "/admin" + surface.path);
      await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", font);
      const list = page.getByRole("list", { name: surface.list, exact: true });
      const row = list.locator("[data-business-row]").first();
      await expect(row).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.clock.runFor(100);
      const geometry = await row.evaluate(element => {
        const frame = element.getBoundingClientRect();
        const values = [...element.querySelectorAll('.list-primary-link, .list-money, .list-site-identity, time, [data-slot="badge"]')].map(value => {
          const rect = value.getBoundingClientRect();
          return { text: value.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        const overlaps = values.flatMap((a, index) => values.slice(index + 1).filter(b =>
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
        ).map(b => [a.text, b.text]));
        return { height: frame.height, left: frame.left, right: frame.right, values, overlaps,
          viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
      });
      expect(geometry.overlaps).toEqual([]);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
      for (const value of geometry.values) {
        expect(value.left, value.text ?? "value").toBeGreaterThanOrEqual(geometry.left - 1);
        expect(value.right, value.text ?? "value").toBeLessThanOrEqual(geometry.right + 1);
      }
      if (font === 100) expect(geometry.height, "ordinary reminders and retries should fit a concise summary").toBeLessThanOrEqual(width === 320 ? 180 : 160);
      await expect(row.locator("a[data-row-link]")).toHaveCount(1);
      await expect(row.locator("time")).toBeVisible();
      if (surface.name === "work-items") {
        await expect(row.getByRole("group", { name: /^应付金额 / })).toBeVisible();
        await expect(row.getByRole("link", { name: /^查看订单：/ })).toBeVisible();
      } else {
        await expect(row.locator("dt").filter({ hasText: /^尝试次数$/ })).toBeVisible();
        await expect(row.locator("dt").filter({ hasText: /^下次尝试$/ })).toBeVisible();
        await expect(row.locator("[data-summary-message]")).toBeVisible();
      }
      const site = row.locator("a.list-site-identity");
      await site.scrollIntoViewIfNeeded();
      await expectTouchTarget(site);
      await page.screenshot({ path: info.outputPath(`${surface.name}-${width}-${font}.png`), animations: "disabled" });
      await record(page, info, { surface: surface.name, width, font, geometry });
    }
  });
}
