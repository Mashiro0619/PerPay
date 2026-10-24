import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";

test.describe("overview metric reading access", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("large values wrap completely and retain keyboard focus on narrow cards", async ({ page, manifest }, info) => {
    await page.route("**/api/admin/v1/system/analytics?*", async route => {
      const response = await route.fetch();
      const body = await response.json() as { data: SystemAnalytics };
      const daily = body.data.daily.map((day, index) => index === body.data.daily.length - 1
        ? { ...day, confirmed_amount_cents: 987654321012, confirmations: 123456789 }
        : day);
      await route.fulfill({ json: { data: { ...body.data, daily } } });
    });
    await login(page, manifest);

    for (const width of [320, 390]) for (const theme of ["light", "dark"]) for (const font of [100, 200]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
      await page.goto(manifest.origin + "/admin/");
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      await page.clock.runFor(100);
      const amount = page.locator('[data-overview-kpis] [data-slot="card-title"]').first();
      await expect(amount).toHaveText("¥9,876,543,210.12");
      const geometry = await amount.evaluate(element => {
        const box = element.getBoundingClientRect(), range = document.createRange();
        range.selectNodeContents(element);
        return {
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          width: box.width, height: box.height,
          lines: [...range.getClientRects()].filter(line => line.width && line.height).map(line => ({
            left: line.left - box.left, right: line.right - box.left,
            top: line.top - box.top, bottom: line.bottom - box.top,
          })),
        };
      });
      expect(geometry.scrollWidth, "the complete value fits the card without horizontal scrolling").toBeLessThanOrEqual(geometry.clientWidth + 1);
      expect(geometry.lines.length).toBeGreaterThan(0);
      expect(geometry.lines.every(line => line.left >= -1 && line.right <= geometry.width + 1 && line.top >= -1 && line.bottom <= geometry.height + 1), "every rendered line of the amount remains readable").toBe(true);
      await amount.focus();
      await expect(amount).toBeFocused();
      await expect(amount).toHaveAccessibleName("今日确认金额：¥9,876,543,210.12");
      const focused = await amount.evaluate(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const card = element.closest('[data-slot="card"]')!.getBoundingClientRect();
        const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        return {
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
          outlineContained: box.left - extent >= card.left && box.right + extent <= card.right && box.top - extent >= card.top && box.bottom + extent <= card.bottom,
          scrollLeft: element.scrollLeft,
        };
      });
      expect(focused.outlineStyle).not.toBe("none");
      expect(focused.outlineWidth).toBeGreaterThanOrEqual(2);
      expect(focused.outlineContained).toBe(true);
      await record(page, info, { width, theme, font, syntheticMetricValues: true, geometry, focused });
      await screenshot(page, info, `metric-focus-${theme}-${width}-${font}`);
      await audit(page, info, `metric-focus-${theme}-${width}-${font}`);
    }
  });
});
