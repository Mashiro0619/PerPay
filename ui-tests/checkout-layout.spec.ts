import { test, expect, record } from "./fixtures";
test("checkout keeps one query before order information on phones and scales the desktop card and QR", async ({ page, manifest }, info) => {
  for (const [width, height] of [[360, 560], [390, 664], [320, 720], [390, 844], [430, 720], [768, 768], [1023, 768], [1024, 768], [1280, 800], [1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    const query = page.getByRole("button", { name: "我已付款，查询状态", exact: true });
    await expect(query).toBeVisible();
    await expect(query).toHaveCount(1);
    const bounds = await page.evaluate(() => {
      const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
      return { card: rect("[data-checkout-layout]"), amount: rect("[data-checkout-amount]"), qr: rect("[data-qr-image]"),
        actions: rect("[data-checkout-actions]"), summary: rect("[data-checkout-summary]") };
    });
    expect(bounds.qr.width).toBe(
      width! >= 1280
        ? 256
        : width! >= 1024
          ? 224
          : width! >= 768
            ? 200
            : Math.max(164, Math.min(height! - 368, 212)),
    );
    const alipayLaunch = page.locator("[data-alipay-launch]");
    if (width! < 768) {
      await expect(alipayLaunch).toBeVisible();
      expect(bounds.amount.y).toBeLessThan(bounds.qr.y);
      expect(bounds.actions.bottom).toBeLessThanOrEqual(bounds.summary.y);
      if (width === 360 && height === 560 || width === 390 && height === 664) expect((await query.boundingBox())!.y + (await query.boundingBox())!.height).toBeLessThanOrEqual(height!);
    } else {
      await expect(alipayLaunch).toBeHidden();
      expect(bounds.summary.x).toBeGreaterThan(bounds.qr.x);
      const maxOuter = width! >= 1280 ? 928 : width! >= 1024 ? 864 : 784;
      expect(bounds.card.width).toBe(Math.min(maxOuter, width!) - 48);
      expect(Math.abs(bounds.actions.bottom - bounds.card.bottom)).toBeLessThanOrEqual(1);
      expect(bounds.summary.y).toBeGreaterThanOrEqual(bounds.card.y - 1);
      expect(bounds.summary.bottom).toBeLessThanOrEqual(bounds.card.bottom + 1);
    }
    await record(page, info, bounds);
    await info.attach(`checkout-${width}-${height}`, { body: await page.screenshot(), contentType: "image/png" });
  }
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto(manifest.origin + manifest.checkouts.open!);
  await page.getByRole("button", { name: "放大二维码" }).click();
  const dialog = page.getByRole("dialog", { name: "付款二维码", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("p").filter({ hasText: "¥" })).toHaveCount(1);
  expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(528);
  const title = dialog.getByRole("heading", { name: "付款二维码", exact: true });
  const close = dialog.getByRole("button", { name: "关闭二维码", exact: true });
  const titleBox = (await title.boundingBox())!, closeBox = (await close.boundingBox())!;
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(closeBox.x);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "放大二维码" })).toBeFocused();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存二维码" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});

test("checkout copies the exact payable amount on phone and desktop", async ({ page, manifest }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  for (const width of [320, 1024]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    const amount = (await page.locator("[data-payable-amount]").innerText()).replace(/[¥,]/g, "");
    await page.getByRole("button", { name: "复制应付金额", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(amount);
    await expect(page.getByText("已复制", { exact: true })).toHaveCount(1);
  }
});

test("mobile checkout upgrades to a direct alipays:// scheme link after payload sync", async ({ page, manifest }) => {
  const apiPath = manifest.checkouts.open!.replace("/checkout/", "/api/public/v1/checkouts/");
  await page.route("**" + apiPath, async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers(), date: new Date(manifest.epoch).toUTCString() };
    await route.fulfill({ response, headers });
  });
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto(manifest.origin + manifest.checkouts.open!);
  await expect(page.locator("[data-alipay-launch]")).toBeVisible();
  await page.clock.runFor(1_600);
  const mobileLaunch = page.locator("a[data-alipay-launch]");
  await expect(mobileLaunch).toBeVisible();
  await expect(mobileLaunch).toHaveAttribute(
    "href",
    /^alipays:\/\/platformapi\/startapp\?saId=10000007&qrcode=https%3A%2F%2Fqr\.alipay\.com%2F/,
  );
});
