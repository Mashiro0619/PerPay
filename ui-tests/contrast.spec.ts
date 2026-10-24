import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { measureAxisContrast, resolveSvgContrast } from "./contrast-evidence";
import { expectTouchTarget } from "./touch-targets";

async function readableMetrics(page: Page) {
  const group = page.getByRole("group", { name: "趋势指标", exact: true });
  const choices = [];
  for (const name of ["确认金额", "新建订单"]) {
    const choice = group.getByRole("button", { name, exact: true });
    await choice.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await page.clock.runFor(100);
    const touch = await expectTouchTarget(choice);
    const text = await choice.evaluate(element => {
      const box = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      const lines = [...range.getClientRects()].filter(line => line.width && line.height);
      const clippedBy = [];
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (["hidden", "clip"].includes(style.overflowX) && lines.some(line => line.left < bounds.left - 1 || line.right > bounds.right + 1))
          clippedBy.push({ tag: parent.tagName, slot: parent.getAttribute("data-slot"), bounds: bounds.toJSON() });
      }
      return { clippedBy, width: box.width, height: box.height, lines: lines.map(line => ({
        left: line.left - box.left, right: line.right - box.left,
        top: line.top - box.top, bottom: line.bottom - box.top,
      })) };
    });
    expect(text.lines.length).toBeGreaterThan(0);
    expect(text.lines.every(line => line.left >= -1 && line.right <= text.width + 1 && line.top >= -1 && line.bottom <= text.height + 1), `complete trend choice: ${JSON.stringify(text)}`).toBe(true);
    expect(text.clippedBy, "Card ancestors preserve the complete trend choice").toEqual([]);
    await choice.tap();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    choices.push({ name, touch, text });
  }
  await group.getByRole("button", { name: "确认金额", exact: true }).tap();
  return choices;
}

async function readableAxes(page: Page, chart: Locator) {
  let measurements: (ReturnType<typeof measureAxisContrast>)[] = [];
  await expect.poll(async () => {
    await page.clock.runFor(50);
    measurements = [];
    for (const axis of await chart.locator(".recharts-cartesian-axis-tick-value").all()) measurements.push(await axis.evaluate(measureAxisContrast));
    return measurements.length ? measurements.filter(value => !value?.passed) : ["No rendered axis labels"];
  }, { message: "scaled tick labels fit the SVG and have sufficient contrast over their actual background" }).toEqual([]);
  return measurements;
}

test.describe("chart contrast and enlarged control readability", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: global and website chart text has verified contrast at normal and doubled text`, async ({ page, manifest }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
      await login(page, manifest);
      const site = manifest.routes.find(path => /^\/sites\/[^/]+$/.test(path) &&
        path !== "/sites/new" && path !== "/sites/defaults")!;
      for (const font of [100, 200]) for (const route of ["/", site]) {
        await page.goto(manifest.origin + "/admin" + route);
        const chart = page.locator('[data-slot="chart"]');
        await expect(chart).toBeVisible();
        await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
        await page.clock.runFor(200);
        await page.evaluate(() => document.fonts.ready);
        await page.locator(".trend-header").scrollIntoViewIfNeeded();
        const period = page.getByRole("combobox", { name: "统计周期", exact: true });
        const value = period.locator('[data-slot="select-value"]');
        const valueBox = (await value.boundingBox())!;
        const point = { x: valueBox.x + valueBox.width / 2, y: valueBox.y + valueBox.height / 2 };
        expect(await period.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit === element || element.contains(hit);
        }, point), "period text belongs to its own trigger, not the statistics-help button").toBe(true);
        await page.touchscreen.tap(point.x, point.y);
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.getByRole("option", { name: "近 7 天", exact: true }).click();
        await expect(period).toContainText("近 7 天");
        await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("7");
        const metricChoices = await readableMetrics(page);
        await expect(chart.locator(".recharts-cartesian-axis-tick-value").first()).toBeVisible();
        await expect.poll(() => chart.locator(".recharts-cartesian-axis-tick-value").first().evaluate(element =>
          Number.parseFloat(getComputedStyle(element).fontSize))).toBe(12 * font / 100);
        await page.clock.runFor(200);
        const axes = await chart.locator(".recharts-cartesian-axis-tick-value").evaluateAll(elements =>
          elements.map(element => ({ text: element.textContent, box: element.getBoundingClientRect().toJSON() })));
        const measurements = await readableAxes(page, chart);
        const axe = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
        const reviews = await resolveSvgContrast(page, axe);
        expect(axe.violations).toEqual([]);
        expect(reviews.filter(review => !review.resolved), "all contrast incomplete nodes have explicit manual evidence").toEqual([]);
        await record(page, info, { evidence: "desktop browser touch emulation", theme, font, route, axes, metricChoices, contrast: measurements, rawContrastIncomplete: axe.incomplete, manualResolution: reviews });
      }
    });

    for (const chartType of ["BAR", "LINE"] as const) {
      test(`${theme}: ${chartType} axes retain their labels and contrast at doubled text`, async ({ page, manifest }, info) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), theme);
        await page.route("**/api/admin/v1/settings", async route => {
          const response = await route.fetch();
          const json = await response.json();
          json.data.display.dashboard_chart_type = chartType;
          await route.fulfill({ response, json });
        });
        await login(page, manifest);
        await page.goto(manifest.origin + "/admin/");
        const chart = page.locator('[data-slot="chart"]');
        await expect(chart).toHaveAttribute("data-chart-type", chartType);
        await page.evaluate(() => document.documentElement.style.fontSize = "200%");
        await page.clock.runFor(200);
        await page.evaluate(() => document.fonts.ready);
        await expect(chart.locator(".recharts-cartesian-axis-tick-value").first()).toBeVisible();
        await expect.poll(() => chart.locator(".recharts-cartesian-axis-tick-value").first().evaluate(element =>
          Number.parseFloat(getComputedStyle(element).fontSize))).toBe(24);
        const measurements = await readableAxes(page, chart);
        await record(page, info, { evidence: "desktop browser touch emulation", theme, chartType, font: 200, contrast: measurements });
      });
    }
  }
});
