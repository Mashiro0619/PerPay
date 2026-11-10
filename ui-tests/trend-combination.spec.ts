import type { Locator, Page, TestInfo } from "@playwright/test";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

const ANALYTICS = "**/api/admin/v1/system/analytics?*";
const TODAY = "2026-01-04";
const SPARSE_DATE = "2025-12-31";
const DAY = 86_400_000;
type Scenario = "mixed" | "large" | "zero" | "sparse";
const amountText = (cents: number) => "¥" + (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const countText = (value: number) => value.toLocaleString("zh-CN");

function analyticsFixture(base: SystemAnalytics, days: SystemAnalytics["range_days"], scenario: Scenario): SystemAnalytics {
  const end = Date.parse(TODAY + "T00:00:00Z");
  const daily = Array.from({ length: days }, (_, index) => {
    const distance = days - index - 1;
    const date = new Date(end - distance * DAY).toISOString().slice(0, 10);
    const amount = scenario === "zero" ? 0 : scenario === "large" ? 987_654_321_012
      : scenario === "sparse" ? date === SPARSE_DATE ? 1 : 0 : [12_345, 25_000, 0, 12_500_000][distance % 4]!;
    const orders = scenario === "zero" ? 0 : scenario === "large" ? 123_456
      : scenario === "sparse" ? date === TODAY ? 17 : 0 : [1, 17, 3, 11, 5, 23, 2][distance % 7]!;
    return { date, confirmed_amount_cents: amount, confirmations: amount > 0 ? 1 : 0, orders_created: orders,
      notifications_acknowledged: 0, notifications_failed: 0 };
  });
  // These authoritative totals intentionally differ from the rendered daily sums.
  const totalAmount = scenario === "zero" ? 0 : scenario === "sparse" ? 1 : scenario === "large" ? 1_234_567_890_123 : 7_654_321;
  const totalOrders = scenario === "zero" ? 0 : scenario === "sparse" ? 17 : scenario === "large" ? 2_345_678 : 4_321;
  return { ...base, range_days: days,
    from: new Date(end - (days - 1) * DAY - 8 * 60 * 60 * 1000).toISOString(),
    to: new Date(end + DAY - 8 * 60 * 60 * 1000).toISOString(), daily,
    confirmations: { count: daily.reduce((sum, day) => sum + day.confirmations, 0), amount_cents: totalAmount },
    orders: { ...base.orders, created: totalOrders } };
}

async function mockAnalytics(page: Page, scenario: () => Scenario) {
  let reads = 0;
  const responses = new Map<number, SystemAnalytics>();
  await page.route(ANALYTICS, async route => {
    reads++;
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    const days = Number(new URL(route.request().url()).searchParams.get("range"));
    if (days !== 7 && days !== 30 && days !== 90) throw new Error(`Unexpected range: ${days}`);
    const data = analyticsFixture(body.data, days, scenario());
    responses.set(days, data);
    await route.fulfill({ response, json: { data } });
  });
  return { reads: () => reads, responses };
}

function trendCard(page: Page) {
  return page.locator(".trend-card").filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
}

async function expectCombined(card: Locator, data: SystemAnalytics) {
  const summary = card.locator('dl[aria-label="金额与订单汇总"]');
  await expect(summary.locator('[data-trend-metric="amount"]')).toHaveText(amountText(data.confirmations.amount_cents));
  await expect(summary.locator('[data-trend-metric="orders"]')).toHaveText(countText(data.orders.created) + " 笔");
  await expect(card.getByRole("group", { name: "图表类型", exact: true })).toHaveCount(0);
  const plot = card.locator('[data-slot="chart"]');
  await expect(plot).toHaveAttribute("data-chart-type", "COMBINED");
  await expect(plot).toHaveAttribute("aria-label", /金额.*订单/);
  await expect(card.getByRole("list", { name: "混合图图例", exact: true }).getByRole("listitem"))
    .toHaveText(["确认金额（左轴 · 元）", "新建订单（右轴 · 笔）"]);
  const axes = plot.locator(".recharts-yAxis");
  await expect(axes).toHaveCount(2);
  const amounts = plot.locator("text.trend-combined-amount-tick");
  const orders = plot.locator("text.trend-combined-orders-tick");
  await expect(amounts.first()).toHaveText(/^¥/);
  await expect(orders.first()).toHaveText(/\d.*笔$/);
  expect((await amounts.allTextContents()).every(value => value.startsWith("¥"))).toBe(true);
  expect((await orders.allTextContents()).every(value => value.endsWith("笔"))).toBe(true);
  return plot;
}

async function showTooltip(page: Page, plot: Locator) {
  const surface = plot.locator('svg[role="application"]');
  await surface.scrollIntoViewIfNeeded();
  await surface.focus();
  await surface.press("ArrowRight");
  await page.clock.runFor(50);
  const tooltip = trendCard(page).locator(".trend-tooltip");
  await expect(tooltip).toBeVisible();
  return tooltip;
}

async function expectTooltip(tooltip: Locator, amount: number, orders: number) {
  const rows = tooltip.locator(".trend-tooltip-value");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "确认金额" }).getByText(amountText(amount), { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: "新建订单" }).getByText(countText(orders) + " 笔", { exact: true })).toBeVisible();
}

async function tooltipAtDate(page: Page, plot: Locator, date: string, maximumSteps: number) {
  const tooltip = await showTooltip(page, plot);
  for (let step = 0; step <= maximumSteps; step++) {
    if ((await tooltip.innerText()).includes(date.replaceAll("-", "/"))) return tooltip;
    await plot.locator('svg[role="application"]').press("ArrowRight");
    await page.clock.runFor(30);
  }
  throw new Error("Keyboard tooltip did not reach " + date);
}

async function capture(card: Locator, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await card.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

test("combined money and order series retain independent units, authoritative totals and presentation state", async ({ page, manifest }, info) => {
  const fixture = await mockAnalytics(page, () => "mixed");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  const card = trendCard(page);
  const plot = card.locator('[data-slot="chart"]');
  await expect(plot).toBeVisible();
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname);
  });
  await card.getByRole("button", { name: "折线图", exact: true }).click();
  await card.getByRole("tab", { name: "每日数据", exact: true }).click();
  const daily = card.getByRole("region", { name: "每日数据", exact: true });
  await expect(daily.getByRole("status")).toHaveText("共 30 天");
  const dates = await daily.locator(".daily-date time").allTextContents();
  expect(dates).toHaveLength(30);
  await card.getByRole("tab", { name: "图表", exact: true }).click();
  const beforePresentation = fixture.reads();
  const combined = card.getByRole("button", { name: "金额与订单", exact: true });
  await combined.click();
  await expect(combined).toHaveAttribute("aria-pressed", "true");
  const data = fixture.responses.get(30)!;
  await expectCombined(card, data);
  await expect(combined).toHaveAccessibleDescription("确认金额 ¥76,543.21，新建订单 4,321 笔");
  await expect(plot.locator(".recharts-line-curve")).toBeVisible();
  const line = (await plot.locator(".recharts-line-curve").boundingBox())!;
  const bounds = (await plot.boundingBox())!;
  expect(line.height, "order counts retain their own scale beside much larger cent values").toBeGreaterThan(bounds.height / 4);
  const barHeights = await plot.locator(".recharts-bar-rectangle .recharts-rectangle").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...barHeights), "confirmed amounts are drawn as bars").toBeGreaterThan(bounds.height / 4);
  const tooltip = await showTooltip(page, plot);
  const date = (await tooltip.innerText()).match(/\d{4}\/\d{2}\/\d{2}/)?.[0].replaceAll("/", "-");
  const day = data.daily.find(day => day.date === date);
  expect(day, "both tooltip values belong to one displayed date").toBeDefined();
  await expectTooltip(tooltip, day!.confirmed_amount_cents, day!.orders_created);
  await capture(card, info, "combined-desktop");
  expect(await page.evaluate(() => localStorage.getItem("perpay:dashboard-chart-type"))).toBe("LINE");

  await card.getByRole("tab", { name: "每日数据", exact: true }).click();
  await expect(card.getByRole("group", { name: "趋势指标", exact: true })).toHaveCount(0);
  await expect(daily.getByRole("status")).toHaveText("共 30 天");
  expect(await daily.locator(".daily-date time").allTextContents()).toEqual(dates);
  await card.getByRole("tab", { name: "图表", exact: true }).click();
  await expectCombined(card, data);
  for (const metric of ["新建订单", "确认金额"]) {
    await card.getByRole("button", { name: metric, exact: true }).click();
    await expect(card.getByRole("button", { name: "折线图", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(plot).toHaveAttribute("data-chart-type", "LINE");
    await combined.click();
    await expectCombined(card, data);
  }
  expect(fixture.reads()).toBe(beforePresentation);
  for (const days of [7, 90]) {
    await card.getByRole("combobox", { name: "统计周期", exact: true }).click();
    await page.getByRole("option", { name: `近 ${days} 天`, exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe(String(days));
    await expect.poll(() => fixture.responses.has(days)).toBe(true);
    await expect(card).toHaveAttribute("aria-busy", "false");
    await expectCombined(card, fixture.responses.get(days)!);
    await expect(card.locator(".trend-caption")).toContainText(`共 ${days} 天`);
  }
  expect(await page.evaluate(() => localStorage.getItem("perpay:dashboard-chart-type"))).toBe("LINE");
  expect(writes).toEqual([]);
  await record(page, info, { scenario: "combined-desktop", authoritativeAmount: data.confirmations.amount_cents,
    authoritativeOrders: data.orders.created, retainedDates: dates, tooltipDate: date, lineHeight: line.height, barHeights, reads: fixture.reads(), writes });
});

test.describe("combined chart on a narrow touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 900 }, reducedMotion: "reduce" });
  test("both totals and same-day values remain readable with touch, keyboard and doubled text", async ({ page, manifest }, info) => {
    const fixture = await mockAnalytics(page, () => "large");
    await login(page, manifest);
    const card = trendCard(page);
    await expect(card.locator('[data-slot="chart"]')).toBeVisible();
    for (const font of [100, 200]) {
      await page.evaluate(font => { document.documentElement.style.fontSize = font + "%"; }, font);
      await page.emulateMedia({ colorScheme: font === 200 ? "dark" : "light" });
      await page.clock.runFor(100);
      const metrics = card.getByRole("group", { name: "趋势指标", exact: true });
      const combined = metrics.getByRole("button", { name: "金额与订单", exact: true });
      await combined.scrollIntoViewIfNeeded();
      await expectTouchTarget(combined);
      await combined.tap();
      const plot = await expectCombined(card, fixture.responses.get(30)!);
      await metrics.getByRole("button", { name: "新建订单", exact: true }).tap();
      await metrics.getByRole("button", { name: "新建订单", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(combined).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(combined).toHaveAttribute("aria-pressed", "true");
      await expectCombined(card, fixture.responses.get(30)!);
      const surface = plot.locator('svg[role="application"]');
      await surface.scrollIntoViewIfNeeded();
      await surface.tap();
      const tooltip = card.locator(".trend-tooltip");
      await expect(tooltip).toBeVisible();
      await expectTooltip(tooltip, 987_654_321_012, 123_456);
      await showTooltip(page, plot);
      await expectTooltip(tooltip, 987_654_321_012, 123_456);
      const geometry = await card.evaluate(element => {
        const frame = element.getBoundingClientRect();
        const nodes = [...element.querySelectorAll('[data-metric-value], .trend-tooltip')];
        const content = nodes.map(node => {
          const box = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          return { text: node.textContent, left: box.left, right: box.right,
            textFits: [...range.getClientRects()].every(line => line.left >= box.left - 1 && line.right <= box.right + 1 && line.top >= box.top - 1 && line.bottom <= box.bottom + 1) };
        });
        const plot = element.querySelector('[data-slot="chart"]')!.getBoundingClientRect();
        const viewport = element.querySelector<HTMLElement>("[data-combined-scroll]")!;
        const viewportBox = viewport.getBoundingClientRect();
        const ticks = [...element.querySelectorAll("text.trend-combined-amount-tick, text.trend-combined-orders-tick")]
          .map(tick => tick.getBoundingClientRect()).filter(box => box.width > 0);
        return { left: frame.left, right: frame.right, content,
          scroll: { left: viewportBox.left, right: viewportBox.right, width: viewport.clientWidth, contentWidth: viewport.scrollWidth },
          ticksFit: ticks.length > 0 && ticks.every(box => box.left >= plot.left - 1 && box.right <= plot.right + 1 && box.top >= plot.top - 1 && box.bottom <= plot.bottom + 1) };
      });
      expect(geometry.content.every(item => item.textFits && item.left >= geometry.left - 1 && item.right <= geometry.right + 1)).toBe(true);
      expect(geometry.ticksFit, "both unit axes fit inside the chart").toBe(true);
      expect(geometry.scroll.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(geometry.scroll.right).toBeLessThanOrEqual(geometry.right + 1);
      if (geometry.scroll.contentWidth > geometry.scroll.width + 1) {
        const viewport = card.getByRole("region", { name: "混合图横向滚动区域", exact: true });
        await expect(viewport).toHaveAttribute("data-combined-overflow", "true");
        await expect(viewport).toHaveAccessibleDescription("可左右滑动或聚焦滚动区域查看完整图表。");
      }
      await capture(card, info, `combined-mobile-320-${font}`);
      await record(page, info, { scenario: "combined-mobile", font, geometry });
    }
  });
});

test("combined zero and sparse days retain distinct money and order values across New Year", async ({ page, manifest }, info) => {
  let scenario: Scenario = "zero";
  const fixture = await mockAnalytics(page, () => scenario);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  const card = trendCard(page);
  await expect(card.locator('[data-slot="chart"]')).toBeVisible();
  await card.getByRole("combobox", { name: "统计周期", exact: true }).click();
  await page.getByRole("option", { name: "近 7 天", exact: true }).click();
  await expect.poll(() => fixture.responses.has(7)).toBe(true);
  await expect(card).toHaveAttribute("aria-busy", "false");
  await card.getByRole("button", { name: "金额与订单", exact: true }).click();
  const plot = await expectCombined(card, fixture.responses.get(7)!);
  const zeros = await plot.locator(".recharts-bar-rectangle .recharts-rectangle").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(zeros.every(height => height === 0)).toBe(true);
  await expectTooltip(await showTooltip(page, plot), 0, 0);
  await capture(card, info, "combined-zero");

  scenario = "sparse";
  await page.reload();
  await expect(card.locator('[data-slot="chart"]')).toBeVisible();
  await card.getByRole("button", { name: "金额与订单", exact: true }).click();
  await expectCombined(card, fixture.responses.get(7)!);
  await expectTooltip(await tooltipAtDate(page, plot, SPARSE_DATE, 7), 1, 0);
  await expect(plot.locator("text.trend-combined-amount-tick").filter({ hasText: "¥0.01" })).toHaveCount(1);
  await expectTooltip(await tooltipAtDate(page, plot, TODAY, 7), 0, 17);
  await capture(card, info, "combined-sparse");
  await record(page, info, { scenario: "combined-zero-and-sparse", zeroBarHeights: zeros, amountDate: SPARSE_DATE, orderDate: TODAY });
});
