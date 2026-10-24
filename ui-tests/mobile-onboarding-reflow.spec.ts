import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function readableControl(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  const geometry = await expectTouchTarget(target);
  const text = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...Array.from(range.getClientRects(), rect => ({
        left: rect.left - bounds.left, top: rect.top - bounds.top,
        right: rect.right - bounds.left, bottom: rect.bottom - bounds.top,
      })));
    }
    return { width: bounds.width, height: bounds.height, lines };
  });
  // scrollHeight includes the enlarged touch pseudo-element; measure only rendered label text.
  expect(text.lines.length).toBeGreaterThan(0);
  expect(text.lines.every(line => line.left >= -1 && line.right <= text.width + 1), "complete control label fits horizontally").toBe(true);
  expect(text.lines.every(line => line.top >= -1 && line.bottom <= text.height + 1), "complete control label fits vertically").toBe(true);
  return geometry;
}

test.describe("mobile onboarding reflow retains distinct actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  for (const width of [320, 360]) {
    test(`${width}px and 200% text: onboarding previous does not activate completion actions`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 560 });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/settings/onboarding/check");
      await expect(page.getByRole("link", { name: "进入控制台", exact: true })).toBeVisible();
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const footer = page.locator("[data-onboarding-actions]");
      const controls = footer.locator("a,button");
      const targets = [];
      for (const target of await controls.all()) {
        if (await target.isVisible() && await target.isEnabled()) targets.push(await readableControl(target, page));
      }
      const overlap = await controls.evaluateAll(elements => {
        const boxes = elements.filter(element => element.checkVisibility()).map(element => {
          const rect = element.getBoundingClientRect();
          return { text: element.textContent, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
        return boxes.flatMap((first, index) => boxes.slice(index + 1).flatMap(second =>
          Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 &&
          Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1
            ? [{ first: first.text, second: second.text }] : []));
      });
      expect(overlap).toEqual([]);

      const previous = footer.getByRole("link", { name: "上一步", exact: true });
      const geometry = await readableControl(previous, page);
      const point = { x: geometry.visual.x + geometry.visual.width / 2, y: geometry.visual.y + geometry.visual.height / 2 };
      expect(await previous.evaluate((element, point) => document.elementFromPoint(point.x, point.y)?.closest("a,button") === element, point)).toBe(true);
      await record(page, info, { evidence: "browser touch viewport with 200% root text", width, onboardingTargets: targets, previousTap: point });
      await page.touchscreen.tap(point.x, point.y);
      await expect(page).toHaveURL(manifest.origin + "/admin/settings/onboarding/optional");
      await expect(page.getByRole("heading", { name: "网站与备份", exact: true, level: 2 })).toBeFocused();
    });

  }
});
