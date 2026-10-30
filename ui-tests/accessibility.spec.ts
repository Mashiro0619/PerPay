import { test, expect, login, record } from "./fixtures";
import { audit } from "./audit";
import AxeBuilder from "@axe-core/playwright";
import { waitForControlAnimations } from "./touch-targets";

test("sidebar and record menu names include their visible labels", async ({ page, manifest }, info) => {
  const order = manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route))!;
  for (const mode of ["expanded", "collapsed", "mobile"] as const) {
    await page.setViewportSize(mode === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin" + order);
    await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /订单操作$/ })).toBeVisible();
    if (mode === "mobile" || mode === "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
    const account = page.getByRole("button", { name: /账户菜单$/ });
    await page.clock.runFor(50);
    await waitForControlAnimations(account);
    if (mode === "mobile") {
      const website = page.getByRole("button", { name: /^业务网站 .*，(?:收起|展开)$/ });
      await website.scrollIntoViewIfNeeded();
      const result = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
      await info.attach("mobile-website-label-content-name", { body: JSON.stringify(result), contentType: "application/json" });
      expect.soft(result.violations, "mobile website").toEqual([]);
      expect(result.passes.some(rule => rule.id === "label-content-name-mismatch")).toBe(true);
    }
    await account.scrollIntoViewIfNeeded();
    // This WCAG 2.1 A rule is not covered by the general audit's AA tag list.
    const result = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
    await info.attach(`${mode}-label-content-name`, { body: JSON.stringify(result), contentType: "application/json" });
    expect.soft(result.violations, mode).toEqual([]);
    expect(result.passes.some(rule => rule.id === "label-content-name-mismatch")).toBe(true);
    if (mode === "collapsed") {
      await page.getByRole("button", { name: "切换导航", exact: true }).click();
    }
  }
});

test("chart, avatar, amount list and dangerous action semantics stay accessible in both themes", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const order = manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route))!;
    const settings = manifest.routes.find(route => /^\/sites\/[^/]+\/settings$/.test(route))!;
    for (const [index, route] of ["/", order, settings].entries()) {
      await page.goto(manifest.origin + "/admin" + route);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
      if (route === "/") await expect(page.locator(".recharts-surface")).toBeVisible();
      // Font replacement changes text bounds after the skeletons disappear.
      await page.evaluate(() => document.fonts.ready);
      await audit(page, info, `${theme}-${index}`);
      await record(page, info, { theme, route });
    }
  }
});

test("initial analytics loading keeps selection decorations on their controls and away from summary amounts", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const routePattern = "**/api/admin/v1/system/analytics**";
    await page.route(routePattern, async route => { await gate; await route.continue(); });
    try {
      await login(page, manifest);
      await expect(page.locator('[data-chart-state="loading"]')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.clock.runFor(250);
      const monitor = await page.evaluateHandle(() => {
        const state = { active: true, samples: [] as { ready: boolean; peak: string | null; marks: {
          label: string | null; variant: string | null; withinControl: boolean; overlapsAmount: boolean;
          indicator: ReturnType<DOMRect["toJSON"]>; control: ReturnType<DOMRect["toJSON"]>;
        }[] }[] };
        const sample = () => {
          const card = document.querySelector(".trend-card");
          if (card && state.samples.length < 81) {
            const ready = !card.querySelector('[data-chart-state="loading"], .trend-summary [data-slot="skeleton"]');
            const amounts = ready ? [...card.querySelectorAll('.trend-summary > div > dd:nth-child(2)')].flatMap(element => {
              const range = document.createRange(); range.selectNodeContents(element);
              return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            }) : [];
            const marks = [...card.querySelectorAll("[data-selection-indicator]")].flatMap(element => {
              const indicator = element.getBoundingClientRect();
              if (!indicator.width || !indicator.height) return [];
              const parent = element.parentElement!, control = parent.getBoundingClientRect();
              const variant = element.getAttribute("data-selection-indicator");
              const horizontal = indicator.left >= control.left - 1 && indicator.right <= control.right + 1;
              const vertical = variant === "underline"
                ? indicator.top >= control.bottom - 1 && indicator.bottom <= control.bottom + 6
                : indicator.top >= control.top - 1 && indicator.bottom <= control.bottom + 1;
              const overlapsAmount = amounts.some(rect => Math.min(indicator.right, rect.right) - Math.max(indicator.left, rect.left) > .5 &&
                Math.min(indicator.bottom, rect.bottom) - Math.max(indicator.top, rect.top) > .5);
              return [{ label: parent.getAttribute("aria-label") ?? parent.textContent, variant, withinControl: horizontal && vertical,
                overlapsAmount, indicator: indicator.toJSON(), control: control.toJSON() }];
            });
            // A slow response must not consume the post-load frame budget.
            if (ready || state.samples.length === 0) state.samples.push({ ready,
              peak: card.querySelector('[data-trend-summary="peak"] > dd')?.textContent ?? null, marks });
          }
          if (state.active) requestAnimationFrame(sample);
        };
        sample();
        return state;
      });
      try {
        release();
        await expect(page.locator('[data-chart-state="loading"]')).toHaveCount(0);
        const peak = page.locator('[data-trend-summary="peak"] > dd').first();
        await expect(peak).toHaveText(/^¥[\d,.]+$/);
        const expectedPeak = await peak.textContent();
        await page.clock.runFor(320);
        const samples = await monitor.evaluate(state => { state.active = false; return state.samples; });
        await info.attach(theme + "-initial-selection-frames", { body: JSON.stringify(samples), contentType: "application/json" });
        expect(samples.some(sample => !sample.ready), "the probe starts while analytics are loading").toBe(true);
        const loaded = samples.filter(sample => sample.ready);
        expect(loaded.length).toBeGreaterThan(2);
        expect(loaded.every(sample => sample.peak === expectedPeak), "financial text remains the exact final value").toBe(true);
        expect(loaded.every(sample => sample.marks.length >= 4)).toBe(true);
        expect(loaded.flatMap(sample => sample.marks).filter(mark => !mark.withinControl || mark.overlapsAmount), "data completion never projects decoration outside its control or onto an amount").toEqual([]);
      } finally {
        await monitor.evaluate(state => { state.active = false; });
        await monitor.dispose();
      }
    } finally {
      release();
      await page.unroute(routePattern);
    }
  }
});

test("sidebar footer stays fully visible on desktop and reachable on mobile", async ({ page, manifest }, info) => {
  for (const [width, height] of [[1280, 720], [1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await login(page, manifest);
    if (width < 1024) await page.getByRole("button", { name: "切换导航", exact: true }).click();
    const footer = page.locator('[data-slot="sidebar-footer"]:visible');
    const targets = footer.locator("a, button");
    await expect(targets).toHaveCount(5);
    const geometry = [];
    for (const target of await targets.all()) {
      if (width < 1024) await target.scrollIntoViewIfNeeded();
      await expect(target).toBeVisible();
      const bounds = await target.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        let top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom);
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === "visible") continue;
          const clip = parent.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        return { label: element.getAttribute("aria-label") ?? element.textContent, height: bounds.height, visibleHeight: bottom - top };
      });
      expect(bounds.visibleHeight, JSON.stringify({ viewport: { width, height }, target: bounds })).toBeGreaterThanOrEqual(bounds.height - .5);
      geometry.push(bounds);
    }
    await record(page, info, { width, height, sidebarFooter: geometry });
  }
});
