import { test, expect, record } from "./fixtures";
import { screenshot } from "./audit";

test("script-disabled SSR keeps payments guarded and system dark styling usable", async ({ browser, manifest }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark", viewport: { width: 390, height: 664 } });
  try {
    const page = await context.newPage();
    await page.goto(manifest.origin + manifest.checkouts.open!);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("请暂勿付款");
    await expect(page.locator("[data-qr-image]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "刷新页面" })).toBeVisible();
    const geometry = await record(page, info, { javascript: false });
    expect(geometry.theme).toBe("dark");
    await screenshot(page, info, "checkout-no-script");
  } finally { await context.close(); }
});

test("QR and download failures recover, and an expired checkout can still confirm without restoring its QR", async ({ page, manifest }, info) => {
  await page.route("**/api/public/v1/checkouts/*/qr.svg*", route => route.abort());
  await page.goto(manifest.origin + manifest.checkouts.expiringSoon!);
  await expect(page.getByText("二维码加载失败", { exact: true })).toBeVisible();
  await page.unroute("**/api/public/v1/checkouts/*/qr.svg*");
  await page.getByRole("button", { name: "重新加载二维码" }).click();
  await expect.poll(() => page.locator("[data-qr-image]").evaluate(e => (e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = function (callback) { callback(null); }; });
  await page.getByRole("button", { name: "保存二维码" }).click();
  await expect(page.getByText(/无法生成 PNG/)).toBeVisible();
  await page.reload();
  await expect(page.locator("[data-qr-image]")).toBeVisible();
  const apiPath = manifest.checkouts.expiringSoon!.replace("/checkout/", "/api/public/v1/checkouts/");
  const received = await page.request.get(manifest.origin + apiPath);
  const publicOrder = (await received.json()).data;
  await page.context().setOffline(true);
  await expect(page.getByRole("button", { name: "查询付款状态", exact: true })).toBeDisabled();
  await page.context().setOffline(false);
  await expect(page.getByRole("button", { name: "查询付款状态", exact: true })).toBeEnabled();
  await page.route("**" + apiPath, route => route.fulfill({ json: { data: { ...publicOrder, checkout: { ...publicOrder.checkout, status: "EXPIRED" }, payment_instructions: null } } }));
  await page.clock.setFixedTime(new Date(manifest.epoch + 121_000));
  await page.clock.runFor(121_000);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("订单已过期");
  await expect(page.locator("[data-qr-image]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查询付款状态", exact: true })).toBeEnabled();
  await page.unroute("**" + apiPath);
  await page.route("**" + apiPath, route => route.fulfill({ json: { data: { ...publicOrder, checkout: { ...publicOrder.checkout, status: "EXPIRED" },
    payment_instructions: null, payment: { status: "CONFIRMED", basis: "MANUAL", received_amount_cents: publicOrder.requested_amount_cents }, refund: { status: "PARTIAL" } } } }));
  await page.getByRole("button", { name: "查询付款状态", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("收款已确认");
  await expect(page.getByText("历史退款记录：部分", { exact: true })).toBeVisible();
  await expect(page.locator("[data-qr-image]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查询付款状态", exact: true })).toHaveCount(0);
  await record(page, info, { transition: "expired -> confirmed", refund: "partial", syntheticResponse: true });
});
