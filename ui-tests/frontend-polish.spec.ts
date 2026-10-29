import type { Page, TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance as hostPerformance } from "node:perf_hooks";
import { test, expect, login, record, type Manifest } from "./fixtures";
import type { SystemAnalytics } from "../web/src/api/generated/types.gen";
import { measureSelectionContrast } from "./contrast-evidence";
import { setDateOnly } from "./fixed-date";

const phase = process.env.PERPAY_POLISH_PHASE ?? "final";
if (phase !== "baseline" && phase !== "final") throw new Error("PERPAY_POLISH_PHASE must be baseline or final");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const assetsIn = (html: string) => [...new Set([...html.matchAll(/(?:src|href)="(\/admin\/assets\/[^"?#]+)"/g)].map(match => match[1]!))].sort();
// Capture before the worker starts its server. Later edits/builds must not be
// attributed to the already running fixture, which serves assets from memory.
const indexAtStart = readFileSync("web-dist/admin/index.html", "utf8");
const servedBuild = {
  phase,
  declaredBaseline: phase === "baseline" ? "8dcac3d" : null,
  checkoutAtStart: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDiffAtStart: sha256(execFileSync("git", ["-c", "core.safecrlf=false", "diff", "--binary", "HEAD", "--", "src", "web", "scripts"], { stdio: ["ignore", "pipe", "ignore"] })),
  adminIndexAtStart: sha256(indexAtStart),
  checkoutManifestAtStart: sha256(readFileSync("web-dist/checkout/.vite/manifest.json")),
  assetsAtStart: assetsIn(indexAtStart),
};

type Probe = {
  active: boolean;
  startedAt: number;
  frames: number[];
  longTasks: { start: number; duration: number }[];
  shifts: { value: number; recentInput: boolean }[];
  supported: string[];
};
type ProbeWindow = Window & { __perpayPolish?: Probe };

function installProbe() {
  const probe: Probe = {
    active: false, startedAt: 0, frames: [], longTasks: [], shifts: [],
    supported: typeof PerformanceObserver === "undefined" ? [] : [...PerformanceObserver.supportedEntryTypes],
  };
  (window as ProbeWindow).__perpayPolish = probe;
  let previous: number | undefined;
  function frame(now: number) {
    if (probe.active) {
      if (previous !== undefined && probe.frames.length < 10_000) probe.frames.push(now - previous);
      previous = now;
    } else previous = undefined;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (probe.supported.includes("longtask")) new PerformanceObserver(list => {
    if (probe.active) for (const entry of list.getEntries()) {
      if (entry.startTime >= probe.startedAt) probe.longTasks.push({ start: entry.startTime - probe.startedAt, duration: entry.duration });
    }
  }).observe({ type: "longtask" });
  if (probe.supported.includes("layout-shift")) new PerformanceObserver(list => {
    if (probe.active) for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      if (entry.startTime >= probe.startedAt) probe.shifts.push({ value: shift.value, recentInput: shift.hadRecentInput });
    }
  }).observe({ type: "layout-shift" });
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]! : null;
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), maximum: sorted.at(-1) ?? null, over33ms: sorted.filter(value => value > 33.4).length };
}

async function settle(page: Page) {
  await expect(page.locator("#main-content")).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function observe(page: Page, name: string, action: () => Promise<void>) {
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__perpayPolish!;
    probe.frames = []; probe.longTasks = []; probe.shifts = [];
    probe.startedAt = performance.now(); probe.active = true;
  });
  await action();
  await page.waitForTimeout(350);
  const sample = await page.evaluate(() => {
    const probe = (window as ProbeWindow).__perpayPolish!;
    probe.active = false;
    return { duration: performance.now() - probe.startedAt, frames: probe.frames, longTasks: probe.longTasks, shifts: probe.shifts, supported: probe.supported };
  });
  return { name, ...sample, frameDistribution: distribution(sample.frames), longTaskDistribution: distribution(sample.longTasks.map(task => task.duration)) };
}

async function checkpoint(page: Page, info: TestInfo, name: string, videoOffset: number) {
  await settle(page);
  const imagePath = info.outputPath(`${phase}-${name}.png`);
  await page.screenshot({ path: imagePath, fullPage: true });
  await info.attach(`${phase}-${name}`, { path: imagePath, contentType: "image/png" });
  const geometry = await page.evaluate(() => {
    const bounds = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      documentWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      heading: document.querySelector("#main-content h1")?.textContent,
      main: bounds(document.querySelector("[data-content-width]")),
      title: bounds(document.querySelector("[data-page-heading]")),
      cards: [...document.querySelectorAll('#main-content [data-slot="card"]')].map(card => ({ title: card.querySelector('[data-slot="card-title"]')?.textContent, bounds: bounds(card) })),
      sidebar: document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute("data-state") ?? "mobile-drawer",
      fontStatus: document.fonts.status,
    };
  });
  expect(geometry.overflow, `${name}: page remains within its viewport`).toBe(false);
  return { name, image: `${phase}-${name}.png`, url: new URL(page.url()).pathname + new URL(page.url()).search, approximateVideoOffsetMilliseconds: videoOffset, ...geometry };
}

async function navigateToOrders(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: "切换导航", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "导航菜单", exact: true })).toBeVisible();
  }
  await page.getByRole("navigation", { name: "主导航", exact: true }).locator('a[href^="/admin/orders"]').click();
  await expect(page).toHaveURL(/\/admin\/orders(?:\?|$)/);
  await settle(page);
}

async function refreshOverview(page: Page, manifest: Manifest, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "页面操作", exact: true }).click();
  const response = page.waitForResponse(response => response.url().startsWith(manifest.origin + "/api/admin/v1/system/analytics?") && response.ok());
  if (mobile) await page.getByRole("menuitem", { name: "刷新", exact: true }).click();
  else await page.getByRole("button", { name: "刷新", exact: true }).click();
  await response;
  if (mobile) await page.keyboard.press("Escape");
  await settle(page);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${phase} ${viewport.width}: console screenshots, interaction video and native timing observations`, async ({ browser, manifest }, info) => {
    test.setTimeout(180_000);
    const mobile = viewport.width < 1024;
    // The standard page fixture mocks rAF. This context fixes only Date and
    // uses native animation/performance timers; server business time is fixed.
    const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", colorScheme: "light", reducedMotion: "no-preference", hasTouch: mobile, isMobile: mobile, recordVideo: { dir: info.outputPath("video"), size: viewport } });
    const page = await context.newPage();
    const video = page.video();
    const began = hostPerformance.now();
    const checkpoints: Awaited<ReturnType<typeof checkpoint>>[] = [];
    const observations: Awaited<ReturnType<typeof observe>>[] = [];
    const errors: string[] = [];
    const cspErrors: string[] = [];
    const requests: { path: string; method: string }[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /content security|violat.*directive|refused to/i.test(message.text())) cspErrors.push(message.text()); });
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) requests.push({ path: url.pathname + url.search, method: request.method() });
    });
    await setDateOnly(page, manifest.epoch);
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.addInitScript(() => {
      if (!localStorage.getItem("perpay:theme")) localStorage.setItem("perpay:theme", "light");
      localStorage.setItem("perpay:content-width", "compact");
      localStorage.setItem("perpay:list-density", "compact");
    });
    await page.addInitScript(installProbe);
    const capture = async (name: string) => checkpoints.push(await checkpoint(page, info, `${viewport.width}-${name}`, hostPerformance.now() - began));
    try {
      await login(page, manifest);
      const html = await (await page.request.get(manifest.origin + "/admin/")).text();
      expect(assetsIn(html), "fixture loaded the captured build, independent of subsequent workspace edits").toEqual(servedBuild.assetsAtStart);
      console.log(`PERPAY_POLISH_READY phase=${phase} width=${viewport.width} origin=${manifest.origin} build=${servedBuild.adminIndexAtStart}`);
      await capture("overview-light");

      observations.push(await observe(page, "sidebar-open-close", async () => {
        const toggle = page.getByRole("button", { name: "切换导航", exact: true });
        if (mobile) {
          await toggle.click();
          await expect(page.getByRole("dialog", { name: "导航菜单", exact: true })).toBeVisible();
          await page.waitForTimeout(250);
          await page.getByRole("button", { name: "关闭导航", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "导航菜单", exact: true })).toBeHidden();
        } else {
          const sidebar = page.locator('[data-slot="sidebar"][data-state]');
          await toggle.click();
          await expect(sidebar).toHaveAttribute("data-state", "collapsed");
          await page.waitForTimeout(250);
          await toggle.click();
          await expect(sidebar).toHaveAttribute("data-state", "expanded");
        }
      }));

      const trend = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
      await trend.getByRole("group", { name: "图表类型", exact: true }).scrollIntoViewIfNeeded();
      observations.push(await observe(page, "chart-and-metric-switching", async () => {
        for (const [type, label] of [["BAR", "柱状图"], ["LINE", "折线图"], ["AREA", "面积图"]] as const) {
          await trend.getByRole("button", { name: label, exact: true }).click();
          await expect(trend.locator('[data-slot="chart"]')).toHaveAttribute("data-chart-type", type!);
          await page.waitForTimeout(200);
        }
        await trend.getByRole("button", { name: "新建订单", exact: true }).click();
        await expect(trend.getByRole("button", { name: "新建订单", exact: true })).toHaveAttribute("aria-pressed", "true");
        await page.waitForTimeout(200);
        await trend.getByRole("button", { name: "确认金额", exact: true }).click();
      }));
      observations.push(await observe(page, "daily-view-and-page-retention", async () => {
        await trend.getByRole("tab", { name: "每日数据", exact: true }).click();
        const daily = trend.getByRole("region", { name: "每日数据", exact: true });
        await daily.getByRole("button", { name: "下一页", exact: true }).click();
        await expect(daily.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
        await trend.getByRole("tab", { name: "图表", exact: true }).click();
        await page.waitForTimeout(200);
        await trend.getByRole("tab", { name: "每日数据", exact: true }).click();
        await expect(daily.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
      }));
      await capture("daily-page-two");
      await trend.getByRole("tab", { name: "图表", exact: true }).click();
      observations.push(await observe(page, "overview-refresh", () => refreshOverview(page, manifest, mobile)));

      observations.push(await observe(page, "navigate-to-orders", () => navigateToOrders(page, mobile)));
      await expect(page.locator("[data-business-row]").first()).toBeVisible();
      await capture("orders");
      const order = page.locator('[data-business-table="orders"] a[data-row-link]').first();
      const selectedOrder = { title: await order.innerText(), href: await order.getAttribute("href") };
      observations.push(await observe(page, "open-order-detail", async () => {
        await order.click();
        await expect(page).toHaveURL(/\/admin\/orders\/[^/?]+/);
        await settle(page);
      }));
      await capture("order-detail");
      observations.push(await observe(page, "return-to-orders", async () => {
        await page.goBack();
        await expect(page).toHaveURL(/\/admin\/orders(?:\?|$)/);
        await settle(page);
      }));

      await page.goto(manifest.origin + "/admin/settings/display");
      await capture("settings-display");
      await page.evaluate(() => localStorage.setItem("perpay:theme", "dark"));
      await page.goto(manifest.origin + "/admin/");
      await expect(page.locator("html")).toHaveClass(/dark/);
      await capture("overview-dark");
      expect(errors).toEqual([]);
      expect(cspErrors).toEqual([]);

      const evidence = {
        schemaVersion: 1, phase, viewport, serverEpoch: manifest.epoch, fixedDate: new Date(manifest.epoch).toISOString(),
        evidenceKind: mobile ? "Chromium mobile viewport and touch emulation; not physical-device acceptance" : "Chromium desktop browser",
        clockMode: "Only Date fixed during observations; native rAF, performance and timers. Video encoding and browser automation affect timing; distributions are diagnostics, not production performance claims.",
        servedBuild, selectedOrder, checkpoints, observations, requests, errors, cspErrors,
        video: `${phase}-${viewport.width}-journey.webm`,
      };
      const evidencePath = info.outputPath(`${phase}-${viewport.width}-evidence.json`);
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      await info.attach(`${phase}-evidence`, { path: evidencePath, contentType: "application/json" });
      // record() uses clock.runFor(). Install the complete fixture clock only
      // after native timing/video actions have finished; no further timing is sampled.
      await page.clock.install({ time: new Date(manifest.epoch) });
      await record(page, info, { phase, servedBuild, evidenceFile: `${phase}-${viewport.width}-evidence.json`, nativeTimingCollectedBeforeClockInstall: true });
    } catch (error) {
      const path = info.outputPath(`${phase}-${viewport.width}-failure.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      await info.attach("failure-state", { path, contentType: "image/png" }).catch(() => {});
      writeFileSync(info.outputPath("failure-context.txt"), await page.locator("body").innerText().catch(() => "Page unavailable"));
      throw error;
    } finally {
      await context.close();
      if (video) {
        const path = info.outputPath(`${phase}-${viewport.width}-journey.webm`);
        await video.saveAs(path);
        await info.attach(`${phase}-interaction-video`, { path, contentType: "video/webm" });
      }
    }
  });
}

if (phase === "final") {
  test("final: selection motion keeps immediate values, daily state and focus through rapid actions and live reduced motion", async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const errors: string[] = [];
    const cspErrors: string[] = [];
    let analyticsReads = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /content security|violat.*directive|refused to/i.test(message.text())) cspErrors.push(message.text()); });
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/v1/system/analytics") analyticsReads++; });
    const analyticsResponse = page.waitForResponse(response => response.url().startsWith(manifest.origin + "/api/admin/v1/system/analytics?") && response.ok());
    await login(page, manifest);
    const analytics = (await (await analyticsResponse).json() as { data: SystemAnalytics }).data;
    const expectedAmount = "¥" + (analytics.confirmations.amount_cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expectedOrders = analytics.orders.created.toLocaleString("zh-CN");
    const trend = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
    const metricGroup = trend.getByRole("group", { name: "趋势指标", exact: true });
    const typeGroup = trend.getByRole("group", { name: "图表类型", exact: true });
    const chartTab = trend.getByRole("tab", { name: "图表", exact: true });
    const dailyTab = trend.getByRole("tab", { name: "每日数据", exact: true });
    await expect(trend.locator("[data-selection-indicator]").first()).toHaveAttribute("data-selection-mode", "motion");
    const initialStyles = await page.locator("style").allTextContents();
    await page.evaluate(() => {
      const inserted: string[] = [];
      (window as Window & { __polishInsertedStyles?: string[] }).__polishInsertedStyles = inserted;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === "STYLE") inserted.push(node.outerHTML.slice(0, 300));
          for (const style of node.querySelectorAll("style")) inserted.push(style.outerHTML.slice(0, 300));
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
    const readsBefore = analyticsReads;
    // Sample the actual projected decoration, not only the chosen DOM state.
    const initialAmount = metricGroup.getByRole("button", { name: "确认金额", exact: true });
    const targetOrders = metricGroup.getByRole("button", { name: "新建订单", exact: true });
    await metricGroup.scrollIntoViewIfNeeded();
    await page.clock.runFor(300);
    const from = (await initialAmount.locator("[data-selection-indicator]").boundingBox())!;
    const target = (await targetOrders.boundingBox())!;
    await targetOrders.click({ force: true });
    expect(await targetOrders.getAttribute("aria-pressed")).toBe("true");
    expect(await trend.locator("[data-metric-value]").innerText()).toBe(expectedOrders);
    await page.clock.runFor(50);
    const during = (await targetOrders.locator("[data-selection-indicator]").boundingBox())!;
    expect(during.x, "indicator has left the old selection").toBeGreaterThan(from.x + 1);
    expect(during.x, "indicator visibly travels before reaching its new selection").toBeLessThan(target.x - 1);
    await page.clock.runFor(300);
    const after = (await targetOrders.locator("[data-selection-indicator]").boundingBox())!;
    expect(Math.abs(after.x - target.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - target.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.width - target.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.height - target.height)).toBeLessThanOrEqual(2);
    const indicatorGeometry = { from, target, during, after };
    const selectedPaint = await targetOrders.evaluate(measureSelectionContrast);
    expect(selectedPaint?.passed, "stable selection text remains readable on its verified opaque decoration").toBe(true);
    const selectedType = typeGroup.locator('[aria-pressed="true"]');
    const iconLabelPaint = await selectedType.evaluate(measureSelectionContrast);
    expect(iconLabelPaint?.passed, "the icon and label have separately verified paint and geometry").toBe(true);
    const typeLabel = selectedType.locator(':scope > span:not([data-selection-indicator])');
    await typeLabel.evaluate(element => (element as HTMLElement).style.opacity = "0.5");
    try {
      const invalidPaint = await selectedType.evaluate(measureSelectionContrast);
      expect(invalidPaint?.passed).toBe(false);
      expect(invalidPaint?.conflicts).toContain("unverified label paint");
    } finally {
      await typeLabel.evaluate(element => (element as HTMLElement).style.removeProperty("opacity"));
    }
    await selectedType.evaluate(element => element.append(document.createTextNode("额外未测文字")));
    try {
      expect((await selectedType.evaluate(measureSelectionContrast))?.conflicts).toContain("unmeasured direct text");
    } finally {
      await selectedType.evaluate(element => element.lastChild!.remove());
    }
    await typeLabel.evaluate(element => (element as HTMLElement).style.setProperty("-webkit-text-fill-color", "transparent"));
    try {
      expect((await selectedType.evaluate(measureSelectionContrast))?.conflicts).toContain("unverified text paint");
    } finally {
      await typeLabel.evaluate(element => (element as HTMLElement).style.removeProperty("-webkit-text-fill-color"));
    }
    const typeIcon = selectedType.locator(":scope > svg");
    await typeIcon.evaluate(element => (element as SVGElement).style.overflow = "visible");
    try {
      expect((await selectedType.evaluate(measureSelectionContrast))?.conflicts).toContain("unverified icon paint");
    } finally {
      await typeIcon.evaluate(element => (element as SVGElement).style.removeProperty("overflow"));
    }
    await initialAmount.click({ force: true });
    await page.clock.runFor(300);
    for (const [name, expected] of [["新建订单", expectedOrders], ["确认金额", expectedAmount], ["新建订单", expectedOrders], ["确认金额", expectedAmount]] as const) {
      const button = metricGroup.getByRole("button", { name, exact: true });
      await button.click({ force: true });
      expect(await button.getAttribute("aria-pressed"), "business selection is committed before the decorative animation finishes").toBe("true");
      const value = trend.locator("[data-metric-value]");
      expect(await value.count()).toBe(1);
      expect(await value.innerText()).toBe(expected);
      expect(await metricGroup.locator('[aria-pressed="true"]').count()).toBe(1);
      await page.clock.runFor(25);
    }
    for (const [type, label] of [["BAR", "柱状图"], ["LINE", "折线图"], ["AREA", "面积图"], ["LINE", "折线图"]] as const) {
      const button = typeGroup.getByRole("button", { name: label, exact: true });
      await button.click({ force: true });
      expect(await button.getAttribute("aria-pressed")).toBe("true");
      expect(await trend.locator('[data-slot="chart"]').getAttribute("data-chart-type")).toBe(type);
      expect(await trend.locator("[data-metric-value]").innerText()).toBe(expectedAmount);
      await page.clock.runFor(25);
    }
    await dailyTab.click();
    const daily = trend.getByRole("region", { name: "每日数据", exact: true });
    await daily.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(daily.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
    const dates = await daily.locator(".daily-date time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")));
    for (let index = 0; index < 2; index++) {
      await chartTab.click({ force: true });
      expect(await chartTab.getAttribute("aria-selected")).toBe("true");
      await page.clock.runFor(25);
      await dailyTab.click({ force: true });
      expect(await dailyTab.getAttribute("aria-selected")).toBe("true");
      await expect(daily.getByRole("status")).toHaveText("第 2/3 页 · 共 30 天");
      expect(await daily.locator(".daily-date time").evaluateAll(elements => elements.map(element => element.getAttribute("datetime")))).toEqual(dates);
      await page.clock.runFor(25);
    }
    await dailyTab.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(chartTab).toBeFocused();
    await expect(chartTab).toHaveAttribute("aria-selected", "true");
    const amount = metricGroup.getByRole("button", { name: "确认金额", exact: true });
    await amount.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const orders = metricGroup.getByRole("button", { name: "新建订单", exact: true });
    await expect(orders).toBeFocused();
    expect(await trend.locator("[data-metric-value]").innerText()).toBe(expectedOrders);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(trend.locator('[data-selection-indicator][data-selection-mode="motion"]')).toHaveCount(0);
    for (const group of await trend.locator("[data-selection-motion]").all()) {
      await expect(group.locator("[data-selection-indicator]")).toHaveCount(1);
      await expect(group.locator("[data-selection-indicator]")).toHaveAttribute("data-selection-mode", "static");
    }
    await expect(orders).toBeFocused();
    expect(await orders.getAttribute("aria-pressed")).toBe("true");
    expect(await trend.locator("[data-metric-value]").innerText()).toBe(expectedOrders);
    await page.clock.runFor(400);
    const runningAnimations = await trend.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length);
    expect(runningAnimations).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(trend.locator("[data-selection-indicator]").first()).toHaveAttribute("data-selection-mode", "motion");
    await expect(orders).toBeFocused();
    expect(analyticsReads).toBe(readsBefore);
    expect(await page.locator("style").allTextContents()).toEqual(initialStyles);
    const insertedStyles = await page.evaluate(() => (window as Window & { __polishInsertedStyles?: string[] }).__polishInsertedStyles ?? []);
    expect(insertedStyles).toEqual([]);
    expect(errors).toEqual([]);
    expect(cspErrors).toEqual([]);
    await record(page, info, { phase, scenario: "selection-motion-continuity", indicatorGeometry, selectedPaint, expectedAmount, expectedOrders, retainedDates: dates, analyticsReads, insertedStyles, errors, cspErrors, runningAnimationsAfterReducedMotion: runningAnimations });
  });
}
