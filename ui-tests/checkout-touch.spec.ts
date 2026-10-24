import { test, expect, record } from "./fixtures";
import { screenshot } from "./audit";
import { expectTouchTarget } from "./touch-targets";

test.describe("touch and reduced motion", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 560 } });

  test("payment actions retain 44px targets, scrolling and readable content at 200 percent text zoom", async ({ page, manifest }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    await expect(page.locator("[data-qr-image]")).toBeVisible();
    const targets = [];
    for (const button of await page.getByRole("button").all()) {
      if (!await button.isVisible() || !await button.isEnabled()) continue;
      await button.scrollIntoViewIfNeeded();
      targets.push(await expectTouchTarget(button));
    }
    const query = page.getByRole("button", { name: "查询付款状态", exact: true });
    const bounds = (await query.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(560);
    await record(page, info, { touch: true, targets, reducedMotion: true });

    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await record(page, info, { zoom: "200% text", touch: true, reducedMotion: true });
    expect(await page.locator("[data-payable-amount]").evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await query.scrollIntoViewIfNeeded();
    await expect(query).toBeInViewport();
    await page.getByRole("button", { name: "放大二维码" }).click();
    const dialog = page.getByRole("dialog", { name: "支付宝付款二维码" });
    const close = dialog.getByRole("button", { name: "关闭对话框" });
    await expect(close).toBeInViewport();
    await dialog.locator("[data-qr-dialog-body]").evaluate(element => element.scrollTop = element.scrollHeight);
    await expect(close).toBeInViewport();
    await close.click();
    await expect(page.getByRole("button", { name: "放大二维码" })).toBeFocused();
    await screenshot(page, info, "touch-text-zoom");
  });
});
