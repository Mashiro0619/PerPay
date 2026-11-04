import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";

test.describe("overview metric reading access", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("large values retain complete digits on one line and remain keyboard reachable on narrow cards", async ({ page, manifest }, info) => {
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
      expect(geometry.lines, "the amount stays one numeric unit instead of splitting its digits across lines").toHaveLength(1);
      expect(geometry.lines.every(line => line.top >= -1 && line.bottom <= geometry.height + 2), "the number has no vertical clipping").toBe(true);
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
      if (geometry.scrollWidth > geometry.clientWidth + 1) {
        await amount.evaluate(element => element.scrollLeft = 0);
        await page.keyboard.press("ArrowRight");
        await page.clock.runFor(250);
        await expect.poll(() => amount.evaluate(element => element.scrollLeft), "the focused value itself can reveal overflow digits with the keyboard").toBeGreaterThan(0);
        await amount.evaluate(element => element.scrollLeft = element.scrollWidth);
        const ending = await amount.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          return { textRight: range.getBoundingClientRect().right, right: element.getBoundingClientRect().right };
        });
        expect(ending.textRight).toBeLessThanOrEqual(ending.right + 1);
        await amount.evaluate(element => element.scrollLeft = 0);
      } else {
        expect(geometry.lines[0]!.left).toBeGreaterThanOrEqual(-1);
        expect(geometry.lines[0]!.right).toBeLessThanOrEqual(geometry.width + 1);
      }
      await record(page, info, { width, theme, font, syntheticMetricValues: true, geometry, focused });
      await screenshot(page, info, `metric-focus-${theme}-${width}-${font}`);
      const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      try {
        // At enlarged text sizes the trend controls are below the focused KPI.
        // Their contrast evidence includes real viewport hit tests, so bring
        // them into view without changing the KPI's keyboard focus.
        await page.getByRole("group", { name: "趋势指标", exact: true }).scrollIntoViewIfNeeded();
        await audit(page, info, `metric-focus-${theme}-${width}-${font}`);
      } finally {
        await page.evaluate(({ x, y }) => window.scrollTo({ left: x, top: y, behavior: "instant" }), scroll);
      }
      await expect(amount).toBeFocused();
    }
  });

  test("ordinary amounts remain completely visible after narrow and short-screen text reflow", async ({ page, manifest }, info) => {
    await page.route("**/api/admin/v1/system/analytics?*", async route => {
      const response = await route.fetch();
      const body = await response.json() as { data: SystemAnalytics };
      const daily = body.data.daily.map((day, index) => index === body.data.daily.length - 1
        ? { ...day, confirmed_amount_cents: 121029 }
        : day);
      await route.fulfill({ json: { data: { ...body.data, daily } } });
    });
    await login(page, manifest);
    for (const layout of [{ width: 320, height: 560, text: 200 }, { width: 640, height: 280, text: 150 }, { width: 390, height: 844, text: 100 }]) {
      await page.setViewportSize(layout);
      await page.goto(manifest.origin + "/admin/");
      await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", layout.text);
      await page.clock.runFor(100);
      const amount = page.locator('[data-overview-kpis] [data-slot="card-title"]').first();
      await expect(amount).toHaveText("¥1,210.29");
      const geometry = await amount.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const bounds = element.getBoundingClientRect();
        return { width: element.clientWidth, scrollWidth: element.scrollWidth,
          fontSize: parseFloat(getComputedStyle(element).fontSize),
          lines: [...range.getClientRects()].filter(line => line.width && line.height).map(line => ({ left: line.left - bounds.left, right: line.right - bounds.left })) };
      });
      expect(geometry.lines).toHaveLength(1);
      expect(geometry.scrollWidth, "a normal amount is fully visible without additional scrolling").toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.lines[0]!.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.lines[0]!.right).toBeLessThanOrEqual(geometry.width + 1);
      if (layout.text === 100) expect(geometry.fontSize, "ordinary phone values keep their established display size").toBe(24);
      await record(page, info, { feature: "ordinary-overview-amount-reflow", layout, geometry, syntheticMetricValues: true });
      await screenshot(page, info, `ordinary-metric-${layout.width}-${layout.text}`);
    }
  });
});
