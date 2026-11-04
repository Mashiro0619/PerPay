import { renderSVG } from "uqr";
import { renderCheckoutPage } from "../src/http/web/checkout.ts";
import type { CheckoutViewOrder } from "../src/shared/checkout-view.ts";
import type { Page, Locator } from "@playwright/test";
import { test, expect, record, type Manifest } from "./fixtures";

const layouts = [
  { width: 1440, height: 900, font: 100, theme: "dark" },
  { width: 390, height: 844, font: 100, theme: "light" },
  { width: 320, height: 560, font: 200, theme: "light" },
  { width: 640, height: 280, font: 150, theme: "dark" },
] as const;

async function validCheckout(page: Page, manifest: Manifest, requested: number, payable: number) {
  const checkoutPath = manifest.checkouts.open!;
  const apiPath = checkoutPath.replace("/checkout/", "/api/public/v1/checkouts/");
  const response = await page.request.get(manifest.origin + apiPath);
  expect(response.status()).toBe(200);
  const { data } = await response.json() as { data: CheckoutViewOrder };
  const order: CheckoutViewOrder = {
    ...data,
    requested_amount_cents: requested,
    payment_instructions: { payable_amount_cents: payable, currency: "CNY" },
  };
  await page.route(manifest.origin + apiPath, route => route.fulfill({
    status: 200, headers: { date: new Date(manifest.epoch).toUTCString() }, json: { data: order },
  }));
  await page.route(manifest.origin + checkoutPath, async route => {
    const original = await route.fetch();
    const headers = { ...original.headers() }; delete headers["content-length"];
    return route.fulfill({ response: original, headers, body: renderCheckoutPage({
      serverTime: manifest.epoch, demoMode: true, systemName: "PerPay",
      checkoutToken: checkoutPath.split("/").at(-1)!,
      checkout: {
        merchantOrderNo: order.merchant_order_no, requestedAmountCents: requested,
        currency: "CNY", productName: order.product_name, returnUrl: order.return_url,
        paymentInstructions: { payableAmountCents: payable, currency: "CNY", collectionCodePayload: "UI responsiveness regression only; do not pay" },
        checkout: { status: "OPEN", expiresAt: Date.parse(order.checkout.expires_at), closedAt: null },
        payment: { status: order.payment.status, basis: order.payment.basis, receivedAmountCents: order.payment.received_amount_cents },
        refund: order.refund,
      },
      qrImageUrl: apiPath + "/qr.svg", initialError: null,
    }) });
  });
}

async function readableMoney(locator: Locator, expected: string) {
  await expect(locator).toHaveText(expected);
  const bounds = await locator.evaluate(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    const clipped = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!/hidden|clip|auto|scroll/.test(getComputedStyle(ancestor).overflowX)) continue;
      const clip = ancestor.getBoundingClientRect();
      if (text.left < clip.left - 1 || text.right > clip.right + 1) clipped.push(ancestor.tagName);
    }
    return { textLeft: text.left, textRight: text.right, left: box.left, right: box.right,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clipped };
  });
  expect(bounds.textLeft).toBeGreaterThanOrEqual(bounds.left - 1);
  expect(bounds.textRight).toBeLessThanOrEqual(bounds.right + 1);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
  expect(bounds.clipped).toEqual([]);
}

test("checkout renders both legal payable boundaries completely before hydration under its CSP", async ({ browser, manifest }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 560 }, locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    for (const [requested, payable, expected] of [[9999999998, 9999999999, "¥99,999,999.99"], [1, 2, "¥0.02"]] as const) {
      await validCheckout(page, manifest, requested, payable);
      const response = await page.goto(manifest.origin + manifest.checkouts.open!);
      expect(response?.headers()["content-security-policy"]).toContain("style-src-attr 'none'");
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await page.evaluate(() => document.fonts.ready);
      await readableMoney(page.locator("[data-payable-amount]"), expected);
      await expect(page.getByRole("button", { name: "放大二维码" })).toHaveCount(0);
      await record(page, info, { javascript: false, requested, payable });
      await info.attach(`checkout-ssr-boundary-${payable}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  } finally { await context.close(); }
});

test("checkout retains the exact maximum amount and a complete QR on enlarged and short screens", async ({ page, manifest }, info) => {
  await validCheckout(page, manifest, 9999999998, 9999999999);
  await page.route("**/qr.svg*", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: renderSVG("UI responsiveness regression only; do not pay", { border: 4 }) }));
  for (const layout of layouts) {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.goto(manifest.origin + manifest.checkouts.open!);
    await page.evaluate(({ font, theme }) => {
      document.documentElement.style.fontSize = font + "%";
      localStorage.setItem("perpay:theme", theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, layout);
    await page.evaluate(() => document.fonts.ready);
    await readableMoney(page.locator("[data-payable-amount]"), "¥99,999,999.99");
    await page.getByRole("button", { name: "放大二维码", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "支付宝付款二维码" });
    await expect(dialog).toBeVisible();
    await readableMoney(dialog.locator("[data-checkout-money-digits]"), "¥99,999,999.99");
    const geometry = await dialog.evaluate(element => {
      const rect = (selector: string) => {
        const bounds = element.querySelector(selector)!.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
      };
      const body = element.querySelector("[data-qr-dialog-body]")!;
      return { image: rect("[data-qr-dialog-image]"), body: rect("[data-qr-dialog-body]"), close: rect('[data-slot="dialog-close"]'),
        bodyClientHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight, viewportHeight: innerHeight, viewportWidth: innerWidth };
    });
    expect(geometry.image.width).toBeGreaterThanOrEqual(96);
    expect(Math.abs(geometry.image.width - geometry.image.height)).toBeLessThan(1);
    expect(geometry.image.left).toBeGreaterThanOrEqual(geometry.body.left - 1);
    expect(geometry.image.right).toBeLessThanOrEqual(geometry.body.right + 1);
    expect(geometry.image.top).toBeGreaterThanOrEqual(geometry.body.top - 1);
    expect(geometry.image.bottom).toBeLessThanOrEqual(geometry.body.bottom + 1);
    expect(geometry.image.top).toBeGreaterThanOrEqual(0);
    expect(geometry.image.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.bodyScrollHeight).toBeLessThanOrEqual(geometry.bodyClientHeight + 1);
    const overlap = geometry.image.left < geometry.close.right && geometry.image.right > geometry.close.left && geometry.image.top < geometry.close.bottom && geometry.image.bottom > geometry.close.top;
    expect(overlap).toBe(false);
    await record(page, info, { layout, geometry, requested: 9999999998, payable: 9999999999 });
    await info.attach(`complete-expanded-qr-${layout.width}-${layout.font}`, { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "放大二维码", exact: true })).toBeFocused();
  }
});

test("a failed checkout QR is replaced and its retried image remains downloadable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let fail = true;
  await page.route("**/qr.svg*", route => route.fulfill(fail ? { status: 404, body: "" } : {
    status: 200, contentType: "image/svg+xml", body: renderSVG("UI retry regression only; do not pay", { border: 4 }),
  }));
  await page.goto(manifest.origin + manifest.checkouts.open!);
  await expect(page.getByText("二维码加载失败", { exact: true })).toBeVisible();
  await expect(page.locator("[data-qr-image]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "放大二维码", exact: true })).toHaveCount(0);
  await record(page, info, { state: "qr-failed" });
  await info.attach("qr-replaced-failure", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  fail = false;
  await page.getByRole("button", { name: "重新加载二维码", exact: true }).click();
  await expect(page.getByText("二维码加载失败", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.locator("[data-qr-image]").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存二维码", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.png$/);
  await page.getByRole("button", { name: "放大二维码", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "支付宝付款二维码" })).toBeVisible();
  await record(page, info, { state: "qr-recovered-and-downloaded" });
});
