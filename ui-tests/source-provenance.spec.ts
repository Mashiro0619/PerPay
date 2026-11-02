import { test, expect, login, record } from "./fixtures";
import { test as browserTest } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import type { AdminLedgerDetail, AdminOrderDetail } from "../web/src/api/generated/types.gen";

const currency = (cents: number | null) => cents === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(cents / 100);
const timestamp = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));

test("order and ledger sources remain distinct at desktop and 320 pixels", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const orderRoute = manifest.details.orderPaid;
  expect(orderRoute).toBeDefined();
  const orderResponse = await page.request.get(manifest.origin + "/api/admin/v1" + orderRoute);
  expect(orderResponse.status()).toBe(200);
  const order = (await orderResponse.json() as { data: AdminOrderDetail }).data;
  const matches = order.reconciliation.matches.filter(match => match.status === "SETTLED");
  expect(matches.length).toBeGreaterThan(0);
  const selectedMatch = matches[0]!;
  const ledgerResponse = await page.request.get(manifest.origin + "/api/admin/v1/ledger/entries/" + selectedMatch.ledger_entry_id);
  expect(ledgerResponse.status()).toBe(200);
  const grouped = (await ledgerResponse.json() as { data: AdminLedgerDetail }).data;
  expect(grouped.matches.some(match => match.payment_match_id === selectedMatch.payment_match_id && match.order_id === order.order_id)).toBe(true);
  const ledgerRoute = "/reconciliation/ledger/" + selectedMatch.ledger_entry_id;
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin" + orderRoute);
    await expectOverlayTarget(page, orderRoute!);
    const orderOverlay = await settleOverlay(page);
    const calculated = orderOverlay.getByRole("region", { name: "金额明细", exact: true });
    await expect(calculated.getByText("下单金额", { exact: true }).locator("..").locator("dd")).toHaveText(currency(order.requested_amount_cents));
    await expect(calculated.getByText("加价金额", { exact: true }).locator("..").locator("dd")).toHaveText(currency(order.payable_amount_cents - order.requested_amount_cents));
    const payment = orderOverlay.getByRole("group", { name: "PerPay 收款状态", exact: true });
    await expect(payment.getByText("应付", { exact: true }).locator("..")).toContainText(currency(order.payable_amount_cents));
    await expect(payment.getByText("实收", { exact: true }).locator("..")).toContainText(currency(order.received_amount_cents));
    const websiteOrder = orderOverlay.getByRole("region", { name: "订单信息", exact: true });
    await expect(websiteOrder.getByText("商户订单号", { exact: true }).locator("..")).toContainText(order.merchant_order_no);
    await expect(websiteOrder.getByText("有效期至", { exact: true }).locator("..").locator("dd")).toHaveText(timestamp(order.checkout.expires_at));
    const website = websiteOrder.getByText("业务网站", { exact: true }).locator("..").getByRole("link");
    await expect(website).toHaveText(order.site_name!);
    expect(new URL((await website.getAttribute("href"))!, manifest.origin).searchParams.get("overlay")).toBe("/sites/" + order.api_client_id + "/summary");
    await expect(page.getByText(/数据截至/)).toHaveCount(0);
    const amountPath = info.outputPath(`amount-sources-${width}.png`);
    await calculated.screenshot({ path: amountPath });
    await info.attach(`amount-sources-${width}`, { path: amountPath, contentType: "image/png" });
    const orderPath = info.outputPath(`order-sources-${width}.png`);
    await websiteOrder.screenshot({ path: orderPath });
    await info.attach(`order-sources-${width}`, { path: orderPath, contentType: "image/png" });
    await orderOverlay.getByRole("tab", { name: /^收款关联/ }).click();
    const associations = orderOverlay.getByRole("tabpanel").locator('[aria-label="收款关联记录"]');
    await expect(associations).toHaveCount(matches.length);
    for (const [index, match] of matches.entries()) {
      const association = associations.nth(index);
      await expect(association.getByText("支付宝交易金额", { exact: true }).locator("..")).toContainText(currency(match.ledger_entry.amount_cents));
      await expect(association.getByText("支付宝订单号", { exact: true }).locator("..").locator("dd")).toContainText(match.ledger_entry.provider_order_no ?? "未提供");
      await expect(association.getByText("支付宝交易对方", { exact: true }).locator("..").locator("dd")).toHaveText(match.ledger_entry.other_account ?? "未提供");
    }
    await record(page, info, { feature: "order-provenance", width, orderId: order.order_id, website: order.api_client_id, requested: order.requested_amount_cents, payable: order.payable_amount_cents, received: order.received_amount_cents, ledgerSources: matches.map(match => match.ledger_entry_id) });

    await page.goto(manifest.origin + "/admin" + ledgerRoute);
    await expectOverlayTarget(page, "/reconciliation/transactions/" + selectedMatch.ledger_entry_id + "#source-" + selectedMatch.ledger_entry_id);
    const ledgerOverlay = await settleOverlay(page);
    await ledgerOverlay.getByRole("tab", { name: "交易", exact: true }).click();
    const ledger = ledgerOverlay.locator("[data-ledger-summary]");
    await expect(ledger.getByRole("heading", { name: "支付宝交易", exact: true })).toBeVisible();
    for (const label of ["交易金额", "交易时间", "支付宝订单号", "对方"]) {
      await expect(ledger.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(ledger).toContainText(grouped.external_event_id);
    await expect(ledger.getByText("交易金额", { exact: true }).locator("..").locator("dd")).toHaveText(currency(grouped.amount_cents));
    await expect(ledger.locator("[data-ledger-freshness]")).toContainText("最近查账成功：");
    await expect(ledger.getByText("内部流水编号（PerPay）", { exact: true })).toHaveCount(0);
    const ledgerPath = info.outputPath(`ledger-sources-${width}.png`);
    await ledger.screenshot({ path: ledgerPath });
    await info.attach(`ledger-sources-${width}`, { path: ledgerPath, contentType: "image/png" });
    await ledgerOverlay.getByRole("tab", { name: /^采集记录/ }).click();
    await expect(ledgerOverlay.locator("#ledger-sources-heading")).toContainText("查账记录");
    await expect(ledgerOverlay.locator("[data-ledger-source]")).toHaveCount(grouped.sources.length);
    const source = ledgerOverlay.locator('[data-ledger-source="' + selectedMatch.ledger_entry_id + '"]');
    const sourceId = await source.getAttribute("data-ledger-source");
    expect(sourceId).toBe(selectedMatch.ledger_entry_id);
    await expect(source.getByText("PerPay 记录状态", { exact: true })).toBeVisible();
    await expect(source.getByText("内部流水编号（PerPay）", { exact: true })).toBeVisible();
    await expect(source.getByText(sourceId!, { exact: true })).toBeVisible();
    await expect(source.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true })).toBeVisible();
    await record(page, info, { feature: "ledger-provenance", width, sourceId, transaction: grouped.external_event_id, sourceCount: grouped.sources.length });
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
