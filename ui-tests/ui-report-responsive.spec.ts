import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { settleOverlay } from "./overlay-fixtures";
import { screenshot } from "./audit";

async function tabFitsAndTargetsItself(tab: Locator) {
  const geometry = await tab.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const scroller = element.closest('[data-settings-tabs-scroll]')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return { label: element.textContent, left: bounds.left, right: bounds.right, textLeft: text.left, textRight: text.right,
      scrollerLeft: scroller.left, scrollerRight: scroller.right, hitsOwnTab: hit === element || element.contains(hit) };
  });
  expect(geometry.textLeft, "the label stays within its own tab instead of overlapping an adjacent tab").toBeGreaterThanOrEqual(geometry.left - 1);
  expect(geometry.textRight).toBeLessThanOrEqual(geometry.right + 1);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.scrollerLeft - 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.scrollerRight + 1);
  expect(geometry.hitsOwnTab).toBe(true);
  return geometry;
}

async function exerciseTabs(page: Page, list: Locator) {
  const choices = list.getByRole('tab');
  const evidence = [];
  for (let index = 0; index < await choices.count(); index++) {
    const tab = choices.nth(index);
    await tab.click();
    await page.clock.runFor(100);
    await expect(tab, "a normal pointer click selects the requested category").toHaveAttribute('aria-selected', 'true');
    evidence.push(await tabFitsAndTargetsItself(tab));
  }
  await choices.first().click();
  await choices.first().focus();
  for (let index = 1; index < await choices.count(); index++) {
    await page.keyboard.press('ArrowRight');
    await expect(choices.nth(index)).toBeFocused();
    await expect(choices.first(), "arrow keys only move focus until the user activates a category").toHaveAttribute('aria-selected', 'true');
    evidence.push(await tabFitsAndTargetsItself(choices.nth(index)));
  }
  await page.keyboard.press('Enter');
  await expect(choices.last()).toHaveAttribute('aria-selected', 'true');
  return evidence;
}

async function manualScopeFits(group: Locator) {
  // Only reveal the group vertically. Horizontal auto-scrolling would hide a
  // regression where the second scope choice starts outside the dialog.
  await group.evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY === 'auto' && parent.scrollHeight > parent.clientHeight) {
        const bounds = element.getBoundingClientRect(), scroll = parent.getBoundingClientRect();
        parent.scrollTop += bounds.top - scroll.top - 8;
        parent.scrollLeft = 0;
        break;
      }
    }
  });
  const geometry = await group.evaluate(element => {
    const scroller = element.closest('[data-admin-dialog-scroll], [data-overlay-step-scroll]')!;
    const scroll = scroller.getBoundingClientRect();
    return { width: scroller.clientWidth, scrollWidth: scroller.scrollWidth, scrollLeft: scroller.scrollLeft,
      choices: [...element.querySelectorAll('button')].map(button => {
        const bounds = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
        const text = range.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { label: button.textContent, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          textLeft: text.left, textRight: text.right, textTop: text.top, textBottom: text.bottom,
          scrollLeft: scroll.left, scrollRight: scroll.right, scrollTop: scroll.top, scrollBottom: scroll.bottom,
          hitsOwnChoice: hit === button || button.contains(hit) };
      }) };
  });
  expect(geometry.scrollWidth, 'recommendation scopes do not make the dialog scroll horizontally').toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.scrollLeft).toBe(0);
  expect(geometry.choices).toHaveLength(2);
  for (const choice of geometry.choices) {
    expect(choice.left).toBeGreaterThanOrEqual(choice.scrollLeft - 1);
    expect(choice.right).toBeLessThanOrEqual(choice.scrollRight + 1);
    expect(choice.top).toBeGreaterThanOrEqual(choice.scrollTop - 1);
    expect(choice.bottom).toBeLessThanOrEqual(choice.scrollBottom + 1);
    expect(choice.textLeft).toBeGreaterThanOrEqual(choice.left - 1);
    expect(choice.textRight).toBeLessThanOrEqual(choice.right + 1);
    expect(choice.textTop).toBeGreaterThanOrEqual(choice.top - 1);
    expect(choice.textBottom).toBeLessThanOrEqual(choice.bottom + 1);
    expect(choice.hitsOwnChoice, 'each visible scope can be clicked without first scrolling the dialog sideways').toBe(true);
  }
  return geometry;
}

for (const layout of [{ width: 320, height: 560, text: 200 }, { width: 640, height: 280, text: 150 }, { width: 390, height: 844, text: 100 }, { width: 1440, height: 900, text: 100 }]) {
  test.describe(`${layout.width}x${layout.height} ${layout.text}% report regressions`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, isMobile: layout.width < 768, hasTouch: layout.width < 768, reducedMotion: 'reduce' });

    test("site categories, manual search and match headers stay readable and target the intended controls", async ({ page, manifest }, info) => {
      await page.addInitScript(({ text }) => {
        const apply = () => document.documentElement.style.fontSize = text + '%';
        if (document.documentElement) apply(); else document.addEventListener('DOMContentLoaded', apply, { once: true });
      }, layout);
      await login(page, manifest);
      const writes: string[] = [], errors: string[] = [];
      page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
      page.on('pageerror', error => errors.push(error.message));
      const siteRoute = manifest.routes.find(route => /^\/sites\/[^/]+\/settings$/.test(route))!;
      const sitePath = siteRoute.replace(/\/settings$/, '/edit?section=integration');
      await page.goto(manifest.origin + '/admin' + sitePath);
      let overlay = await settleOverlay(page);
      const siteTabs = await exerciseTabs(page, overlay.getByRole('tablist', { name: '网站设置分组', exact: true }));
      expect(await overlay.locator('[data-slot="card-footer"]').evaluateAll(footers => footers.filter(footer => !footer.textContent?.trim()).length), "the moved site actions leave no empty footer surface").toBe(0);
      await record(page, info, { feature: 'site-editor-category-reflow', layout, siteTabs });
      await screenshot(page, info, `site-category-${layout.width}-${layout.text}`);

      await page.goto(manifest.origin + '/admin/sites/defaults');
      overlay = await settleOverlay(page);
      const defaultsTabs = await exerciseTabs(page, overlay.getByRole('tablist', { name: '模板分组', exact: true }));
      const defaultWidth = await overlay.locator('[data-overlay-detail]').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(defaultWidth.scrollWidth).toBeLessThanOrEqual(defaultWidth.width + 1);
      await record(page, info, { feature: 'site-default-category-reflow', layout, defaultsTabs, defaultWidth });
      await screenshot(page, info, `default-category-${layout.width}-${layout.text}`);

      await page.goto(manifest.origin + '/admin/reconciliation');
      if (layout.width < 768) {
        await page.getByRole('button', { name: '更多对账操作', exact: true }).click();
        await page.getByRole('menuitem', { name: '人工关联收款', exact: true }).click();
      } else await page.getByRole('button', { name: '人工关联收款', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '人工关联收款', exact: true });
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole('searchbox', { name: '搜索订单', exact: true });
      await input.scrollIntoViewIfNeeded();
      const searchGeometry = await input.evaluate(element => {
        const input = element.getBoundingClientRect(), scroll = element.closest('[data-admin-dialog-scroll]')!;
        const bounds = scroll.getBoundingClientRect();
        return { input: input.toJSON(), scroll: bounds.toJSON(), width: scroll.clientWidth, scrollWidth: scroll.scrollWidth };
      });
      expect(searchGeometry.scrollWidth).toBeLessThanOrEqual(searchGeometry.width + 1);
      expect(searchGeometry.input.left).toBeGreaterThanOrEqual(searchGeometry.scroll.left - 1);
      expect(searchGeometry.input.right).toBeLessThanOrEqual(searchGeometry.scroll.right + 1);
      const searchRequests: string[] = [];
      page.on('request', request => { if (request.url().includes('/manual/orders?')) searchRequests.push(new URL(request.url()).searchParams.get('q') ?? ''); });
      await input.fill('轻账');
      await input.press('Enter');
      await expect.poll(() => searchRequests).toContain('轻账');
      await record(page, info, { feature: 'manual-search-reflow', layout, searchGeometry });
      await screenshot(page, info, `manual-search-${layout.width}-${layout.text}`);

      const headers = [];
      for (const kind of ['matchSite', 'matchManual', 'matchReversed']) {
        await page.goto(manifest.origin + '/admin' + manifest.details[kind]);
        overlay = await settleOverlay(page);
        const card = overlay.locator('[data-match-summary]').first();
        await expect(card).toBeVisible();
        await card.locator('[data-slot="card-title"]').first().scrollIntoViewIfNeeded();
        const geometry = await card.evaluate(element => {
          const header = element.querySelector('[data-slot="card-header"]')!;
          const title = header.querySelector('[data-slot="card-title"]')!, action = header.querySelector('[data-slot="card-action"]')!;
          const bounds = title.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(title);
          const style = getComputedStyle(title), titleText = range.getBoundingClientRect();
          return { title: title.textContent, titleBounds: bounds.toJSON(), actionBounds: action.getBoundingClientRect().toJSON(),
            titleText: titleText.toJSON(), lineHeight: parseFloat(style.lineHeight), scrollWidth: header.scrollWidth, width: header.clientWidth };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        expect(geometry.titleText.height, "a short heading is never squeezed into a column of individual characters").toBeLessThanOrEqual(geometry.lineHeight * 2 + 2);
        expect(geometry.titleText.right).toBeLessThanOrEqual(geometry.titleBounds.right + 1);
        const overlaps = geometry.titleBounds.left < geometry.actionBounds.right && geometry.titleBounds.right > geometry.actionBounds.left && geometry.titleBounds.top < geometry.actionBounds.bottom && geometry.titleBounds.bottom > geometry.actionBounds.top;
        expect(overlaps, "title and actions occupy separate space").toBe(false);
        headers.push({ kind, geometry });
        await screenshot(page, info, `match-header-${kind}-${layout.width}-${layout.text}`);
      }
      expect(writes, "category selection and search never perform a business mutation").toEqual([]);
      expect(errors).toEqual([]);
      await record(page, info, { feature: 'match-header-reflow', layout, headers });
    });

    test("contextual manual association keeps both scopes readable and selectable through three actual entry points", async ({ page, manifest }, info) => {
      await page.addInitScript(({ text }) => {
        const apply = () => document.documentElement.style.fontSize = text + '%';
        if (document.documentElement) apply(); else document.addEventListener('DOMContentLoaded', apply, { once: true });
      }, layout);
      await login(page, manifest);
      const writes: string[] = [], errors: string[] = [];
      const reads: Array<{ path: string; view: string | null; context: string | null }> = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method() + ' ' + url.pathname);
        if (/\/manual\/(orders|ledger-entries)$/.test(url.pathname)) reads.push({ path: url.pathname, view: url.searchParams.get('view'), context: url.searchParams.get('order_id') ?? url.searchParams.get('ledger_entry_id') });
      });
      page.on('pageerror', error => errors.push(error.message));
      const evidence = [];
      for (const mode of ['from-order', 'from-ledger', 'global-after-order-choice']) {
        if (mode === 'global-after-order-choice') {
          await page.goto(manifest.origin + '/admin/reconciliation');
          if (layout.width < 768) {
            await page.getByRole('button', { name: '更多对账操作', exact: true }).click();
            await page.getByRole('menuitem', { name: '人工关联收款', exact: true }).click();
          } else await page.getByRole('button', { name: '人工关联收款', exact: true }).click();
          await expect(page.getByRole('dialog', { name: '人工关联收款', exact: true })).toBeVisible();
          await page.getByRole('button', { name: /^选择订单：/ }).first().click();
        } else {
          await page.goto(manifest.origin + '/admin' + manifest.details[mode === 'from-order' ? 'orderLong' : 'exceptionUnmatched']);
          await settleOverlay(page);
          await page.getByRole('button', { name: '人工关联收款', exact: true }).first().click();
        }
        const dialog = page.getByRole('dialog', { name: '人工关联收款', exact: true });
        const group = dialog.getByRole('group', { name: '可能匹配的记录范围', exact: true });
        await expect(group).toBeVisible();
        await expect(dialog.locator('[data-slot="skeleton"]')).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        const recommended = group.getByRole('button').first();
        const all = group.getByRole('button', { name: '全部可关联', exact: true });
        await expect(recommended).toHaveAttribute('aria-pressed', 'true');
        const initial = await manualScopeFits(group);
        const startReads = reads.length;
        await all.click();
        await expect(all).toHaveAttribute('aria-pressed', 'true');
        await expect(recommended).toHaveAttribute('aria-pressed', 'false');
        await expect.poll(() => reads.slice(startReads).some(read => read.view === 'all' && !!read.context), 'pointer scope selection makes a contextual read request').toBe(true);
        await recommended.click();
        await expect(recommended).toHaveAttribute('aria-pressed', 'true');
        await recommended.focus();
        await page.keyboard.press('ArrowRight');
        await expect(all).toBeFocused();
        await expect(recommended, 'moving keyboard focus does not change the selected scope').toHaveAttribute('aria-pressed', 'true');
        const keyboardReads = reads.length;
        await page.keyboard.press('Space');
        await expect(all).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => reads.slice(keyboardReads).some(read => read.view === 'all' && !!read.context), 'Space selects the focused scope through the same contextual read API').toBe(true);
        const after = await manualScopeFits(group);
        evidence.push({ mode, initial, after });
        await screenshot(page, info, `manual-scopes-${mode}-${layout.width}-${layout.text}`);
      }
      expect(writes, 'scope selection never submits an association or edits business data').toEqual([]);
      expect(errors).toEqual([]);
      await record(page, info, { feature: 'contextual-manual-scopes-reflow', layout, evidence, reads });
    });
  });
}
