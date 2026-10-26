import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import type { AdminLedgerPageEnvelope, AdminOrderDetailEnvelope } from "../web/src/api/generated/types.gen";

async function completeText(target: Locator) {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const row = element.closest("[data-business-row]")?.getBoundingClientRect() ?? box;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: { left: number; top: number; right: number; bottom: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...Array.from(range.getClientRects(), rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })));
    }
    return { box: { top: box.top, bottom: box.bottom }, row: { left: row.left, right: row.right }, lines };
  });
  expect(geometry.lines.length, "the selected field has rendered text").toBeGreaterThan(0);
  expect(geometry.lines.every(line => line.left >= geometry.row.left - 1 && line.right <= geometry.row.right + 1), "complete field text fits the record width").toBe(true);
  expect(geometry.lines.every(line => line.top >= geometry.box.top - 1 && line.bottom <= geometry.box.bottom + 1), "complete field text fits its natural height").toBe(true);
  return geometry;
}

async function continuousRows(rows: Locator) {
  await expect(rows.nth(1)).toBeAttached();
  const geometry = await rows.evaluateAll(elements => elements.slice(0, 3).map(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
  }));
  for (let index = 1; index < geometry.length; index++) {
    const previous = geometry[index - 1]!, current = geometry[index]!;
    expect(current.top - previous.bottom, "records form consecutive rows without card-sized gaps").toBeGreaterThanOrEqual(-1);
    expect(current.top - previous.bottom, "records form consecutive rows without card-sized gaps").toBeLessThanOrEqual(1);
    expect(Math.abs(current.left - previous.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(current.right - previous.right)).toBeLessThanOrEqual(1);
    expect(current.height).toBeGreaterThanOrEqual(40);
  }
  return geometry;
}

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function show(page: Page, origin: string, path: string, textPercent: number) {
  await page.goto(origin + "/admin" + path);
  await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", textPercent);
  await expect(page.locator("[data-business-row]").first()).toBeVisible();
  await page.clock.runFor(100);
  await page.evaluate(() => document.fonts.ready);
}

test.describe("mobile consecutive record rows", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 800 }, reducedMotion: "reduce" });

  for (const width of [320, 360]) for (const textPercent of [100, 200]) {
    test(`${width}px at ${textPercent}% text: financial fields and related records remain readable and actionable`, async ({ page, manifest }, info) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 800 });
      await login(page, manifest);
      await show(page, manifest.origin, "/orders", textPercent);
      const orders = page.getByRole("list", { name: "订单列表", exact: true }).getByRole("listitem");
      const orderGeometry = await continuousRows(orders);
      const order = orders.first();
      await completeText(order.getByRole("group", { name: /^应付金额 / }));
      await completeText(order.getByRole("group", { name: /^实收金额 / }));
      await completeText(order.getByText("状态", { exact: true }));
      await completeText(order.getByText("创建时间", { exact: true }));
      await completeText(order.locator("time").first());
      await record(page, info, { feature: "mobile-consecutive-orders", width, textPercent, rows: orderGeometry });
      if (textPercent === 100) await capture(page, info, `mobile-orders-${width}`);

      await page.getByRole("button", { name: "更多订单操作", exact: true }).tap();
      await page.getByRole("menuitem", { name: "列表显示", exact: true }).tap();
      const display = page.getByRole("dialog", { name: "列表显示", exact: true });
      await display.getByRole("checkbox", { name: "PerPay 确认时间", exact: true }).check();
      await display.getByRole("button", { name: "完成", exact: true }).tap();
      await expect(display).toHaveCount(0);
      const listUrl = page.url();
      await order.getByRole("button", { name: "展开信息", exact: true }).tap();
      await expect(page).toHaveURL(listUrl);
      await expect(order.getByRole("button", { name: "收起信息", exact: true })).toHaveAttribute("aria-expanded", "true");
      await completeText(order.getByText("PerPay 确认时间", { exact: true }));
      await order.getByRole("button", { name: "收起信息", exact: true }).tap();
      const orderTarget = await order.locator("a[data-row-link]").getAttribute("href");
      await order.click({ position: { x: 3, y: 3 } });
      await expect(page).toHaveURL(manifest.origin + orderTarget);

      await show(page, manifest.origin, "/work-items", textPercent);
      const reminders = page.getByRole("list", { name: "待处理提醒列表", exact: true }).getByRole("listitem");
      const reminderGeometry = await continuousRows(reminders);
      const reminder = reminders.first();
      await expect(reminder.getByRole("link").first()).toHaveAccessibleName(/\S/);
      await completeText(reminder.locator('[data-slot="badge"]').first());
      await completeText(reminder.getByText("提醒时间", { exact: true }));
      await completeText(reminder.locator("time").first());
      await record(page, info, { feature: "mobile-consecutive-reminders", width, textPercent, rows: reminderGeometry });
      if (textPercent === 100) await capture(page, info, `mobile-reminders-${width}`);
      const reminderTarget = await reminder.locator("a[data-row-link]").getAttribute("href");
      await reminder.click({ position: { x: 3, y: 3 } });
      await expect(page).toHaveURL(manifest.origin + reminderTarget);

      const ledgerQuery = "?direction=CREDIT&association_status=MATCHED";
      const source = await page.request.get(manifest.origin + "/api/admin/v1/ledger/entries" + ledgerQuery + "&limit=20");
      expect(source.status()).toBe(200);
      const ledgerPage = await source.json() as AdminLedgerPageEnvelope;
      expect(ledgerPage.data.length).toBeGreaterThan(1);
      const entry = ledgerPage.data[0]!;
      expect(entry.active_match).toBeTruthy();
      await show(page, manifest.origin, "/reconciliation" + ledgerQuery, textPercent);
      const ledgerRows = page.getByRole("list", { name: "支付宝流水", exact: true }).getByRole("listitem");
      const ledgerGeometry = await continuousRows(ledgerRows);
      const ledger = ledgerRows.filter({ has: page.locator('a[data-row-link][href$="/' + entry.ledger_entry_id + '"]') });
      await completeText(ledger.getByRole("link", { name: entry.external_event_id, exact: true }));
      await completeText(ledger.getByText("交易时间", { exact: true }));
      await completeText(ledger.locator("time").first());
      await expect(ledger).toContainText(entry.active_match!.product_name);
      const related = ledger.getByRole("link", { name: "查看订单：" + entry.active_match!.merchant_order_no, exact: true });
      await completeText(related);
      await record(page, info, { feature: "mobile-consecutive-ledger", width, textPercent, rows: ledgerGeometry, linkedOrder: entry.active_match!.order_id });
      if (textPercent === 100) await capture(page, info, `mobile-ledger-${width}`);
      await related.tap();
      await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + entry.active_match!.order_id);

      await show(page, manifest.origin, "/reconciliation?tab=exceptions", textPercent);
      const exception = page.getByRole("list", { name: "账务异常", exact: true }).getByRole("listitem").first();
      await expect(exception.getByRole("link").first()).toHaveAccessibleName(/\S/);
      await completeText(exception.getByText("PerPay 处理状态", { exact: true }));
      await completeText(exception.locator("time").first());
      await record(page, info, { feature: "mobile-reconciliation-exception", width, textPercent });
    });
  }

  for (const width of [320, 360]) {
    test(`${width}px at 200% text: the complete maximum-length merchant reference stays within the record`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await login(page, manifest);
      const detail = await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details.orderLong!);
      expect(detail.status()).toBe(200);
      const original = (await detail.json() as AdminOrderDetailEnvelope).data;
      const merchantOrderNo = "MOBILE-LIST-REFERENCE-".padEnd(64, "9");
      expect(merchantOrderNo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
      await page.route(manifest.origin + "/api/admin/v1/orders?*", async route => {
        const response = await route.fetch();
        const payload = await response.json();
        await route.fulfill({ response, json: { ...payload, data: payload.data.map((item: { order_id: string }) => item.order_id === original.order_id ? { ...item, merchant_order_no: merchantOrderNo } : item) } });
      });
      await show(page, manifest.origin, "/orders?q=" + encodeURIComponent(original.product_name.slice(0, 24)), 200);
      const order = page.getByRole("list", { name: "订单列表", exact: true }).getByRole("listitem").filter({ has: page.locator('a[data-row-link][href$="/' + original.order_id + '"]') });
      const reference = order.getByText(merchantOrderNo, { exact: true });
      await expect(reference).toBeVisible();
      const geometry = await completeText(reference);
      expect(new Set(geometry.lines.map(line => Math.round(line.top))).size, "the maximum reference wraps instead of clipping").toBeGreaterThan(1);
      await record(page, info, { feature: "mobile-list-complete-reference", width, textPercent: 200, evidence: "genuine-order-with-display-only-64-character-reference", geometry });
    });
  }
});
