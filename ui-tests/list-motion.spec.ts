import type { Locator, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";
import { setDateOnly } from "./fixed-date";
import type { AdminOrderDetailEnvelope, AdminOrderPageEnvelope } from "../web/src/api/generated/types.gen";

const panelSelector = '[data-slot="collapsible-content"]';
const indexAtStart = readFileSync("web-dist/admin/index.html", "utf8");
const buildAtStart = createHash("sha256").update(indexAtStart).digest("hex");
const assetsIn = (html: string) => [...html.matchAll(/src="(\/admin\/assets\/[^"?#]+)"/g)].map(match => match[1]!);
const currency = (cents: number | null) => cents === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(cents / 100);

type HeightSample = { time: number; height: number; connected: boolean; expanded: boolean; inert: boolean; hidden: boolean };
type ListProbeWindow = Window & { __listMotion?: Record<string, HeightSample[]> };

async function enableOrderDetails(page: Page) {
  await page.getByRole("button", { name: "更多订单操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
  const display = page.getByRole("dialog", { name: "列表显示", exact: true });
  await display.getByRole("checkbox", { name: "PerPay 确认时间", exact: true }).check();
  await display.getByRole("button", { name: "完成", exact: true }).click();
  await expect(display).toHaveCount(0);
}

async function watchHeight(row: Locator, key: string) {
  await row.evaluate((element, key) => {
    const samples: HeightSample[] = [];
    ((window as ListProbeWindow).__listMotion ??= {})[key] = samples;
    const trigger = element.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')!;
    const initial = trigger.getAttribute("aria-expanded");
    let began = performance.now(), frames = 0;
    const sample = () => {
      const panel = element.querySelector<HTMLElement>('[data-slot="collapsible-content"]');
      samples.push({ time: performance.now() - began, height: panel?.getBoundingClientRect().height ?? 0,
        connected: Boolean(panel), expanded: trigger.getAttribute("aria-expanded") === "true",
        inert: panel?.inert ?? false, hidden: panel?.getAttribute("aria-hidden") === "true" });
    };
    sample();
    const observer = new MutationObserver(() => {
      if (trigger.getAttribute("aria-expanded") === initial) return;
      observer.disconnect();
      began = performance.now();
      const frame = () => {
        sample();
        if (++frames < 24) requestAnimationFrame(frame);
      };
      frame();
    });
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"], childList: true });
  }, key);
}

async function heightSamples(page: Page, key: string) {
  await expect.poll(() => page.evaluate(key => (window as ListProbeWindow).__listMotion?.[key]?.length ?? 0, key)).toBeGreaterThanOrEqual(25);
  return page.evaluate(key => (window as ListProbeWindow).__listMotion![key]!, key);
}

async function completeText(target: Locator) {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const row = element.closest("[data-business-row]")?.getBoundingClientRect() ?? box;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: { left: number; right: number; top: number; bottom: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })));
    }
    return { box: box.toJSON(), row: row.toJSON(), lines };
  });
  expect(geometry.lines.length).toBeGreaterThan(0);
  expect(geometry.lines.every(line => line.left >= geometry.row.left - 1 && line.right <= geometry.row.right + 1), "the complete text fits the record width").toBe(true);
  expect(geometry.lines.every(line => line.top >= geometry.box.top - 1 && line.bottom <= geometry.box.bottom + 1), "the complete text fits its natural height").toBe(true);
  return geometry;
}

test.describe("list summary motion", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("native height transition, rapid reversals, focus and live reduced motion preserve the current record", async ({ browser, manifest }, info) => {
    test.setTimeout(180_000);
    // The standard page fixture mocks rAF. Only Date is fixed here so all
    // transition samples and the video use the browser's native timers.
    const viewport = { width: 390, height: 844 };
    const context = await browser.newContext({ viewport, locale: "zh-CN", timezoneId: "Asia/Shanghai", colorScheme: "light", reducedMotion: "no-preference", isMobile: true, hasTouch: true, recordVideo: { dir: info.outputPath("video"), size: viewport } });
    const page = await context.newPage();
    const video = page.video();
    const errors: string[] = [], cspErrors: string[] = [];
    const evidence: Record<string, unknown> = { viewport, buildAtStart, fixedDate: new Date(manifest.epoch).toISOString(), clock: "Only Date fixed; native rAF and timers", evidenceKind: "Chromium mobile viewport and touch emulation, not a physical device" };
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /content security|violat.*directive|refused to/i.test(message.text())) cspErrors.push(message.text()); });
    await setDateOnly(page, manifest.epoch);
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    try {
      await login(page, manifest);
      expect(assetsIn(await (await page.request.get(manifest.origin + "/admin/")).text())).toEqual(assetsIn(indexAtStart));
      console.log(`PERPAY_LIST_MOTION_READY origin=${manifest.origin} build=${buildAtStart}`);
      await page.goto(manifest.origin + "/admin/orders");
      const rows = page.getByRole("list", { name: "订单列表", exact: true }).getByRole("listitem");
      await expect(rows.first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await enableOrderDetails(page);
      const href = (await rows.first().locator("a[data-row-link]").getAttribute("href"))!;
      const row = rows.filter({ has: page.locator(`a[data-row-link][href="${href}"]`) });
      const source = await page.request.get(manifest.origin + "/api/admin/v1" + href.replace(/^\/admin/, ""));
      expect(source.ok()).toBe(true);
      const original = (await source.json() as AdminOrderDetailEnvelope).data;
      const trigger = row.locator('[data-slot="collapsible-trigger"]');
      const panel = row.locator(panelSelector);
      const listUrl = page.url();
      await expect(panel).toHaveCount(0);
      await trigger.evaluate(element => element.scrollIntoView({ block: "center" }));
      evidence.touchTarget = await expectTouchTarget(trigger);

      await watchHeight(row, "open");
      await trigger.tap();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(page).toHaveURL(listUrl);
      const opened = await heightSamples(page, "open");
      const fullHeight = (await panel.boundingBox())!.height;
      expect(fullHeight).toBeGreaterThan(20);
      expect(opened.some(sample => sample.height > 1 && sample.height < fullHeight - 1), "opening passes through an actual intermediate height").toBe(true);
      expect(opened.filter(sample => sample.expanded && sample.connected).every(sample => !sample.inert && !sample.hidden)).toBe(true);
      await expect(panel.getByText("PerPay 确认时间", { exact: true })).toBeVisible();
      evidence.opened = opened;

      await watchHeight(row, "close");
      await trigger.focus();
      await page.keyboard.press("Space");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      const closed = await heightSamples(page, "close");
      expect(closed.some(sample => !sample.expanded && sample.height > 1 && sample.height < fullHeight - 1), "closing passes through an intermediate height").toBe(true);
      expect(closed.filter(sample => !sample.expanded && sample.connected).every(sample => sample.inert && sample.hidden), "closing content immediately leaves focus and accessibility interaction").toBe(true);
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
      evidence.closed = closed;

      await trigger.evaluate(async element => {
        const button = element as HTMLButtonElement;
        for (let index = 0; index < 7; index++) {
          button.click();
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }
      });
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(panel).toHaveCount(1);
      await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(fullHeight, 0);
      await expect(page).toHaveURL(listUrl);

      await expect(row.getByRole("group", { name: /^应付金额 / })).toHaveText(currency(original.payable_amount_cents));
      await expect(row.getByRole("group", { name: /^实收金额 / })).toHaveText(currency(original.received_amount_cents));
      evidence.refresh = "Data-refresh DOM, focus and expanded-state preservation are covered by list-primitives component tests; not simulated in this browser case.";

      // Current business detail fields contain dates/text. Exercise this shared
      // panel's focus boundary with an explicitly synthetic link using its real
      // link style; do not mistake this probe for a shipped order field.
      await panel.evaluate((element, href) => {
        const probe = document.createElement("a");
        probe.href = href;
        probe.className = "list-secondary-link";
        probe.dataset.listFocusProbe = "true";
        probe.textContent = "测试关联链接";
        element.querySelector("dd")!.replaceChildren(probe);
      }, href);
      await trigger.focus();
      await page.keyboard.press("Tab");
      const focusProbe = panel.locator("[data-list-focus-probe]");
      await expect(focusProbe).toBeFocused();
      const focusGeometry = await focusProbe.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const panel = element.closest('[data-slot="collapsible-content"]')!.getBoundingClientRect();
        const style = getComputedStyle(element);
        const extension = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
        return { bounds: bounds.toJSON(), panel: panel.toJSON(), outlineStyle: style.outlineStyle, extension,
          contained: bounds.left - extension >= panel.left - .5 && bounds.right + extension <= panel.right + .5 && bounds.top - extension >= panel.top - .5 && bounds.bottom + extension <= panel.bottom + .5 };
      });
      expect(focusGeometry.extension).toBeGreaterThan(0);
      expect(focusGeometry.outlineStyle).not.toBe("none");
      expect(focusGeometry.contained, "the complete focus outline fits the expanded clipping panel").toBe(true);
      evidence.focusProbe = { kind: "Synthetic anchor in the real shared panel; current business detail fields remain separately tested", ...focusGeometry };
      const focusPath = info.outputPath("list-motion-focus-probe.png");
      await page.screenshot({ path: focusPath });
      await info.attach("synthetic-focus-probe", { path: focusPath, contentType: "image/png" });
      // A programmatic close keeps focus inside the panel until its own
      // closing handler restores the trigger; a pointer click would mask this.
      await trigger.evaluate(element => (element as HTMLButtonElement).click());
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await watchHeight(row, "reduced-open");
      await trigger.click();
      const reduced = await heightSamples(page, "reduced-open");
      const reducedHeight = (await panel.boundingBox())!.height;
      expect(reduced.every(sample => sample.height < 1 || Math.abs(sample.height - reducedHeight) < 1), "reduced motion jumps to the final height without interpolation").toBe(true);
      expect(await panel.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
      await trigger.click();
      await expect(panel).toHaveCount(0);
      await expect(page).toHaveURL(listUrl);
      evidence.reduced = reduced;
      expect(errors).toEqual([]);
      expect(cspErrors).toEqual([]);
      // Geometry recording happens after all native timing observations.
      await page.clock.install({ time: new Date(manifest.epoch) });
      await record(page, info, { feature: "list-summary-motion", nativeTimingCollectedBeforeClockInstall: true, buildAtStart });
    } catch (error) {
      const path = info.outputPath("list-motion-failure.png");
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      await info.attach("failure-state", { path, contentType: "image/png" }).catch(() => {});
      throw error;
    } finally {
      const path = info.outputPath("list-motion-evidence.json");
      writeFileSync(path, JSON.stringify({ ...evidence, errors, cspErrors }, null, 2));
      await info.attach("list-motion-evidence", { path, contentType: "application/json" });
      await context.close();
      if (video) {
        const path = info.outputPath("list-motion-journey.webm");
        await video.saveAs(path);
        await info.attach("list-motion-journey", { path, contentType: "video/webm" });
      }
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`320px and 200% text in ${theme}: long order text and expanded details remain complete`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
      await login(page, manifest);
      const response = await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details.orderLong!);
      expect(response.ok()).toBe(true);
      const original = (await response.json() as AdminOrderDetailEnvelope).data;
      const merchantOrderNo = "LIST-MOTION-LONG-REFERENCE-".padEnd(64, "9");
      await page.route(manifest.origin + "/api/admin/v1/orders?*", async route => {
        const response = await route.fetch();
        const payload = await response.json() as AdminOrderPageEnvelope;
        await route.fulfill({ response, json: { ...payload, data: payload.data.map(order => order.order_id === original.order_id ? { ...order, merchant_order_no: merchantOrderNo } : order) } });
      });
      await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
      await page.goto(manifest.origin + "/admin/orders?q=" + encodeURIComponent(original.product_name.slice(0, 24)));
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const row = page.getByRole("list", { name: "订单列表", exact: true }).getByRole("listitem").filter({ has: page.locator(`a[data-row-link][href$="/${original.order_id}"]`) });
      await expect(row).toBeVisible();
      await enableOrderDetails(page);
      const listUrl = page.url();
      const trigger = row.getByRole("button", { name: "展开信息", exact: true });
      await trigger.evaluate(element => element.scrollIntoView({ block: "center" }));
      const touch = await expectTouchTarget(trigger);
      await trigger.tap();
      await page.clock.runFor(100);
      // Product summaries intentionally retain the existing two-line clamp.
      const title = await row.locator("a[data-row-link]").innerText();
      expect(title).toBe(original.product_name);
      const reference = await completeText(row.getByText(merchantOrderNo, { exact: true }));
      expect(new Set(reference.lines.map(line => Math.round(line.top))).size).toBeGreaterThan(1);
      const panel = row.locator(panelSelector);
      const label = await completeText(panel.getByText("PerPay 确认时间", { exact: true }));
      const details = await panel.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, overflowX: getComputedStyle(element).overflowX, overflowY: getComputedStyle(element).overflowY }));
      expect(details.scrollHeight).toBeLessThanOrEqual(details.height + 1);
      await expect(page).toHaveURL(listUrl);
      await record(page, info, { feature: "list-motion-long-text", width: 320, textPercent: 200, theme, title, reference, label, details, touch, fixture: "Genuine synthetic order with a display-only 64-character merchant reference" });
      const path = info.outputPath(`list-motion-320-${theme}.png`);
      await page.screenshot({ path, fullPage: true });
      await info.attach(`list-motion-320-${theme}`, { path, contentType: "image/png" });
      await row.getByRole("button", { name: "收起信息", exact: true }).tap();
      await expect(panel).toHaveCount(0);
      await expect(page).toHaveURL(listUrl);
      await row.locator("a[data-row-link]").tap();
      await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + original.order_id);
      await completeText(page.getByText(original.product_name, { exact: true }).first());
    });
  }
});
