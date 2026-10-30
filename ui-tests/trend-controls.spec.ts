import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";

const chartTypes = [["AREA", "面积图"], ["BAR", "柱状图"], ["LINE", "折线图"]] as const;
const periods = [[7, "近 7 天"], [90, "近 90 天"], [30, "近 30 天"]] as const;

function trendCard(page: Page) {
  return page.locator(".trend-card").filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
}

async function ready(page: Page, card: Locator) {
  await expect(card).toHaveAttribute("aria-busy", "false");
  await expect(card.locator("[data-metric-value]")).not.toBeEmpty();
  await page.clock.runFor(100);
  await page.evaluate(() => document.fonts.ready);
}

async function bounds(target: Locator) {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  return { ...box, right: box.x + box.width, bottom: box.y + box.height };
}

async function sameRow(targets: Locator[]) {
  const boxes = await Promise.all(targets.map(bounds));
  const overlap = Math.min(...boxes.map(box => box.bottom)) - Math.max(...boxes.map(box => box.y));
  expect(overlap, "the controls share a visible row").toBeGreaterThan(Math.min(...boxes.map(box => box.height)) / 2);
  for (let index = 1; index < boxes.length; index++) {
    expect(boxes[index - 1]!.right, "controls stay in their requested left-to-right order without overlap").toBeLessThanOrEqual(boxes[index]!.x + 1);
  }
  return boxes;
}

async function containedControls(card: Locator) {
  const geometry = await card.evaluate(element => {
    const rect = (target: Element) => {
      const value = target.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const frame = rect(element);
    const containers = [...element.querySelectorAll(".trend-controls, .trend-context")].map(container => ({ name: container.className, ...rect(container) }));
    const controls = [...element.querySelectorAll(".trend-controls button, .trend-context button")]
      .filter(control => control.getBoundingClientRect().width > 0 && control.getBoundingClientRect().height > 0)
      .map(control => {
        const box = rect(control);
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        const lines: { left: number; right: number; top: number; bottom: number }[] = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim() || walker.currentNode.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          lines.push(...[...range.getClientRects()].map(line => ({ left: line.left, right: line.right, top: line.top, bottom: line.bottom })));
        }
        return { name: control.getAttribute("aria-label") ?? control.textContent, ...box, textLines: new Set(lines.map(line => Math.round(line.top))).size, textFits: lines.every(line => line.left >= box.left - 1 && line.right <= box.right + 1 && line.top >= box.top - 1 && line.bottom <= box.bottom + 1) };
      });
    const dates = element.querySelector(".trend-context .trend-dates")!;
    const dateBox = rect(dates);
    const range = document.createRange();
    range.selectNodeContents(dates);
    const dateTextFits = [...range.getClientRects()].every(line => line.left >= dateBox.left - 1 && line.right <= dateBox.right + 1 && line.top >= dateBox.top - 1 && line.bottom <= dateBox.bottom + 1);
    const dateTokens = [...dates.querySelectorAll("time")].map(date => {
      const token = document.createRange();
      token.selectNodeContents(date);
      return { date: date.textContent, textLines: new Set([...token.getClientRects()].map(line => Math.round(line.top))).size };
    });
    return { frame, containers, controls, dateBox, dateTextFits, dateTokens };
  });
  expect(geometry.containers).toHaveLength(2);
  expect(geometry.controls.length).toBeGreaterThanOrEqual(8);
  for (const control of [...geometry.containers, ...geometry.controls]) {
    expect(control.left, `${control.name}: stays within the card`).toBeGreaterThanOrEqual(geometry.frame.left - 1);
    expect(control.right, `${control.name}: stays within the card`).toBeLessThanOrEqual(geometry.frame.right + 1);
  }
  expect(geometry.controls.filter(control => !control.textFits), "every control retains its complete label").toEqual([]);
  expect(geometry.dateTextFits, "the date range can wrap without clipping").toBe(true);
  expect(geometry.dateTokens).toHaveLength(2);
  expect(geometry.dateTokens.every(token => token.textLines === 1), "the range wraps between dates instead of splitting an individual date").toBe(true);
  for (let i = 0; i < geometry.controls.length; i++) for (let j = i + 1; j < geometry.controls.length; j++) {
    const first = geometry.controls[i]!, second = geometry.controls[j]!;
    const horizontal = Math.min(first.right, second.right) - Math.max(first.left, second.left);
    const vertical = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
    expect(horizontal > 1 && vertical > 1, `${first.name} and ${second.name} do not overlap`).toBe(false);
  }
  return geometry;
}

async function capture(card: Locator, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await card.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function activate(target: Locator, page: Page, touch: boolean) {
  if (touch) {
    await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
    await page.clock.runFor(50);
    await target.tap();
  } else await target.click();
}

async function exerciseControls(page: Page, card: Locator, touch: boolean) {
  const plot = card.locator('[data-slot="chart"]');
  for (const [days, name] of periods) {
    const select = card.getByRole("combobox", { name: "统计周期", exact: true });
    if (await select.isVisible()) {
      await activate(select, page, touch);
      await activate(page.getByRole("option", { name, exact: true }), page, touch);
      await expect(select).toContainText(name);
    } else {
      const choice = card.getByRole("group", { name: "统计周期", exact: true }).getByRole("button", { name, exact: true });
      await activate(choice, page, touch);
      await expect(choice).toHaveAttribute("aria-pressed", "true");
    }
    await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe(String(days));
    await ready(page, card);
  }
  for (const [type, name] of chartTypes) {
    const choice = card.getByRole("group", { name: "图表类型", exact: true }).getByRole("button", { name, exact: true });
    await activate(choice, page, touch);
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(plot).toHaveAttribute("data-chart-type", type);
  }
  const metrics = card.getByRole("group", { name: "趋势指标", exact: true });
  for (const name of ["新建订单", "确认金额"]) {
    const choice = metrics.getByRole("button", { name, exact: true });
    await activate(choice, page, touch);
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    await expect(plot).toHaveAttribute("aria-label", name === "新建订单" ? /每日新建订单/ : /每日付款确认金额/);
  }
  await activate(card.getByRole("tab", { name: "每日数据", exact: true }), page, touch);
  await expect(card.getByRole("region", { name: "每日数据", exact: true })).toBeVisible();
  await activate(card.getByRole("tab", { name: "图表", exact: true }), page, touch);
  await expect(plot).toHaveAttribute("data-chart-type", "LINE");
}

for (const width of [1440, 1920]) {
  test(`${width}px: trend control groups and the date context share their own rows when space is available`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.addInitScript(() => {
      localStorage.setItem("perpay:content-width", "full");
      localStorage.setItem("perpay:theme", "dark");
    });
    await login(page, manifest);
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');
    if (await sidebar.getAttribute("data-state") === "expanded") await page.getByRole("button", { name: "切换导航", exact: true }).click();
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    const card = trendCard(page);
    await ready(page, card);
    const controls = card.locator(".trend-controls");
    const groups = await sameRow([
      controls.getByRole("group", { name: "统计周期", exact: true }),
      controls.getByRole("tablist", { name: "收款趋势视图", exact: true }),
      controls.getByRole("group", { name: "图表类型", exact: true }),
    ]);
    const heading = await sameRow([card.locator(".trend-title"), controls]);
    const context = card.locator(".trend-context");
    const contextRow = await sameRow([context.locator(".trend-dates"), context.getByRole("group", { name: "趋势指标", exact: true })]);
    const fit = await containedControls(card);
    expect(fit.controls.filter(control => control.textLines > 1), "wide controls retain their labels on one line instead of compressing the text").toEqual([]);
    await capture(card, info, `trend-card-${width}`);
    await record(page, info, { feature: "trend-controls-same-row", width, groups, heading, contextRow, fit });

    if (width === 1440) {
      const writes: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname);
      });
      await exerciseControls(page, card, false);
      await page.reload();
      await ready(page, card);
      await expect(card.getByRole("button", { name: "折线图", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(card.locator('[data-slot="chart"]')).toHaveAttribute("data-chart-type", "LINE");
      expect(writes, "presentation choices stay local instead of saving server settings").toEqual([]);
    }
  });
}

test.describe("trend controls reflow on phones", () => {
  test.use({ hasTouch: true, isMobile: true, reducedMotion: "reduce" });

  for (const width of [320, 390]) for (const font of [100, 200]) {
    test(`${width}px at ${font}% text: controls wrap, retain complete labels and remain operable`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await login(page, manifest);
      const card = trendCard(page);
      await ready(page, card);
      await page.evaluate(value => { document.documentElement.style.fontSize = value + "%"; }, font);
      await page.clock.runFor(100);
      const fit = await containedControls(card);
      await record(page, info, { feature: "trend-controls-mobile-reflow", width, font, fit });
      await capture(font === 200 ? card.locator(".trend-header") : card, info, `trend-${font === 200 ? "header" : "card"}-${width}-text-${font}`);
      await exerciseControls(page, card, true);
      await containedControls(card);
      await record(page, info, { feature: "trend-controls-mobile-after-actions", width, font });
    });
  }
});
