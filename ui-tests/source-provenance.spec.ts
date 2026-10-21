import { test, expect, login, record } from "./fixtures";
import { test as browserTest } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("order and ledger sources remain distinct at desktop and 320 pixels", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const orderRoute = manifest.routes.find(route => /^\/orders\/[^/]+$/.test(route));
  const ledgerRoute = manifest.routes.find(route => route.startsWith("/reconciliation/ledger/"));
  expect(orderRoute).toBeDefined();
  expect(ledgerRoute).toBeDefined();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin" + orderRoute);
    const calculated = page.getByRole("region", { name: "PerPay 计算的金额" });
    await expect(calculated.getByText("加价金额", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "业务网站传入的金额" }).getByText("下单金额", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "支付宝流水中的实收金额" }).getByText("来自支付宝流水", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "PerPay 记录的订单信息" }).getByText("收银台有效期至", { exact: true })).toBeVisible();
    await expect(page.locator("[data-ledger-freshness]")).toContainText("最近查账成功：");
    await expect(page.getByText(/数据截至/)).toHaveCount(0);
    await record(page, info, { feature: "order-provenance", width });
    const amountPath = info.outputPath(`amount-sources-${width}.png`);
    await calculated.locator("..").locator("..").screenshot({ path: amountPath });
    await info.attach(`amount-sources-${width}`, { path: amountPath, contentType: "image/png" });
    const orderPath = info.outputPath(`order-sources-${width}.png`);
    await page.getByRole("region", { name: "业务网站传入的订单信息" }).locator("..").locator("..").screenshot({ path: orderPath });
    await info.attach(`order-sources-${width}`, { path: orderPath, contentType: "image/png" });

    await page.goto(manifest.origin + "/admin" + ledgerRoute);
    await expect(page).toHaveURL(/\/admin\/reconciliation\/transactions\//);
    const ledger = page.locator("[data-ledger-summary]");
    await expect(ledger.getByRole("heading", { name: "支付宝交易", exact: true })).toBeVisible();
    for (const label of ["交易金额", "交易时间", "支付宝订单号", "对方"]) {
      await expect(ledger.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(ledger.getByText("内部流水编号（PerPay）", { exact: true })).toHaveCount(0);
    await expect(page.locator("#ledger-sources-heading")).toContainText("查账记录");
    const source = page.locator("[data-ledger-source]").first();
    const sourceId = await source.getAttribute("data-ledger-source");
    expect(sourceId).toBeTruthy();
    await expect(source.getByText("PerPay 记录状态", { exact: true })).toBeVisible();
    await expect(source.getByText("内部流水编号（PerPay）", { exact: true })).toBeVisible();
    await expect(source.getByText(sourceId!, { exact: true })).toBeVisible();
    await expect(source.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true })).toBeVisible();
    await record(page, info, { feature: "ledger-provenance", width });
    const ledgerPath = info.outputPath(`ledger-sources-${width}.png`);
    await ledger.screenshot({ path: ledgerPath });
    await info.attach(`ledger-sources-${width}`, { path: ledgerPath, contentType: "image/png" });
  }
});

browserTest("order lookup labels expose their source without clipping narrow controls", async ({ page }, info) => {
  info.setTimeout(45000);
  const fixture = await createSettingsServer(Date.now());
  try {
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fixture.origin + "/admin/orders");
      for (const label of ["商户订单号（业务网站）", "内部订单编号（PerPay）"]) {
        const mode = page.getByRole("button", { name: /^查询方式：/ });
        await mode.click();
        const option = page.getByRole("menuitemradio", { name: label, exact: true });
        await expect(option).toBeVisible();
        expect(await option.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await option.click({ timeout: 10000 });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(mode).toHaveAccessibleName("查询方式：" + label);
        if (width === 1440) await expect(mode).toHaveText(label);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.documentWidth + 1);
        await info.attach("lookup-geometry", { body: JSON.stringify({ width, label, realClock: true, ...geometry }), contentType: "application/json" });
      }
      const path = info.outputPath(`lookup-source-${width}.png`);
      await page.getByRole("search").screenshot({ path });
      await info.attach(`lookup-source-${width}`, { path, contentType: "image/png" });
    }
  } finally { await fixture.close(); }
});
