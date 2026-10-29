import type { CDPSession, Locator, Page, TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test, expect, login } from "./fixtures";
import { setDateOnly } from "./fixed-date";

const phase = process.env.PERPAY_POLISH_PHASE ?? "final";
if (!["baseline", "final"].includes(phase)) throw new Error("Invalid PERPAY_POLISH_PHASE");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const index = readFileSync("web-dist/admin/index.html", "utf8");
const assets = [...new Set([...index.matchAll(/(?:src|href)="(\/admin\/assets\/[^"?#]+)"/g)].map(match => match[1]!))].sort();
// The shared fixture loads built files into memory. Capture before it starts,
// then compare its HTML below so later builds cannot relabel this recording.
const build = {
  phase,
  sourceAtStart: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDiffAtStart: hash(execFileSync("git", ["-c", "core.safecrlf=false", "diff", "--binary", "HEAD", "--", "src", "web", "scripts"], { stdio: ["ignore", "pipe", "ignore"] })),
  adminIndex: hash(index),
  checkoutManifest: hash(readFileSync("web-dist/checkout/.vite/manifest.json")),
  adminEntryAssets: assets.map(path => ({ path, sha256: hash(readFileSync("web-dist" + path)) })),
};

type Operation = { name: string; kind: "sidebar" | "chart" | "sort" | "pagination" | "refresh"; expected?: string; list?: "orders" | "ledger"; apiPath?: string; queryCacheHit?: boolean };
type Sample = {
  operation: Operation; armedAt: number; inputAt: number | null; pointerDownAt: number | null; inputTrusted: boolean;
  feedbackAt: number | null; feedbackEvidence: string | null; resultAt: number | null; resultEvidence: string | null;
  firstNoRunningWebAnimationAt: number | null; firstFrameAfterInputAt: number | null; frames: number[]; lastFrame: number | null; previousRows: string; previousWidth: number; previousIndicatorBounds: number[] | null;
};
type PerfWindow = Window & { __polishPerf: {
  sample: Sample | null; target: Element | null; lastNativeFrame: number | null; supported: string[];
  longTasks: { startTime: number; duration: number }[];
  shifts: { startTime: number; value: number; hadRecentInput: boolean }[];
} };

function installProbe() {
  const probe: PerfWindow["__polishPerf"] = { sample: null, target: null, lastNativeFrame: null, supported: [...PerformanceObserver.supportedEntryTypes], longTasks: [], shifts: [] };
  (window as unknown as PerfWindow).__polishPerf = probe;
  if (probe.supported.includes("longtask")) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
  }).observe({ type: "longtask", buffered: true });
  if (probe.supported.includes("layout-shift")) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
      probe.shifts.push({ startTime: entry.startTime, value: shift.value, hadRecentInput: shift.hadRecentInput });
    }
  }).observe({ type: "layout-shift", buffered: true });
  for (const eventType of ["pointerdown", "click"] as const) document.addEventListener(eventType, event => {
    const sample = probe.sample;
    if (!sample || !probe.target?.contains(event.target as Node)) return;
    if (eventType === "pointerdown") sample.pointerDownAt = event.timeStamp;
    else if (sample.inputAt === null) { sample.inputAt = event.timeStamp; sample.inputTrusted = event.isTrusted; sample.lastFrame = probe.lastNativeFrame; }
  }, { capture: true });
  function visible(element: Element | null | undefined) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0 && getComputedStyle(element).visibility === "visible";
  }
  function frame(now: number) {
    const sample = probe.sample;
    if (sample?.inputAt !== null && sample?.inputAt !== undefined) {
      sample.firstFrameAfterInputAt ??= performance.now();
      if (sample.lastFrame !== null) sample.frames.push(now - sample.lastFrame);
      sample.lastFrame = now;
      const operation = sample.operation;
      let feedback: string | null = null;
      let result: string | null = null;
      let animated: Element | null = null;
      if (operation.kind === "sidebar") {
        const sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
        const gap = document.querySelector('[data-slot="sidebar-gap"]')?.getBoundingClientRect().width ?? 0;
        animated = sidebar;
        if (Math.abs(gap - sample.previousWidth) > .5) feedback = `sidebar width ${gap}`;
        if (sidebar?.getAttribute("data-state") === operation.expected && feedback) result = `sidebar ${operation.expected}; navigation remains mounted`;
      } else if (operation.kind === "chart") {
        const chart = document.querySelector('[data-slot="chart"][data-chart-type]');
        animated = chart?.closest('[data-slot="card"]') ?? null;
        const indicator = probe.target?.querySelector("[data-selection-indicator]");
        const bounds = indicator?.getBoundingClientRect();
        if (visible(indicator) && bounds && sample.previousIndicatorBounds && [bounds.x, bounds.y, bounds.width, bounds.height].some((value, index) => Math.abs(value - sample.previousIndicatorBounds![index]!) > .5)) feedback = "chart selection indicator visibly moved";
        const marks = operation.expected === "BAR" ? ".recharts-bar .recharts-rectangle" : ".recharts-line .recharts-line-curve";
        if (chart && chart.getAttribute("data-chart-type") === operation.expected && [...chart.querySelectorAll(marks)].some(visible)) {
          result = `${operation.expected} chart SVG plotted marks visible`;
          feedback ??= result;
        }
      } else {
        const list = document.querySelector(`[data-business-list="${operation.list}"]`);
        const rows = [...(list?.querySelectorAll("[data-row-link]") ?? [])].map(row => row.getAttribute("href")).join("|");
        const busy = list?.querySelector('[aria-busy="true"]');
        const status = list?.querySelector('[aria-label="列表分页"] [role="status"]')?.textContent ?? "";
        const header = list?.querySelector('th[data-column-id="payable_amount_cents"]');
        const response = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find(entry => entry.startTime >= sample.inputAt! && new URL(entry.name).pathname === operation.apiPath && entry.responseEnd > 0);
        animated = list;
        if (operation.kind === "sort" && header?.getAttribute("aria-sort") === operation.expected) feedback = `visible sort arrow ${operation.expected}`;
        if (operation.kind === "pagination") {
          if (/正在读取/.test(status)) feedback = status;
          else if (visible(list?.querySelector('[data-slot="skeleton"]'))) feedback = "new page loading skeleton displayed";
        }
        if (operation.kind === "refresh" && probe.target?.querySelector('[data-slot="spinner"]')) feedback = "refresh spinner displayed";
        if (!feedback && rows !== sample.previousRows && rows) feedback = "new list rows available";
        const scopeReady = operation.kind === "sort" ? header?.getAttribute("aria-sort") === operation.expected
          : operation.kind === "pagination" ? status.startsWith(`第 ${operation.expected} 页`) : true;
        if ((response || operation.queryCacheHit) && !busy && rows && scopeReady && (operation.kind === "refresh" || rows !== sample.previousRows)) {
          result = `${rows.split("|").length} result rows; ${response ? "response complete" : "query cache hit"}; list no longer busy`;
          if (operation.kind !== "refresh") feedback ??= result;
        }
      }
      // A visible DOM/geometry change sampled at a native rAF is a rendering
      // opportunity, not a compositor presentation timestamp or physical paint.
      if (feedback && sample.feedbackAt === null) { sample.feedbackAt = performance.now(); sample.feedbackEvidence = feedback; }
      if (result && sample.resultAt === null) { sample.resultAt = performance.now(); sample.resultEvidence = result; }
      if (sample.resultAt !== null && sample.firstNoRunningWebAnimationAt === null && animated && !animated.getAnimations({ subtree: true }).some(animation => animation.playState === "running")) sample.firstNoRunningWebAnimationAt = performance.now();
    }
    probe.lastNativeFrame = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]! : null;
  return { count: values.length, p50: percentile(.5), p95: percentile(.95), maximum: sorted.at(-1) ?? null, over33ms: values.filter(value => value > 33.4).length };
};

async function ready(page: Page) {
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 10_000 });
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native frame readiness exceeded 10 seconds")), 10_000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve(); }));
  }));
}

async function metrics(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.filter(metric => ["LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"].includes(metric.name)).map(metric => [metric.name, metric.value]));
}

async function observe(page: Page, cdp: CDPSession, target: Locator, operation: Operation) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeEnabled();
  await ready(page);
  const before = await metrics(cdp);
  await target.evaluate((element, operation) => {
    const probe = (window as unknown as PerfWindow).__polishPerf;
    const selectedIndicator = element.closest('[role="group"]')?.querySelector("[data-selection-indicator]")?.getBoundingClientRect();
    probe.target = element;
    probe.sample = {
      operation, armedAt: performance.now(), inputAt: null, pointerDownAt: null, inputTrusted: false,
      feedbackAt: null, feedbackEvidence: null, resultAt: null, resultEvidence: null, firstNoRunningWebAnimationAt: null, firstFrameAfterInputAt: null,
      frames: [], lastFrame: null,
      previousRows: [...document.querySelectorAll(`[data-business-list="${operation.list}"] [data-row-link]`)].map(row => row.getAttribute("href")).join("|"),
      previousWidth: document.querySelector('[data-slot="sidebar-gap"]')?.getBoundingClientRect().width ?? 0,
      previousIndicatorBounds: selectedIndicator ? [selectedIndicator.x, selectedIndicator.y, selectedIndicator.width, selectedIndicator.height] : null,
    };
  }, operation);
  const response = operation.apiPath && !operation.queryCacheHit ? page.waitForResponse(response => new URL(response.url()).pathname === operation.apiPath && response.ok(), { timeout: 10_000 }) : null;
  await Promise.all([target.click({ timeout: 10_000 }), response]);
  await page.waitForFunction(() => (window as unknown as PerfWindow).__polishPerf.sample?.resultAt !== null, null, { timeout: 10_000 });
  // This tail observes decoration/frame cost; it is excluded from response latency.
  await page.waitForTimeout(400);
  const after = await metrics(cdp);
  const measurement = await page.evaluate(() => {
    const probe = (window as unknown as PerfWindow).__polishPerf;
    const sample = probe.sample!;
    const end = performance.now();
    probe.sample = null;
    return {
      ...sample, observationEndedAt: end,
      longTasks: probe.longTasks.filter(entry => entry.startTime + entry.duration >= sample.inputAt! && entry.startTime <= end),
      shifts: probe.shifts.filter(entry => entry.startTime >= sample.inputAt! && entry.startTime <= end),
      requests: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(entry => entry.startTime >= sample.inputAt! && new URL(entry.name).pathname.startsWith("/api/")).map(entry => ({
        path: new URL(entry.name).pathname + new URL(entry.name).search, startTime: entry.startTime, requestStart: entry.requestStart, responseStart: entry.responseStart, responseEnd: entry.responseEnd, duration: entry.duration,
      })),
      supported: probe.supported,
    };
  });
  expect(measurement.inputTrusted, operation.name + ": actual browser input").toBe(true);
  if (operation.kind !== "refresh") expect(measurement.feedbackAt, operation.name + ": visible feedback").not.toBeNull();
  if (operation.queryCacheHit) expect(measurement.requests.filter(request => request.path.startsWith(operation.apiPath!))).toEqual([]);
  expect(measurement.resultAt! - measurement.inputAt!).toBeGreaterThanOrEqual(0);
  expect(measurement.frames.length).toBeGreaterThan(0);
  return {
    ...measurement,
    inputToFeedbackMs: measurement.feedbackAt === null ? null : measurement.feedbackAt - measurement.inputAt!,
    feedbackObservation: measurement.feedbackAt === null ? "No visible busy frame sampled before the unchanged refresh result returned." : "Visible feedback sampled at a native animation frame.",
    inputToResultMs: measurement.resultAt! - measurement.inputAt!,
    inputToFirstFrameMs: measurement.firstFrameAfterInputAt! - measurement.inputAt!,
    inputToNoRunningWebAnimationMs: measurement.firstNoRunningWebAnimationAt === null ? null : measurement.firstNoRunningWebAnimationAt - measurement.inputAt!,
    frameDistribution: distribution(measurement.frames),
    layoutShiftTotal: measurement.shifts.reduce((sum, shift) => sum + shift.value, 0),
    layoutShiftWithoutRecentInput: measurement.shifts.filter(shift => !shift.hadRecentInput).reduce((sum, shift) => sum + shift.value, 0),
    cdpMetricsDelta: Object.fromEntries(Object.entries(after).map(([name, value]) => [name, value - (before[name] ?? 0)])),
  };
}

async function coldResources(page: Page, cdp: CDPSession) {
  const requests = new Map<string, { path: string; type: string; status: number; fromDiskCache: boolean; fromServiceWorker: boolean; contentEncoding: string; encodedDataLength?: number }>();
  const requestPaths = new Map<string, string>();
  const failures: { path: string | null; error: string; canceled: boolean; blockedReason: string | null }[] = [];
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => requestPaths.set(requestId, new URL(request.url).pathname + new URL(request.url).search));
  cdp.on("Network.responseReceived", ({ requestId, type, response }) => requests.set(requestId, {
    path: new URL(response.url).pathname + new URL(response.url).search, type, status: response.status,
    fromDiskCache: response.fromDiskCache ?? false, fromServiceWorker: response.fromServiceWorker ?? false,
    contentEncoding: Object.entries(response.headers).find(([name]) => name.toLowerCase() === "content-encoding")?.[1] ?? "identity",
  }));
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => { const request = requests.get(requestId); if (request) request.encodedDataLength = encodedDataLength; });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, canceled, blockedReason }) => failures.push({ path: requestPaths.get(requestId) ?? null, error: errorText, canceled: canceled ?? false, blockedReason: blockedReason ?? null }));
  return async () => {
    const entries = await page.evaluate(() => [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].map(entry => {
      const resource = entry as PerformanceResourceTiming;
      const url = new URL(resource.name);
      return { path: url.pathname + url.search, entryType: resource.entryType, initiatorType: resource.initiatorType, startTime: resource.startTime, duration: resource.duration, responseStart: resource.responseStart, responseEnd: resource.responseEnd, transferSize: resource.transferSize, encodedBodySize: resource.encodedBodySize, decodedBodySize: resource.decodedBodySize };
    }));
    return { entries, network: [...requests.values()], failures, totals: {
      resources: entries.length,
      completedNetworkRequests: [...requests.values()].filter(request => request.encodedDataLength !== undefined).length,
      transferSize: entries.reduce((sum, entry) => sum + entry.transferSize, 0),
      encodedBodySize: entries.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      decodedBodySize: entries.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      cdpEncodedDataLength: [...requests.values()].reduce((sum, request) => sum + (request.encodedDataLength ?? 0), 0),
    } };
  };
}

async function attach(info: TestInfo, name: string, data: unknown) {
  const path = info.outputPath(name + ".json");
  writeFileSync(path, JSON.stringify(data, null, 2));
  await info.attach(name, { path, contentType: "application/json" });
}

test(`${phase}: first-load resources and native input-to-result performance`, async ({ browser, manifest }, info) => {
  test.setTimeout(90_000);
  const viewport = { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", colorScheme: "light", reducedMotion: "no-preference", serviceWorkers: "block", recordVideo: { dir: info.outputPath("video"), size: viewport } });
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(10_000);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const cspErrors: string[] = [];
  const httpErrors: { path: string; status: number }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400) httpErrors.push({ path: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status() });
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
    if (/content security|violat.*directive|refused to/i.test(message.text())) cspErrors.push(message.text());
  });
  await setDateOnly(page, manifest.epoch);
  await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
  await page.addInitScript(() => { localStorage.setItem("perpay:theme", "light"); localStorage.setItem("perpay:content-width", "compact"); localStorage.setItem("perpay:list-density", "compact"); });
  await page.addInitScript(installProbe);
  await cdp.send("Performance.enable");
  const readInitialResources = await coldResources(page, cdp);
  const observations: Awaited<ReturnType<typeof observe>>[] = [];
  try {
    await login(page, manifest);
    await expect(page.locator('[data-slot="chart"][data-chart-type] svg').first()).toBeVisible();
    await ready(page);
    const nativeTimers = await page.evaluate(() => ({
      raf: requestAnimationFrame.toString().includes("[native code]"),
      performance: performance.now.toString().includes("[native code]"),
      eventTimeStamp: Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp")?.get?.toString().includes("[native code]"),
      fixedDate: Date.now(),
    }));
    expect(nativeTimers).toEqual({ raf: true, performance: true, eventTimeStamp: true, fixedDate: manifest.epoch });
    const servedIndex = await (await page.request.get(manifest.origin + "/admin/", { timeout: 10_000 })).text();
    expect([...new Set([...servedIndex.matchAll(/(?:src|href)="(\/admin\/assets\/[^"?#]+)"/g)].map(match => match[1]!))].sort()).toEqual(assets);
    console.log(`PERPAY_PERFORMANCE_READY phase=${phase} origin=${manifest.origin} build=${build.adminIndex}`);
    const initialAdmin = await readInitialResources();
    await attach(info, `${phase}-admin-first-load`, { build, viewport, ...initialAdmin });
    expect(initialAdmin.totals.encodedBodySize).toBeGreaterThan(0);
    const toggle = page.getByRole("button", { name: "切换导航", exact: true });
    for (const expected of ["collapsed", "expanded"]) observations.push(await observe(page, cdp, toggle, { name: `sidebar-${expected}`, kind: "sidebar", expected }));
    const trend = page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { name: "收款趋势", exact: true }) });
    for (const [expected, label] of [["BAR", "柱状图"], ["LINE", "折线图"]] as const) observations.push(await observe(page, cdp, trend.getByRole("group", { name: "图表类型" }).getByRole("button", { name: label, exact: true }), { name: `chart-${expected}`, kind: "chart", expected }));
    await page.getByRole("navigation", { name: "主导航", exact: true }).locator('a[href^="/admin/orders"]').click();
    const orders = page.locator('[data-business-list="orders"]');
    await expect(orders.locator("[data-row-link]").first()).toBeVisible();
    for (const expected of ["ascending", "descending"]) observations.push(await observe(page, cdp, orders.getByRole("button", { name: "应付金额", exact: true }), { name: `orders-sort-${expected}`, kind: "sort", expected, list: "orders", apiPath: "/api/admin/v1/orders" }));
    for (const [expected, label] of [["2", "下一页"], ["1", "上一页"]] as const) observations.push(await observe(page, cdp, orders.getByRole("button", { name: label, exact: true }), { name: `orders-page-${expected}`, kind: "pagination", expected, list: "orders", apiPath: "/api/admin/v1/orders", queryCacheHit: expected === "1" }));
    await page.goto(manifest.origin + "/admin/ledger");
    const ledger = page.locator('[data-business-list="ledger"]');
    await expect(ledger.locator("[data-row-link]").first()).toBeVisible();
    for (let index = 0; index < 2; index++) observations.push(await observe(page, cdp, page.locator("#main-content").getByRole("button", { name: "刷新", exact: true }), { name: `ledger-refresh-${index + 1}`, kind: "refresh", list: "ledger", apiPath: "/api/admin/v1/ledger/entries" }));
    await page.screenshot({ path: info.outputPath(`${phase}-ledger-final.png`), fullPage: true });
    expect(errors).toEqual([]);
    expect(cspErrors).toEqual([]);
    // The isolated demo intentionally has no official update metadata checker.
    expect(httpErrors.filter(error => error.status !== 503 || !error.path.startsWith("/api/admin/v1/system/update?"))).toEqual([]);
  } finally {
    await attach(info, `${phase}-interaction-performance`, {
      build, viewport, browser: browser.version(), fixedBusinessDate: new Date(manifest.epoch).toISOString(), errors, consoleErrors, cspErrors, httpErrors, observations,
      method: {
        clock: "Only Date is fixed; requestAnimationFrame, performance.now and Event.timeStamp are native.",
        input: "Trusted click Event.timeStamp in a capture listener; pointerdown is recorded separately.",
        visibleFeedback: "First native rAF sample with visible geometry, selection decoration, pending text, spinner, or updated result. This is a rendering opportunity, not a compositor presentation timestamp.",
        result: "Relevant rendered chart/sidebar state or completed API response plus non-busy current-scope list rows; no wait for decorative transitions.",
        animationDiagnostic: "First getAnimations() sample without a running animation in the observed subtree. This does not cover JS-driven Motion layout transforms or prove all decoration has completed.",
        tail: "400 ms after result readiness is observation only and excluded from input-to-result latency.",
        frames: "Frame intervals begin at the last native rAF before input, including the frame spanning the click handler; input-to-first-frame is also recorded separately.",
        overhead: "Single local Chromium run with video, rAF DOM/geometry sampling and CDP enabled; diagnostic costs include the observer and test environment, and do not establish an improvement or production performance.",
        cdpMetrics: "LayoutCount/RecalcStyleCount are counts; all Duration deltas are seconds for the complete observation window.",
        resourceSizes: "Cold context with HTTP cache disabled and service workers blocked. ResourceTiming transferSize includes its reported transfer overhead; encodedBodySize is body before content decoding; decodedBodySize is after decoding. CDP encodedDataLength is recorded separately. The local server may serve identity encoding; these values are not gzip bundle estimates.",
        refresh: "Existing ledger RefreshButton directly refetches its query. Orders have no manual refresh, and fixed Date keeps freshly cached focus-refetch data fresh.",
        expectedHttpError: "The fixture deliberately rejects official update metadata checks with 503; the exact paths/statuses remain in httpErrors and console messages remain unfiltered.",
      },
    });
    await context.close();
    const video = await page.video()?.path();
    if (video) await info.attach(`${phase}-performance-flow`, { path: video, contentType: "video/webm" });
  }
  const checkoutContext = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
  checkoutContext.setDefaultTimeout(10_000);
  checkoutContext.setDefaultNavigationTimeout(10_000);
  const checkout = await checkoutContext.newPage();
  try {
    await setDateOnly(checkout, manifest.epoch);
    await checkout.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    const readResources = await coldResources(checkout, await checkoutContext.newCDPSession(checkout));
    await checkout.goto(manifest.origin + manifest.checkouts.open!);
    await expect(checkout.locator("[data-qr-image]")).toBeVisible();
    await ready(checkout);
    const initialCheckout = await readResources();
    expect(initialCheckout.totals.encodedBodySize).toBeGreaterThan(0);
    await attach(info, `${phase}-checkout-first-load`, { build, viewport, ...initialCheckout });
  } finally { await checkoutContext.close(); }
});
