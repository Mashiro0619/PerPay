import type { Locator, Page, TestInfo } from "@playwright/test";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

const ANALYTICS = "**/api/admin/v1/system/analytics?*";
const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
const TODAY = "2026-01-04";
const SPARSE_DATE = "2025-12-31";
const TYPES = [
  ["AREA", "面积图"],
  ["BAR", "柱状图"],
  ["LINE", "折线图"],
] as const;

type Scenario = "sparse" | "zero" | "today" | "large";

function fixture(base: SystemAnalytics, range: SystemAnalytics["range_days"], scenario: Scenario): SystemAnalytics {
  const end = Date.parse(TODAY + "T00:00:00.000Z");
  const length = scenario === "today" ? 1 : range;
  const daily = Array.from({ length }, (_, index) => {
    const date = new Date(end - (length - index - 1) * DAY).toISOString().slice(0, 10);
    const amount = scenario === "zero" ? 0
      : scenario === "large" ? 987654321012
      : scenario === "today" ? 12345
      : date === SPARSE_DATE ? 1 : 0;
    return {
      date,
      confirmed_amount_cents: amount,
      confirmations: amount > 0 ? 1 : 0,
      orders_created: scenario === "zero" ? 0 : date === TODAY ? 3 : 1,
      notifications_acknowledged: 0,
      notifications_failed: 0,
    };
  });
  return {
    ...base,
    range_days: range,
    from: new Date(end - (length - 1) * DAY - BEIJING_OFFSET).toISOString(),
    to: new Date(end + DAY - BEIJING_OFFSET).toISOString(),
    daily,
    confirmations: {
      count: daily.reduce((total, day) => total + day.confirmations, 0),
      amount_cents: daily.reduce((total, day) => total + day.confirmed_amount_cents, 0),
    },
    orders: { ...base.orders, created: daily.reduce((total, day) => total + day.orders_created, 0) },
  };
}

async function mockAnalytics(page: Page, scenario: () => Scenario) {
  let reads = 0;
  await page.route(ANALYTICS, async route => {
    reads++;
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    const range = Number(new URL(route.request().url()).searchParams.get("range"));
    if (range !== 7 && range !== 30 && range !== 90) throw new Error(`Unexpected range: ${range}`);
    await route.fulfill({ response, json: { data: fixture(body.data, range, scenario()) } });
  });
  return () => reads;
}

function trendCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
}

async function captureCard(card: Locator, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await card.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("one cent across New Year stays readable in each chart and presentation changes retain the daily page", async ({ page, manifest }, info) => {
  const reads = await mockAnalytics(page, () => "sparse");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  const card = trendCard(page);
  const plot = card.locator('[data-slot="chart"]');
  const types = card.getByRole("group", { name: "图表类型", exact: true });
  const metrics = card.getByRole("group", { name: "趋势指标", exact: true });
  await expect(card.locator("[data-metric-value]")).toHaveText("¥0.01");
  await expect(card.locator("[data-trend-sparse]")).toContainText(SPARSE_DATE);
  await expect(card.locator("[data-trend-sparse]")).toContainText("¥0.01");
  await expect(card.locator('[data-trend-summary="average"]')).toContainText("¥0.00");
  await expect(card.locator('[data-trend-summary="peak"]')).toContainText("¥0.01");
  await card.getByRole("tab", { name: "每日数据", exact: true }).click();
  const report = card.getByRole("region", { name: "每日数据", exact: true });
  await report.getByRole("button", { name: "下一页", exact: true }).click();
  const dates = await report.locator(".daily-date time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")));
  await expect(report.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
  await card.getByRole("tab", { name: "图表", exact: true }).click();
  const readsBeforePresentation = reads();

  for (const [type, label] of TYPES) {
    await types.getByRole("button", { name: label, exact: true }).click();
    await expect(plot).toHaveAttribute("data-chart-type", type);
    await expect(types.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(card.locator("[data-trend-sparse]")).toContainText("¥0.01");
    await expect.poll(async () => (await plot.locator(".recharts-yAxis-tick-labels text").allTextContents()).some(text => text.includes("¥0.01"))).toBe(true);
    if (type !== "BAR") {
      await expect(plot.locator("[data-trend-point]")).toHaveCount(1);
    }
    await captureCard(card, info, `one-cent-${type.toLowerCase()}`);
    await metrics.getByRole("button", { name: "新建订单", exact: true }).click();
    await expect(card.locator("[data-metric-value]")).toHaveText("32");
    await expect(plot).toHaveAttribute("aria-label", /每日新建订单/);
    await metrics.getByRole("button", { name: "确认金额", exact: true }).click();
    await expect(card.locator("[data-metric-value]")).toHaveText("¥0.01");
  }

  await card.getByRole("tab", { name: "每日数据", exact: true }).click();
  await expect(report.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
  expect(await report.locator(".daily-date time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")))).toEqual(dates);
  expect(reads()).toBe(readsBeforePresentation);
  await record(page, info, { scenario: "one-cent-cross-year", preservedDates: dates, reads: reads() });
  await page.setViewportSize({ width: 320, height: 900 });
  await card.getByRole("tab", { name: "图表", exact: true }).click();
  for (const [type, label] of TYPES) {
    await types.getByRole("button", { name: label, exact: true }).click();
    await expect(plot).toHaveAttribute("data-chart-type", type);
    await expect(card.locator("[data-trend-sparse]")).toContainText("¥0.01");
    await record(page, info, { scenario: "one-cent-cross-year-mobile", type, width: 320 });
    await captureCard(card, info, `one-cent-mobile-${type.toLowerCase()}`);
  }
});

test("zero days and a single current day keep their distinct statistical meaning", async ({ page, manifest }, info) => {
  let scenario: Scenario = "zero";
  await mockAnalytics(page, () => scenario);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  const card = trendCard(page);
  const plot = card.locator('[data-slot="chart"]');
  await expect(plot).toBeVisible();
  await expect(card.getByText("这段时间暂无确认收款", { exact: true })).toBeVisible();
  await expect(card.locator("[data-trend-sparse]")).toHaveCount(0);
  await card.getByRole("button", { name: "柱状图", exact: true }).click();
  await expect(plot).toHaveAttribute("data-chart-type", "BAR");
  const heights = await plot.locator(".recharts-bar-rectangle .recharts-rectangle").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(heights.every(height => height === 0), "zero amounts do not receive a synthetic visible bar").toBe(true);
  const application = plot.locator('svg[role="application"]');
  await application.focus();
  await application.press("ArrowRight");
  await expect(plot.locator(".recharts-tooltip-wrapper")).toContainText("¥0.00");
  await expect(plot.locator(".recharts-tooltip-cursor")).toBeVisible();

  scenario = "today";
  await page.reload();
  await expect(card.locator("[data-metric-value]")).toHaveText("¥123.45");
  await expect(card.locator('[data-trend-summary="average"]')).toContainText("—");
  await expect(card.locator('[data-trend-summary="peak"]')).toContainText("—");
  await expect(card.locator("[data-trend-sparse]")).toContainText(TODAY);
  await expect(card.locator("[data-trend-sparse]")).toContainText("¥123.45");
  await expect(card.getByText("这段时间暂无确认收款", { exact: true })).toHaveCount(0);
  for (const [type, label] of TYPES) {
    await card.getByRole("button", { name: label, exact: true }).click();
    await expect(plot).toHaveAttribute("data-chart-type", type);
    if (type !== "BAR") await expect(plot.locator("[data-trend-point]")).toHaveCount(1);
  }
  await card.getByRole("tab", { name: "每日数据", exact: true }).click();
  const report = card.getByRole("region", { name: "每日数据", exact: true });
  await expect(report.locator(".daily-date time")).toHaveCount(1);
  await expect(report.getByText("今日", { exact: true })).toBeVisible();
  await expect(report.getByRole("status")).toHaveText("共 1 天");
  await record(page, info, { scenario: "zero-then-current-day", zeroBarHeights: heights });
});

test.describe("narrow trend reading", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });

  test("chart choices and large exact tooltips fit at normal and doubled text", async ({ page, manifest }, info) => {
    await mockAnalytics(page, () => "large");
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await login(page, manifest);
    for (const [type, label, font] of [["AREA", "面积图", 100], ["BAR", "柱状图", 200], ["LINE", "折线图", 200]] as const) {
      await page.evaluate(font => { document.documentElement.style.fontSize = font + "%"; }, font);
      await page.clock.runFor(200);
      const card = trendCard(page);
      const types = card.getByRole("group", { name: "图表类型", exact: true });
      const controls = [];
      for (const [value, name] of TYPES) {
        const button = types.getByRole("button", { name, exact: true });
        await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await page.clock.runFor(50);
        // The group's outer buttons have rounded corners. Measure their full
        // 40px target, then exercise the real center tap instead of demanding
        // that the transparent corner pixels receive pointer events.
        const control = await expectTouchTarget(button, { hitTest: false });
        expect([1, 3, 4, 5, 7].every(index => control.points[index]!.hit), "the button center and four edge midpoints belong to that control").toBe(true);
        controls.push(control);
        await button.tap();
        await expect(card.locator('[data-slot="chart"]')).toHaveAttribute("data-chart-type", value);
      }
      await types.getByRole("button", { name: label, exact: true }).tap();
      const plot = card.locator('[data-slot="chart"]');
      await expect(plot).toHaveAttribute("data-chart-type", type);
      const application = plot.locator('svg[role="application"]');
      await application.scrollIntoViewIfNeeded();
      await application.focus();
      await application.press("ArrowRight");
      const tooltip = plot.locator(".trend-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("¥9,876,543,210.12");
      await page.clock.runFor(200);
      const geometry = await tooltip.evaluate(element => {
        const tooltip = element.getBoundingClientRect();
        const card = element.closest('[data-slot="card"]')!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const lines = [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0);
        return {
          card: { left: card.left, right: card.right },
          tooltip: { left: tooltip.left, right: tooltip.right, top: tooltip.top, bottom: tooltip.bottom },
          clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
          textFits: lines.every(line => line.left >= tooltip.left - 1 && line.right <= tooltip.right + 1 && line.top >= tooltip.top - 1 && line.bottom <= tooltip.bottom + 1),
        };
      });
      expect(geometry.tooltip.left).toBeGreaterThanOrEqual(geometry.card.left - 1);
      expect(geometry.tooltip.right).toBeLessThanOrEqual(geometry.card.right + 1);
      expect(geometry.clipped).toBe(false);
      expect(geometry.textFits).toBe(true);
      await record(page, info, { scenario: "large-tooltip", type, font, controls, geometry });
      await captureCard(card, info, `large-tooltip-${type.toLowerCase()}-${font}`);
    }
    expect(errors).toEqual([]);
  });
});
