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

test.describe("mobile list reflow retains complete choices", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  for (const width of [320, 360]) {
    test(`${width}px and 200% text: list pagination, notification statuses and site periods remain operable`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 560 });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/orders");
      await expect(page.locator("[data-business-row]").first()).toBeVisible();
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const pager = page.getByRole("navigation", { name: "列表分页", exact: true });
      const next = pager.getByRole("button", { name: "下一页", exact: true });
      const nextGeometry = await readableControl(next, page);
      await next.tap();
      await expect(pager).toContainText("第 2 页");
      const previous = pager.getByRole("button", { name: "上一页", exact: true });
      await expect(previous).toBeEnabled();
      const previousGeometry = await readableControl(previous, page);
      await record(page, info, { evidence: "browser touch viewport with 200% root text", width, pagination: { nextGeometry, previousGeometry } });
      await previous.tap();
      await expect(pager).toContainText("第 1 页");
      await expect.poll(() => new URL(page.url()).searchParams.get("cursor")).toBe(null);

      await page.goto(manifest.origin + "/admin/notifications");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const shortcuts = page.getByRole("group", { name: "通知快捷筛选", exact: true });
      for (const [name, value] of [["等待重试", "RETRY_WAIT"], ["已停止重试", "DEAD_LETTER"], ["全部", null]] as const) {
        const choice = shortcuts.getByRole("button", { name, exact: true });
        const geometry = await readableControl(choice, page);
        await choice.tap();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe(value);
        await record(page, info, { evidence: "browser touch viewport with 200% root text", width, notificationChoice: { name, value, geometry } });
      }

      await page.goto(manifest.origin + "/admin/sites");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const periods = page.getByRole("group", { name: "经营统计周期", exact: true });
      for (const days of [7, 30, 90]) {
        const choice = periods.getByRole("button", { name: `近 ${days} 天`, exact: true });
        const geometry = await readableControl(choice, page);
        await choice.tap();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe(String(days));
        await record(page, info, { evidence: "browser touch viewport with 200% root text", width, sitePeriod: { days, geometry } });
      }
      const first = periods.getByRole("button", { name: "近 7 天", exact: true });
      await first.tap();
      await first.focus();
      await page.keyboard.press("ArrowRight");
      const middle = periods.getByRole("button", { name: "近 30 天", exact: true });
      await expect(middle).toBeFocused();
      await page.keyboard.press("Space");
      await expect(middle).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("30");
    });
  }
});
