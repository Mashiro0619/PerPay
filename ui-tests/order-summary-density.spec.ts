import type { Locator } from "@playwright/test";
import type { AdminOrderSummary } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

test.use({ hasTouch: true, isMobile: true });

async function measureSummary(row: Locator) {
  return row.evaluate(element => {
    const frame = element.getBoundingClientRect();
    const identity = element.querySelector('.list-summary-identity')!.getBoundingClientRect();
    const payment = element.querySelector('.list-summary-aside')!.getBoundingClientRect();
    const values = [...element.querySelectorAll('.list-primary-link, .list-money, time, .list-site-identity, [data-slot="badge"]')].map(value => {
      const rect = value.getBoundingClientRect();
      return { text: value.textContent, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const overlaps = values.flatMap((a, index) => values.slice(index + 1).filter(b =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
    ).map(b => [a.text, b.text]));
    // Inline box widths alone can miss overflowing text inside an unbreakable amount.
    const moneyText = [...element.querySelectorAll('.list-money')].flatMap(value => {
      const range = document.createRange();
      range.selectNodeContents(value);
      return [...range.getClientRects()].map(rect => ({ text: value.textContent, left: rect.left, right: rect.right }));
    });
    return {
      height: frame.height, left: frame.left, right: frame.right, values, moneyText, overlaps,
      separateGroups: Math.min(identity.right, payment.right) - Math.max(identity.left, payment.left) <= 1 ||
        Math.min(identity.bottom, payment.bottom) - Math.max(identity.top, payment.top) <= 1,
      sideBySide: identity.right <= payment.left + 1,
    };
  });
}

function expectReadableSummary(geometry: Awaited<ReturnType<typeof measureSummary>>) {
  expect(geometry.separateGroups, "identity and payment remain distinct reading groups").toBe(true);
  expect(geometry.overlaps, "title, metadata, amounts and badges must not cover each other").toEqual([]);
  for (const value of [...geometry.values, ...geometry.moneyText]) {
    expect(value.left, value.text ?? "value").toBeGreaterThanOrEqual(geometry.left - 1);
    expect(value.right, value.text ?? "value").toBeLessThanOrEqual(geometry.right + 1);
  }
}

test("mobile orders group identity and payment without duplicate equal amounts", async ({ page, manifest }, info) => {
  const paidId = manifest.details.orderPaid!.split("/").at(-1)!;
  const longId = manifest.details.orderLong!.split("/").at(-1)!;
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page, manifest);
  for (const width of [423, 390, 320]) for (const font of [100, 200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/orders");
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", font);
    const row = page.locator('[data-business-row]').filter({ has: page.locator(`a[data-row-link][href*="${paidId}"]`) });
    const longRow = page.locator('[data-business-row]').filter({ has: page.locator(`a[data-row-link][href*="${longId}"]`) });
    await expect(row).toHaveCount(1);
    await expect(longRow).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);
    await expect(row.getByRole("group", { name: /^实收金额 / })).toBeVisible();
    await expect(row.getByRole("group", { name: /^应付金额 / })).toHaveCount(0);
    await expect(row.locator('.list-money')).toHaveCount(1);
    await expect(row.locator('[data-summary-status]')).toContainText("收款已确认");
    await expect(row.locator('time[datetime]')).toBeVisible();
    await expect(longRow.getByRole("group", { name: /^应付金额 / })).toBeVisible();
    await expect(longRow.getByRole("group", { name: /^实收金额 / })).toHaveCount(0);
    const geometry = await measureSummary(row);
    const longGeometry = await measureSummary(longRow);
    expectReadableSummary(geometry);
    expectReadableSummary(longGeometry);
    if (font === 100) {
      expect(geometry.height, "ordinary orders remain compact").toBeLessThanOrEqual(width === 320 ? 160 : 140);
      expect(geometry.sideBySide).toBe(true);
      expect(longGeometry.sideBySide).toBe(true);
    }
    const site = row.locator("a.list-site-identity");
    await site.scrollIntoViewIfNeeded();
    await page.clock.runFor(100);
    await expectTouchTarget(site);
    await page.screenshot({ path: info.outputPath(`orders-${width}-${font}.png`), animations: "disabled" });
    await record(page, info, { feature: "order-summary-reading-groups", width, font, geometry, longGeometry });
  }
});

test("mobile order amounts and refund marks remain readable with long names and extreme receipts", async ({ page, manifest }, info) => {
  const paidId = manifest.details.orderPaid!.split("/").at(-1)!;
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page, manifest);
  await page.route("**/api/admin/v1/orders?*", async route => {
    const response = await route.fetch();
    const body = await response.json() as { data: AdminOrderSummary[] };
    body.data = body.data.map(order => order.order_id === paidId ? {
      ...order,
      product_name: "跨部门协作与知识管理专业版（多语言同步、自动提醒、项目模板与长周期团队授权） / Team Collaboration Professional Edition",
      site_name: "面向跨部门协作与知识管理的业务网站",
      received_amount_cents: Number.MAX_SAFE_INTEGER,
      payment: { ...order.payment, received_amount_cents: Number.MAX_SAFE_INTEGER },
      refund_mark: { ...order.refund_mark, marked: true },
    } : order);
    await route.fulfill({ response, json: body });
  });
  for (const width of [423, 390, 320]) for (const font of [100, 200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/orders");
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", font);
    const row = page.locator('[data-business-row]').filter({ has: page.locator(`a[data-row-link][href*="${paidId}"]`) });
    await expect(row.getByText("已标记退款", { exact: true })).toBeVisible();
    await expect(row.getByText("多收", { exact: true })).toBeVisible();
    await expect(row.getByRole("group", { name: /^差额 / })).toBeVisible();
    await expect(row.getByRole("group", { name: /^应付金额 / })).toBeVisible();
    await expect(row.getByRole("group", { name: /^实收金额 / })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);
    const geometry = await measureSummary(row);
    expectReadableSummary(geometry);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`extreme-orders-${width}-${font}.png`), animations: "disabled" });
    await record(page, info, { feature: "order-summary-extreme-receipt", width, font, geometry });
  }
});
