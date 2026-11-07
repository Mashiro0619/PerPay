import { test, expect, login, record } from "./fixtures";
import { settleOverlay } from "./overlay-fixtures";
import type { AdminOrderDetailEnvelope } from "../web/src/api/generated/types.gen";

test("mobile summaries and details retain accurate amounts across desktop column preferences and reloads", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  const response = await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details.orderPaid!);
  expect(response.status()).toBe(200);
  const order = (await response.json() as AdminOrderDetailEnvelope).data;
  expect(order.payable_amount_cents).toBeGreaterThan(0);
  expect(order.received_amount_cents).toBeGreaterThan(0);
  expect(order.received_amount_cents).toBe(order.payable_amount_cents);
  const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 });
  const payable = money.format(order.payable_amount_cents / 100);
  const received = money.format(order.received_amount_cents! / 100);
  await page.goto(manifest.origin + "/admin/orders?q=" + encodeURIComponent(order.order_id));
  const row = page.locator('[data-business-row="' + order.order_id + '"]');
  const aside = row.locator(".list-summary-aside");
  const expectSummaryAmounts = async () => {
    await expect(aside.getByText("实收", { exact: true })).toBeVisible();
    await expect(aside.getByRole("group", { name: "应付金额 " + payable, exact: true })).toHaveCount(0);
    await expect(aside.getByRole("group", { name: "实收金额 " + received, exact: true })).toHaveText(received);
    await expect(aside.locator(".list-money")).toHaveCount(1);
  };
  await expectSummaryAmounts();
  await page.getByRole("button", { name: "更多订单操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "列表显示", exact: true }).click();
  const display = page.getByRole("dialog", { name: "列表显示", exact: true });
  await expect(display).toBeVisible();
  await expect(display.getByRole("checkbox")).toHaveCount(0);
  await expect(display.getByRole("group", { name: "列表密度", exact: true })).toBeVisible();
  await display.getByRole("button", { name: "完成", exact: true }).click();
  await expect(display).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
  await page.getByRole("button", { name: "列表显示", exact: true }).click();
  await display.getByRole("checkbox", { name: "实收金额", exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await expect(display).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "实收金额" })).toHaveCount(0);
  await expect(row.getByRole("group", { name: "实收金额 " + received, exact: true })).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 720 });
  await expectSummaryAmounts();
  await page.reload();
  await expectSummaryAmounts();
  await row.locator("a[data-row-link]").click();
  const detail = await settleOverlay(page);
  const amounts = detail.getByRole("group", { name: "PerPay 收款状态", exact: true });
  await expect(amounts.getByText("应付", { exact: true }).locator("..").locator(".list-money")).toHaveText(payable);
  await expect(amounts.getByText("实收", { exact: true }).locator("..").locator(".list-money")).toHaveText(received);
  await record(page, info, { orderId: order.order_id, payableAmountCents: order.payable_amount_cents, receivedAmountCents: order.received_amount_cents });
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "列表显示", exact: true }).click();
  await display.getByRole("button", { name: "恢复默认列", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(display).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("columnheader", { name: "实收金额" })).toBeVisible();
  await expect(row.getByRole("group", { name: "实收金额 " + received, exact: true })).toHaveText(received);
});
