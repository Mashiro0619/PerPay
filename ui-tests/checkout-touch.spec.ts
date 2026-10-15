import { test, expect, record } from "./fixtures";
import { screenshot } from "./audit";

test.describe("touch and reduced motion", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 664 } });

  test("payment actions retain 44px targets, scrolling and readable content at 200 percent text zoom", async ({ page, manifest }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    await expect(page.locator("[data-qr-image]")).toBeVisible();
    const targets = await page.getByRole("button").evaluateAll(elements => elements
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ text: element.textContent, height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
    expect(targets.every(target => target.height >= 44 && target.width >= 44)).toBe(true);
    const query = page.getByRole("button", { name: "查询付款状态", exact: true });
    const bounds = (await query.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(664);
    await record(page, info, { touch: true, targets, reducedMotion: true });

    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await record(page, info, { zoom: "200% text", touch: true, reducedMotion: true });
    expect(await page.locator("[data-payable-amount]").evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await query.scrollIntoViewIfNeeded();
    await expect(query).toBeInViewport();
    await screenshot(page, info, "touch-text-zoom");
  });
});
