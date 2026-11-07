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
        const identitySelector = '.list-primary-link, .list-money, .list-site-identity, time, [data-slot="badge"]';
        const scalarFields = [...element.querySelectorAll('.business-summary-field dd')].filter(value => !value.querySelector(identitySelector));
        const values = [...element.querySelectorAll(identitySelector), ...scalarFields].map(value => {
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
      await record(page, info, { surface: surface.name, width, font, geometry });
      expect(geometry.overlaps).toEqual([]);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
      for (const value of geometry.values) {
        expect(value.left, value.text ?? "value").toBeGreaterThanOrEqual(geometry.left - 1);
        expect(value.right, value.text ?? "value").toBeLessThanOrEqual(geometry.right + 1);
      }
      await expect(row.locator("a[data-row-link]")).toHaveCount(1);
      if (surface.name === "work-items") {
        if (font === 100) expect(geometry.height, "ordinary reminders should fit a concise summary").toBeLessThanOrEqual(width === 320 ? 180 : 160);
        await expect(row.locator("time")).toBeVisible();
        await expect(row.getByRole("group", { name: /^应付金额 / })).toBeVisible();
        await expect(row.getByRole("link", { name: /^查看订单：/ })).toBeVisible();
      } else {
        // Notification identity now includes the order, amount and both dates;
        // verify those readable fields rather than the older, shorter row height.
        const field = (label: string) => row.locator(".business-summary-field").filter({ has: page.locator("dt").filter({ hasText: new RegExp("^" + label + "$") }) });
        for (const label of ["商户订单号", "尝试次数", "创建时间", "下次尝试", "应付金额"]) {
          await expect(field(label).locator("dt")).toBeVisible();
          await expect(field(label).locator("dd")).toBeVisible();
        }
        const orderLink = field("商户订单号").getByRole("link");
        await expect(orderLink).not.toHaveText("");
        expect(new URL((await orderLink.getAttribute("href"))!, manifest.origin).searchParams.get("overlay")).toMatch(/^\/orders\/[^/]+$/);
        await expect(field("应付金额").locator("dd")).toHaveText(/^¥[\d,.]+$/);
        await expect(field("创建时间").locator("time")).toBeVisible();
        await expect(field("下次尝试").locator("time")).toBeVisible();
        await expect(row.locator("time")).toHaveCount(2);
        await expect(row.locator("[data-summary-message]")).toBeVisible();
      }
      const site = row.locator("a.list-site-identity");
      await site.scrollIntoViewIfNeeded();
      await expectTouchTarget(site);
      await page.screenshot({ path: info.outputPath(`${surface.name}-${width}-${font}.png`), animations: "disabled" });
    }
  });
}
