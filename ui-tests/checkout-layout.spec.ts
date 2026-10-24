import { test, expect, record } from "./fixtures";
test("checkout keeps one query before order information on phones and scales the desktop card and QR", async ({ page, manifest }, info) => {
  for (const [width, height] of [[360, 560], [390, 664], [320, 720], [390, 844], [430, 720], [768, 768], [1023, 768], [1024, 768], [1280, 800], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    const query = page.getByRole("button", { name: "查询付款状态", exact: true });
    await expect(query).toBeVisible();
    await expect(query).toHaveCount(1);
    const bounds = await page.evaluate(() => {
      const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
      return { card: rect("[data-checkout-layout]"), amount: rect("[data-checkout-amount]"), qr: rect("[data-qr-image]"),
        actions: rect("[data-checkout-actions]"), summary: rect("[data-checkout-summary]") };
    });
    expect(bounds.qr.width).toBe(width! >= 1280 ? 320 : width! >= 1024 ? 288 : Math.max(180, Math.min(height! - 360, 240)));
    if (width! < 1024) {
      expect(bounds.amount.y).toBeLessThan(bounds.qr.y);
      expect(bounds.actions.bottom).toBeLessThanOrEqual(bounds.summary.y);
      if (width === 360 && height === 560 || width === 390 && height === 664) expect((await query.boundingBox())!.y + (await query.boundingBox())!.height).toBeLessThanOrEqual(height!);
    } else {
      expect(bounds.summary.x).toBeGreaterThan(bounds.qr.x);
      expect(bounds.card.width).toBe(Math.min(width! >= 1280 ? 1152 : 1024, width!) - 48);
    }
    await record(page, info, bounds);
    await info.attach(`checkout-${width}-${height}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto(manifest.origin + manifest.checkouts.open!);
  await page.getByRole("button", { name: "放大二维码" }).click();
  const dialog = page.getByRole("dialog", { name: "支付宝付款二维码" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("p").filter({ hasText: "¥" })).toHaveCount(1);
  expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(528);
  const title = dialog.getByRole("heading", { name: "支付宝付款二维码" });
  const close = dialog.getByRole("button", { name: "关闭对话框" });
  const titleBox = (await title.boundingBox())!, closeBox = (await close.boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(closeBox.x);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "放大二维码" })).toBeFocused();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存二维码" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
