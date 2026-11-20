import { detailSection, revealDetailSection } from "./detail-layout";
import { test, expect, login, record } from "./fixtures";
import { test as browserTest } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import type { AdminLedgerDetail, AdminOrderDetail } from "../web/src/api/generated/types.gen";

const currency = (cents: number | null) => cents === null ? "—" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 }).format(cents / 100);
// A record states its times to the second.
const timestamp = (value: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

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
    const websiteOrder = orderOverlay.getByRole("region", { name: "订单信息", exact: true });
    await expect(websiteOrder).toBeVisible();
    await expect(websiteOrder.getByText("下单金额", { exact: true }).locator("..").locator("dd")).toHaveText(currency(order.requested_amount_cents));
    await expect(websiteOrder.getByText("加价金额", { exact: true }).locator("..").locator("dd")).toHaveText(currency(order.payable_amount_cents - order.requested_amount_cents));
    const payment = orderOverlay.getByRole("group", { name: "PerPay 收款状态", exact: true });
    await expect(payment.getByText("应付", { exact: true }).locator("..")).toContainText(currency(order.payable_amount_cents));
    await expect(payment.getByText("实收", { exact: true }).locator("..")).toContainText(currency(order.received_amount_cents));
    await expect(websiteOrder.getByText("商户订单号", { exact: true }).locator("..")).toContainText(order.merchant_order_no);
    await expect(websiteOrder.getByText("有效期至", { exact: true }).locator("..").locator("dd")).toHaveText(timestamp(order.checkout.expires_at));
    const website = websiteOrder.getByText("业务网站", { exact: true }).locator("..").getByRole("link");
    await expect(website).toHaveText(order.site_name!);
    expect(new URL((await website.getAttribute("href"))!, manifest.origin).searchParams.get("overlay")).toBe("/sites/" + order.api_client_id + "/summary");
    await expect(page.getByText(/数据截至/)).toHaveCount(0);
    const orderPath = info.outputPath(`order-sources-${width}.png`);
    await websiteOrder.screenshot({ path: orderPath });
    await info.attach(`order-sources-${width}`, { path: orderPath, contentType: "image/png" });
    await revealDetailSection(page, "payments");
    // Each association in force is a record of its own; reversed ones stay folded away.
    const associations = detailSection(page, "payments").getByRole("article").filter({ has: page.getByRole("heading", { name: "收款关联记录", exact: true }) });
    await expect(associations).toHaveCount(matches.length);
    for (const [index, match] of matches.entries()) {
      const association = associations.nth(index);
      await expect(association).toHaveAttribute("id", "match-" + match.payment_match_id);
      // The disclosure's name ends with how many facts it holds.
      const credentials = association.getByRole("button", { name: /^核对凭据/ });
      if (await credentials.count()) {
        await credentials.click();
        await expect(credentials).toHaveAttribute("aria-expanded", "true");
      }
      await expect(association.getByText("支付宝交易金额", { exact: true }).locator("..")).toContainText(currency(match.ledger_entry.amount_cents));
      await expect(association.getByText("支付宝订单号", { exact: true }).locator("..").locator("dd")).toContainText(match.ledger_entry.provider_order_no ?? "未提供");
      await expect(association.getByText("支付宝交易对方", { exact: true }).locator("..").locator("dd")).toHaveText(match.ledger_entry.other_account ?? "未提供");
    }
    await record(page, info, { feature: "order-provenance", width, orderId: order.order_id, website: order.api_client_id, requested: order.requested_amount_cents, payable: order.payable_amount_cents, received: order.received_amount_cents, ledgerSources: matches.map(match => match.ledger_entry_id) });

    await page.goto(manifest.origin + "/admin" + ledgerRoute);
    await expectOverlayTarget(page, "/reconciliation/transactions/" + selectedMatch.ledger_entry_id + "#source-" + selectedMatch.ledger_entry_id);
    const ledgerOverlay = await settleOverlay(page);
    // What Alipay reports leads the record: the amount and the time in its summary, Alipay's own numbers under the transaction.
    const summary = ledgerOverlay.getByRole("group", { name: "流水概况", exact: true });
    await expect(ledgerOverlay.getByRole("heading", { level: 1 })).toHaveText(/^支付宝收款/);
    await expect(summary.locator("[data-record-summary-value]")).toHaveText("+" + currency(grouped.amount_cents));
    await expect(summary.locator("time")).toHaveText(timestamp(grouped.occurred_at!));
    const transaction = await revealDetailSection(page, "transaction");
    for (const label of ["对方", "支付宝流水号", "支付宝订单号"]) {
      await expect(transaction.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(transaction).toContainText(grouped.external_event_id);
    // PerPay's own identifier belongs to the stored copy, not to what Alipay reports.
    await expect(summary.getByText(selectedMatch.ledger_entry_id)).toHaveCount(0);
    await expect(transaction.getByText("PerPay 流水编号", { exact: true })).toHaveCount(0);
    const ledgerPath = info.outputPath(`ledger-sources-${width}.png`);
    await transaction.screenshot({ path: ledgerPath });
    await info.attach(`ledger-sources-${width}`, { path: ledgerPath, contentType: "image/png" });
    const sources = await revealDetailSection(page, "sources");
    await expect(sources.getByRole("heading", { level: 2 })).toContainText("采集记录");
    // A single stored copy is the record itself; several are told apart, and the address names the one the order uses.
    const several = grouped.sources.length > 1;
    await expect(sources.locator('article[id^="source-"]')).toHaveCount(several ? grouped.sources.length : 0);
    const sourceId = selectedMatch.ledger_entry_id;
    const source = several ? sources.locator('article[id="source-' + sourceId + '"]') : sources;
    if (!several) await expect(source.getByText("PerPay 记录状态", { exact: true })).toBeVisible();
    await expect(source.getByText("PerPay 流水编号", { exact: true })).toBeVisible();
    await expect(source.getByText(sourceId, { exact: true })).toBeVisible();
    await expect(source.getByRole("button", { name: "复制PerPay 流水编号", exact: true })).toBeVisible();
    await expect(sources.locator("[data-ledger-freshness]")).toContainText("最近查账成功：");
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
