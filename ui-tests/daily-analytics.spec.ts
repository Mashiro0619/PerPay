import type { Page } from "@playwright/test";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";

const ANALYTICS = "**/api/admin/v1/system/analytics?*";
const DAY = 86_400_000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

function selectedRange(url: string): SystemAnalytics["range_days"] {
  const value = Number(new URL(url).searchParams.get("range"));
  if (value !== 7 && value !== 30 && value !== 90) throw new Error(`Unexpected analytics range: ${value}`);
  return value;
}

function dailyFixture(base: SystemAnalytics, range: SystemAnalytics["range_days"], end = "2026-01-04", scenario: "normal" | "large" | "zero" | "empty" = "normal"): SystemAnalytics {
  const endDate = Date.parse(end + "T00:00:00.000Z");
  const daily = scenario === "empty" ? [] : Array.from({ length: range }, (_, index) => {
    const distance = range - index - 1;
    return {
      date: new Date(endDate - distance * DAY).toISOString().slice(0, 10),
      confirmed_amount_cents: scenario === "zero" ? 0 : scenario === "large" && distance === 3 ? 2_000_000_000_000_000 : [100000, 99900, 50000, 0, 140000, 32000, 20000][distance % 7]!,
      confirmations: scenario === "zero" ? 0 : distance + 1,
      orders_created: scenario === "zero" ? 0 : distance + 3,
      notifications_acknowledged: 0,
      notifications_failed: 0,
    };
  });
  return {
    ...base,
    range_days: range,
    from: new Date(endDate - (range - 1) * DAY - BEIJING_OFFSET).toISOString(),
    to: new Date(endDate + DAY - BEIJING_OFFSET).toISOString(),
    daily,
    // Keep an independent authoritative total so pagination cannot accidentally sum its page.
    confirmations: { count: daily.reduce((sum, day) => sum + day.confirmations, 0), amount_cents: scenario === "zero" ? 0 : 7654321 },
  };
}

async function showDaily(page: Page) {
  await page.getByRole("tab", { name: "每日数据", exact: true }).click();
  await expect(page.getByRole("region", { name: "每日数据", exact: true })).toBeVisible();
}

function report(page: Page) {
  return page.getByRole("region", { name: "每日数据", exact: true });
}

async function visibleDates(page: Page) {
  return report(page).locator(".daily-date time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")));
}

async function range(page: Page, days: number) {
  await page.getByRole("button", { name: `近 ${days} 天`, exact: true }).click();
  await expect(report(page).locator('[role="status"]')).toContainText(`共 ${days} 天`);
}

test("daily pagination keeps every date, interval totals and bar scales without additional reads", async ({ page, manifest }, info) => {
  let reads = 0;
  const fixtures = new Map<number, SystemAnalytics>();
  await page.route(ANALYTICS, async route => {
    reads++;
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    const days = selectedRange(route.request().url());
    const fixture = dailyFixture(body.data, days);
    fixtures.set(days, fixture);
    await route.fulfill({ response, json: { data: fixture } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  await showDaily(page);

  for (const days of [30, 90, 7]) {
    if (days !== 30) await range(page, days);
    const current = report(page);
    await expect(current.locator("table")).toHaveCount(1);
    await expect(current.getByRole("columnheader")).toHaveText(["日期", "确认金额", "确认笔数", "新建订单"]);
    await expect(current.getByText("全部展开", { exact: true })).toHaveCount(0);
    await expect(current.getByText("全部收起", { exact: true })).toHaveCount(0);
    const expected = [...fixtures.get(days)!.daily].reverse();
    const totals = await current.locator("[data-daily-summary]").allTextContents();
    await expect(current.locator('[data-daily-summary="total"]')).toContainText("¥76,543.21");
    const beforePaging = reads;
    const observed: (string | null)[] = [];
    const numberOfPages = Math.ceil(days / 10);
    const pager = current.getByRole("navigation", { name: "每日数据分页", exact: true });

    if (days === 7) {
      await expect(current.locator('[role="status"]')).toHaveText("共 7 天");
      await expect(pager).toHaveCount(0);
    } else {
      await expect(pager.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    }
    for (let index = 0; index < numberOfPages; index++) {
      if (days !== 7) await expect(current.locator('[role="status"]')).toHaveText(`第 ${index + 1}/${numberOfPages} 页 · 共 ${days} 天`);
      const dates = await visibleDates(page);
      expect(dates).toEqual(expected.slice(index * 10, (index + 1) * 10).map(day => day.date));
      observed.push(...dates);
      expect(await current.locator("[data-daily-summary]").allTextContents()).toEqual(totals);
      const bars = await current.locator(".daily-amount-bar").evaluateAll(elements => elements.map(element => ({
        date: element.getAttribute("data-date"), track: element.getBoundingClientRect().width,
        fill: element.querySelector("[data-daily-bar-fill]")!.getBoundingClientRect().width,
      })));
      const maximum = Math.max(...expected.map(day => day.confirmed_amount_cents));
      for (const bar of bars) {
        expect(bar.track).toBeCloseTo(64, 1);
        expect(bar.fill).toBeCloseTo(64 * expected.find(day => day.date === bar.date)!.confirmed_amount_cents / maximum, 1);
      }
      if (days === 30 && index === 0) await screenshot(page, info, "daily-normal-1440-first-page");
      if (index < numberOfPages - 1) await pager.getByRole("button", { name: "下一页", exact: true }).click();
    }
    expect(observed).toHaveLength(days);
    expect(new Set(observed).size).toBe(days);
    expect(reads).toBe(beforePaging);
    if (days !== 7) await expect(pager.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
    await record(page, info, { days, expectedDates: expected.map(day => day.date), observed, reads, totals });
  }
  await page.getByRole("button", { name: "统计口径", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "统计口径" })).not.toContainText("按周");
  await expect(page.getByRole("dialog", { name: "统计口径" })).toContainText("北京时间");
});

test("daily page survives tabs, resizing and refresh but resets for site, period and Beijing midnight", async ({ page, manifest }, info) => {
  let midnight = false;
  let reads = 0;
  await page.route(ANALYTICS, async route => {
    reads++;
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    const days = selectedRange(route.request().url());
    await route.fulfill({ response, json: { data: dailyFixture(body.data, days, midnight ? "2026-01-05" : "2026-01-04") } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  await showDaily(page);
  const current = report(page);
  const status = current.locator('[role="status"]');
  const next = current.getByRole("button", { name: "下一页", exact: true });
  const previous = current.getByRole("button", { name: "上一页", exact: true });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("第 2/3 页 · 共 30 天");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("第 3/3 页 · 共 30 天");
  await expect(next).toBeDisabled();
  const lastPageFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 60) }));
  await page.keyboard.press("Shift+Tab");
  await expect(previous).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("第 2/3 页 · 共 30 天");
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("第 1/3 页 · 共 30 天");
  await expect(previous).toBeDisabled();
  const firstPageFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 60) }));
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("第 2/3 页 · 共 30 天");
  const dates = await visibleDates(page);
  const beforePresentation = reads;
  await page.getByRole("tab", { name: "图表", exact: true }).click();
  await expect(page.locator('[data-slot="chart"]')).toBeVisible();
  await showDaily(page);
  await expect(status).toHaveText("第 2/3 页 · 共 30 天");
  await page.getByRole("button", { name: "切换为全屏布局", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(current.locator(".daily-mobile-list")).toBeVisible();
  expect(await visibleDates(page)).toEqual(dates);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(current.locator("table")).toBeVisible();
  expect(await visibleDates(page)).toEqual(dates);
  expect(reads).toBe(beforePresentation);

  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => reads).toBeGreaterThan(beforePresentation);
  await expect(refresh).toBeEnabled();
  await expect(status).toHaveText("第 2/3 页 · 共 30 天");
  midnight = true;
  const beforeMidnight = reads;
  await refresh.click();
  await expect.poll(() => reads).toBeGreaterThan(beforeMidnight);
  await expect(status).toHaveText("第 1/3 页 · 共 30 天");
  await next.click();
  await range(page, 90);
  await expect(status).toHaveText("第 1/9 页 · 共 90 天");
  await next.click();

  const sitePath = manifest.routes.find(path => /^\/sites\/[^/]+$/.test(path) && !["/sites/new", "/sites/defaults"].includes(path))!;
  await page.getByRole("list", { name: "业务网站列表", exact: true }).locator(`a[href^="/admin${sitePath}?"]`).click();
  await expect(page).toHaveURL(new RegExp(sitePath));
  await showDaily(page);
  await expect(report(page).locator('[role="status"]')).toContainText("第 1/");
  await record(page, info, { preservedDates: dates, reads, midnightReset: true, keyboardPagination: true, keyboardBoundaryFocus: { lastPageFocus, firstPageFocus }, sitePath });
});

test("daily table and mobile summaries keep fixed bars and complete large values in all supported layouts", async ({ page, manifest }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(ANALYTICS, async route => {
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    const days = selectedRange(route.request().url());
    await route.fulfill({ response, json: { data: dailyFixture(body.data, days, "2026-01-04", "large") } });
  });
  await login(page, manifest);
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"]) for (const mode of ["compact", "full"]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, { theme, mode });
    await page.goto(manifest.origin + "/admin/");
    await showDaily(page);
    const current = report(page);
    await expect(current.locator('[role="status"]')).toHaveText("第 1/3 页 · 共 30 天");
    await expect(current.locator(".daily-date time")).toHaveCount(10);
    await expect(current.locator(".daily-date time").first()).toHaveText("2026-01-04");
    await expect(current.getByText("今日", { exact: true })).toBeVisible();
    await expect(current.getByText("¥20,000,000,000,000.00", { exact: true }).last()).toBeVisible();
    await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
    const geometry = await current.evaluate(element => {
      const mobile = element.querySelector(".daily-mobile-list");
      const table = element.querySelector("table");
      const values = [...element.querySelectorAll(".list-money")].filter(value => value.getBoundingClientRect().width > 0);
      const bars = [...element.querySelectorAll(".daily-amount-bar")].map(bar => ({ width: bar.getBoundingClientRect().width, display: getComputedStyle(bar).display }));
      return {
        container: element.getBoundingClientRect().width,
        mobile: !!mobile && mobile.getBoundingClientRect().width > 0,
        table: !!table && table.getBoundingClientRect().width > 0,
        heads: table?.querySelectorAll("thead").length ?? 0,
        rows: table?.querySelectorAll("tbody tr").length ?? mobile?.children.length,
        bars,
        clipped: values.filter(value => value.scrollWidth > value.clientWidth + 1 || value.scrollHeight > value.clientHeight + 1).map(value => value.textContent),
        amounts: [...element.querySelectorAll(".daily-amount")].map(amount => {
          const numeric = amount.querySelector(".list-money")!.getBoundingClientRect();
          const bar = amount.querySelector("svg")!.getBoundingClientRect();
          return { gap: numeric.left - bar.right, right: numeric.right };
        }),
      };
    });
    expect(geometry.mobile).toBe(geometry.container < 640);
    expect(geometry.table).toBe(geometry.container >= 640);
    expect(geometry.rows).toBe(10);
    expect(geometry.clipped).toEqual([]);
    if (geometry.table) {
      expect(geometry.heads).toBe(1);
      expect(geometry.bars).toHaveLength(10);
      expect(geometry.bars.every(bar => Math.abs(bar.width - 64) < .1)).toBe(true);
      expect(geometry.amounts.every(amount => amount.gap >= 8 && amount.gap <= 16)).toBe(true);
      expect(geometry.amounts.every(amount => Math.abs(amount.right - geometry.amounts[0]!.right) < .1)).toBe(true);
    } else expect(geometry.bars.every(bar => bar.width === 0 || bar.display === "none")).toBe(true);
    await record(page, info, { width, theme, mode, dailyGeometry: geometry, syntheticLargeValue: true });
    await screenshot(page, info, `daily-${width}-${theme}-${mode}`);
  }
  expect(errors).toEqual([]);
  await audit(page, info, "daily-table");
});

test("daily data separates loading, failures, empty series and valid zero days through fast range changes", async ({ page, manifest }, info) => {
  let scenario: "normal" | "zero" | "empty" | "error" = "normal";
  let hold90 = false;
  let release90 = () => {};
  let holding90 = Promise.resolve();
  await page.route(ANALYTICS, async route => {
    const days = selectedRange(route.request().url());
    const response = await route.fetch();
    const body = await response.json() as { data: SystemAnalytics };
    if (days === 90 && hold90) await holding90;
    if (scenario === "error") {
      await route.fulfill({ status: 503, json: { error: { code: "synthetic_analytics_unavailable", message: "统计读取失败" } } });
    } else await route.fulfill({ response, json: { data: dailyFixture(body.data, days, "2026-01-04", scenario) } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  await showDaily(page);
  const current = report(page);
  await current.getByRole("button", { name: "下一页", exact: true }).click();
  hold90 = true;
  holding90 = new Promise<void>(resolve => { release90 = resolve; });
  await page.getByRole("button", { name: "近 90 天", exact: true }).click();
  await expect(current).toHaveAttribute("aria-busy", "true");
  await expect(current.locator(".daily-date time")).toHaveCount(0);
  await expect(current.locator("[data-daily-summary]")).toHaveCount(0);
  await range(page, 7);
  release90();
  await expect(current.locator('[role="status"]')).toHaveText("共 7 天");
  await expect(current.locator(".daily-date time")).toHaveCount(7);
  hold90 = false;

  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  const retainedDates = await current.locator(".daily-date time").allTextContents();
  const retainedSummary = await current.locator("[data-daily-summary]").allTextContents();
  scenario = "error";
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByText("统计读取失败", { exact: true })).toBeVisible();
  await expect(page.getByText("更新未完成，以下保留上次成功读取的内容。", { exact: true })).toBeVisible();
  expect(await current.locator(".daily-date time").allTextContents()).toEqual(retainedDates);
  expect(await current.locator("[data-daily-summary]").allTextContents()).toEqual(retainedSummary);
  scenario = "empty";
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(current.getByText("暂无每日数据", { exact: true })).toBeVisible();
  await expect(current.locator(".daily-date time")).toHaveCount(0);
  scenario = "zero";
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(current.locator(".daily-date time")).toHaveCount(7);
  await expect(current.getByText("暂无每日数据", { exact: true })).toHaveCount(0);
  const zeros = await current.locator("[data-daily-bar-fill]").evaluateAll(elements => elements.map(element => element.getAttribute("width")));
  expect(zeros).toEqual(Array(7).fill("0"));
  await record(page, info, { fastRangeChange: true, failedThenRecovered: true, emptyDistinctFromZero: true, zeroFillWidths: zeros });
});
