import type { Locator } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";
import type { AdminOrderDetailEnvelope, AdminOrderPageEnvelope } from "../web/src/api/generated/types.gen";

async function completeText(target: Locator) {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: { left: number; right: number; top: number; bottom: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })));
    }
    return { box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, lines };
  });
  expect(geometry.lines.length).toBeGreaterThan(0);
  expect(geometry.lines.every(line => line.left >= geometry.box.left - 1 && line.right <= geometry.box.right + 1), "complete detail text fits horizontally").toBe(true);
  expect(geometry.lines.every(line => line.top >= geometry.box.top - 1 && line.bottom <= geometry.box.bottom + 1), "complete detail text fits its natural height").toBe(true);
  return geometry;
}

test.describe("compact list record navigation", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("record overlays preserve the original summary, amounts, scroll and focus in both motion modes", async ({ page, manifest }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/orders");
    const row = page.locator("[data-business-row]").nth(3);
    const trigger = row.locator("a[data-row-link]");
    await expect(trigger).toBeVisible();
    await trigger.scrollIntoViewIfNeeded();
    const original = await row.elementHandle();
    const identity = await row.getAttribute("data-business-row");
    const amounts = await row.locator(".list-money").allTextContents();
    const listUrl = page.url();
    await expect(row.getByRole("button", { name: "展开信息", exact: true })).toHaveCount(0);
    const overlay = page.locator("[data-overlay-content]");
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion });
      await trigger.focus();
      const scroll = await page.evaluate(() => window.scrollY);
      const bounds = (await row.boundingBox())!;
      await page.keyboard.press("Enter");
      await expect(overlay).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(overlay.locator('[data-detail-section="overview"]')).toBeVisible();
      await expect(overlay.getByRole("tab")).toHaveCount(0);
      expect(await original!.evaluate(element => element.isConnected)).toBe(true);
      expect(await row.getAttribute("data-business-row")).toBe(identity);
      expect(await row.locator(".list-money").allTextContents()).toEqual(amounts);
      const close = overlay.locator('[data-slot="dialog-close"]');
      await expectTouchTarget(close);
      await close.tap();
      await expect(overlay).toHaveCount(0);
      await expect(page).toHaveURL(listUrl);
      await expect(trigger).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
      const restored = (await row.boundingBox())!;
      expect(restored.height).toBeCloseTo(bounds.height, 0);
      expect(restored.y).toBeCloseTo(bounds.y, 0);
      expect(await row.locator(".list-money").allTextContents()).toEqual(amounts);
      await record(page, info, { feature: "list-record-overlay-return", reducedMotion, identity, amounts, scroll, bounds, restored });
    }
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test("320px and 200% text in " + theme + ": long order identifiers remain complete in the overlay", async ({ page, manifest }, info) => {
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
      await page.route(manifest.origin + "/api/admin/v1/orders/" + original.order_id, route => route.fulfill({ json: { data: { ...original, merchant_order_no: merchantOrderNo } } }));
      await page.evaluate(theme => localStorage.setItem("perpay:theme", theme), theme);
      await page.goto(manifest.origin + "/admin/orders?q=" + encodeURIComponent(original.product_name.slice(0, 24)));
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const row = page.locator('[data-business-row="' + original.order_id + '"]');
      const trigger = row.locator("a[data-row-link]");
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText(original.product_name);
      await expect(row.getByText(merchantOrderNo, { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "展开信息", exact: true })).toHaveCount(0);
      const listUrl = page.url();
      await trigger.tap();
      const overlay = page.locator("[data-overlay-content]");
      await expect(overlay).toBeVisible();
      await expect(overlay.getByRole("heading", { level: 1 })).toHaveText(original.product_name);
      const title = await completeText(overlay.locator("[data-overlay-detail]").getByText(original.product_name, { exact: true }));
      const reference = await completeText(overlay.getByText(merchantOrderNo, { exact: true }));
      expect(new Set(reference.lines.map(line => Math.round(line.top))).size).toBeGreaterThan(1);
      const close = overlay.locator('[data-slot="dialog-close"]');
      const touch = await expectTouchTarget(close);
      await record(page, info, { feature: "list-overlay-long-text", width: 320, textPercent: 200, theme, title, reference, touch, fixture: "Existing isolated order with a synthetic 64-character merchant reference in list and detail" });
      const path = info.outputPath("list-overlay-320-" + theme + ".png");
      await page.screenshot({ path, fullPage: true });
      await info.attach("list-overlay-320-" + theme, { path, contentType: "image/png" });
      await close.tap();
      await expect(overlay).toHaveCount(0);
      await expect(page).toHaveURL(listUrl);
      await expect(trigger).toBeFocused();
    });
  }
});
