import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AdminOrderDetail, AdminOrderSummary, AlipayAccount, Order, OrderWebhookDeliveryDetail, Site } from "../web/src/api/generated/types.gen";
import type { AuditEventDetail, AuditEventPage } from "../src/shared/audit";
import { createBusinessFlowFixture } from "./business-flow-server";

type BusinessFixture = Awaited<ReturnType<typeof createBusinessFlowFixture>>;

async function readData<T>(page: Page, origin: string, path: string): Promise<T> {
  const response = await page.request.get(origin + path);
  expect(response.ok(), `${path}: HTTP ${response.status()}`).toBe(true);
  return (await response.json()).data as T;
}

async function visibleSidebar(page: Page) {
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "切换导航", exact: true }).click();
  await expect(navigation).toBeVisible();
}

async function navigateSidebar(page: Page, name: string) {
  await visibleSidebar(page);
  await page.locator('[data-sidebar="sidebar"]').getByRole("link", { name, exact: true }).click();
  await expect(page.locator('[data-overlay-content]')).toHaveCount(0);
}

async function closeOverlay(page: Page) {
  const overlay = page.locator("[data-overlay-content]");
  await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(overlay).toHaveCount(0);
}

async function selectTab(container: Locator, name: string) {
  const tab = container.getByRole("tab", { name, exact: true });
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  for (let remaining = 5; remaining > 0; remaining--) {
    // Base UI hides the collapsed toast close button from the accessibility
    // tree; its visible pointer control can still dismiss stale screenshot UI.
    const notices = page.locator('[data-slot="toast-close"]:visible');
    const close = notices.first();
    if (!await close.isVisible()) break;
    const previous = await notices.count();
    await close.click();
    await expect.poll(() => notices.count()).toBeLessThan(previous);
  }
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const position = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { width: box.width, height: box.height, inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 1 && box.right <= innerWidth + 1,
      unobscured: hit === element || !!hit && element.contains(hit) };
  });
  expect(position.width).toBeGreaterThan(0);
  expect(position.height).toBeGreaterThan(0);
  expect(position.inside).toBe(true);
  expect(position.unobscured).toBe(true);
}

async function createAccount(page: Page, fixture: BusinessFixture, info: TestInfo, width: number) {
  await page.goto(fixture.origin + "/admin/settings/accounts");
  await page.getByRole("link", { name: "添加支付宝账号", exact: true }).click();
  const overlay = page.getByRole("dialog", { name: "支付宝账号", exact: true });
  const name = `连续验收收款账号 ${width}`;
  await overlay.getByRole("textbox", { name: "账号名称", exact: true }).fill(name);
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(overlay.getByRole("textbox", { name: "账号名称", exact: true })).toHaveValue(name);
  await selectTab(overlay, "应用信息");
  await overlay.getByRole("textbox", { name: "应用 ID（App ID）", exact: true }).fill(fixture.appId);
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/alipay-accounts" && response.request().method() === "POST");
  await overlay.getByRole("button", { name: "创建账号并继续", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const account = (await created.json()).data as AlipayAccount;
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe("/settings/accounts/" + account.id);
  await expect(overlay.getByRole("tab", { name: "应用信息", exact: true })).toHaveAttribute("aria-selected", "true");
  const keyResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/v1/alipay-accounts/${account.id}/application-key` && response.request().method() === "POST");
  await overlay.getByRole("button", { name: "生成应用密钥", exact: true }).click();
  expect((await keyResponse).ok()).toBe(true);
  await expect(overlay.getByRole("textbox", { name: "应用公钥", exact: true })).not.toHaveValue("");

  // A real validation rejection must retain the draft and expose its field.
  const platformKey = overlay.getByRole("textbox", { name: "支付宝公钥", exact: true });
  await platformKey.fill("invalid-public-key-for-recovery");
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/v1/alipay-accounts/${account.id}` && response.request().method() === "PUT");
  await overlay.getByRole("button", { name: "保存并检查", exact: true }).click();
  expect((await rejected).status()).toBe(422);
  await expect(platformKey).toHaveAttribute("aria-invalid", "true");
  await expect(platformKey).toHaveValue("invalid-public-key-for-recovery");
  await expect(platformKey).toBeFocused();
  await screenshot(page, info, "01-account-validation-recovery");

  await platformKey.fill(fixture.platformPublicKey);
  await selectTab(overlay, "收款码");
  await overlay.getByRole("textbox", { name: "支付宝收款码内容", exact: true }).fill(fixture.collectionCode);
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/v1/alipay-accounts/${account.id}/check` && response.request().method() === "POST");
  await overlay.getByRole("button", { name: "保存并检查", exact: true }).click();
  expect((await checked).ok()).toBe(true);
  await expect(overlay.getByText("连接检查通过", { exact: true })).toBeVisible();
  const stored = await readData<AlipayAccount>(page, fixture.origin, "/api/admin/v1/alipay-accounts/" + account.id);
  expect(stored).toMatchObject({ name, app_id: fixture.appId, code_payload: fixture.collectionCode, configured: true });
  await screenshot(page, info, "02-account-ready");
  await closeOverlay(page);
  return stored;
}

async function createSite(page: Page, fixture: BusinessFixture, info: TestInfo, account: AlipayAccount, width: number) {
  await navigateSidebar(page, "业务网站");
  await page.getByRole("link", { name: "创建业务网站", exact: true }).click();
  const overlay = page.locator("[data-overlay-content]");
  const name = `连续验收网站 ${width}`;
  await overlay.getByRole("textbox", { name: "业务网站名称", exact: true }).fill(name);
  await overlay.getByRole("combobox", { name: "支付宝账号", exact: true }).click();
  await page.getByRole("option", { name: account.name, exact: true }).click();
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/sites" && response.request().method() === "POST");
  await overlay.getByRole("button", { name: "创建业务网站", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const site = (await created.json()).data as Site;
  expect(site.configuration.collection?.accounts.map(selected => selected.account_id)).toEqual([account.id]);
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(`/sites/${site.client_id}/edit?section=basic`);
  await selectTab(overlay, "接入与通知");
  for (const label of ["生成／轮换 API 密钥", "生成／轮换通知密钥"]) {
    await overlay.getByRole("button", { name: label, exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "确认生成或轮换密钥？", exact: true });
    const rotated = page.waitForResponse(response => new URL(response.url()).pathname.includes(`/sites/${site.client_id}/secrets/`) && new URL(response.url()).pathname.endsWith("/actions/rotate") && response.request().method() === "POST");
    await confirm.getByRole("button", { name: "确认", exact: true }).click();
    expect((await rotated).ok()).toBe(true);
    await overlay.getByRole("button", { name: "隐藏密钥", exact: true }).click();
  }
  await overlay.getByRole("textbox", { name: "通知地址前缀", exact: true }).fill(fixture.notificationOrigin);
  await overlay.getByRole("switch", { name: "开启通知", exact: true }).check();
  await overlay.getByRole("button", { name: "高级设置", exact: true }).click();
  await overlay.getByRole("spinbutton", { name: "最多发送次数", exact: true }).fill("2");
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/v1/sites/${site.client_id}` && response.request().method() === "PUT");
  await overlay.getByRole("button", { name: "保存业务网站", exact: true }).click();
  const saveConfirm = page.getByRole("alertdialog", { name: "确认保存配置？", exact: true });
  await expect(saveConfirm).toBeVisible();
  await saveConfirm.getByRole("button", { name: "确认", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  const stored = await readData<Site>(page, fixture.origin, "/api/admin/v1/sites/" + site.client_id);
  expect(stored.configuration).toMatchObject({ notifications_enabled: true, notification_origin: fixture.notificationOrigin });
  await screenshot(page, info, "03-site-configured");
  await closeOverlay(page);
  const row = page.locator("[data-business-row]").filter({ has: page.getByRole("link", { name, exact: true }) });
  await row.getByRole("link", { name: "进入后台", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/sites/" + site.client_id);
  return stored;
}

async function createAndPayTestOrder(page: Page, fixture: BusinessFixture, info: TestInfo, site: Site, width: number) {
  if (width < 768) {
    await page.getByRole("button", { name: "页面操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "测试收款", exact: true }).click();
  } else await page.getByRole("button", { name: "测试收款", exact: true }).click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByText(site.client_id, { exact: true })).toBeVisible();
  await expect(overlay.getByRole("combobox", { name: "业务网站", exact: true })).toHaveCount(0);
  await overlay.getByRole("textbox", { name: "测试金额（元）", exact: true }).fill("1.23");
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/v1/sites/${site.client_id}/test-payments` && response.request().method() === "POST");
  await overlay.getByRole("button", { name: "创建测试订单", exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const order = (await response.json()).data as Order;
  await expect(overlay.getByRole("heading", { name: "测试订单已创建", exact: true })).toBeVisible();
  const popupReady = page.waitForEvent("popup");
  await overlay.getByRole("link", { name: "打开收银台", exact: true }).click();
  const checkout = await popupReady;
  await expect(checkout.getByRole("heading", { name: "支付宝付款", exact: true })).toBeVisible();
  await expect(checkout.locator("[data-qr-image]")).toBeVisible();
  expect(await checkout.locator("[data-qr-image]").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await screenshot(checkout, info, "04-test-order-checkout");
  await fixture.settleOrder(order.order_id);
  await expect(checkout.getByRole("heading", { name: "收款已确认", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(checkout.locator("[data-qr-image]")).toHaveCount(0);
  await screenshot(checkout, info, "05-test-order-payment-confirmed");
  await checkout.close();
  await page.bringToFront();
  await overlay.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect(overlay.getByText("收款已确认", { exact: true })).toBeVisible();
  await overlay.getByRole("link", { name: "查看订单", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(`/sites/${site.client_id}/orders/${order.order_id}`);
  await expect(overlay.getByText(order.merchant_order_no, { exact: true })).toBeVisible();
  await expect(overlay.getByText("此订单未设置通知地址", { exact: true })).toBeVisible();
  await expect(overlay.getByText("通知投递建议", { exact: true })).toHaveCount(0);
  const stored = await readData<AdminOrderDetail>(page, fixture.origin, `/api/admin/v1/sites/${site.client_id}/orders/${order.order_id}`);
  expect(stored.payment.status).toBe("CONFIRMED");
  expect(stored.received_amount_cents).toBe(order.payable_amount_cents);
  expect(stored.notification.notify_url).toBeNull();
  await screenshot(page, info, "06-test-order-detail-no-notification");
  await overlay.getByRole("button", { name: "返回上一步", exact: true }).click();
  await expect(overlay.getByRole("heading", { name: "测试订单已创建", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "再创建一笔", exact: true }).click();
  const nextAmount = overlay.getByRole("textbox", { name: "测试金额（元）", exact: true });
  await expect(nextAmount).toBeVisible();
  await screenshot(page, info, "06b-next-test-order-focus");
  await info.attach("next-test-order-focus", { body: Buffer.from(JSON.stringify(await page.evaluate(() => ({
    tag: document.activeElement?.tagName, id: document.activeElement?.id,
    withinOverlay: !!document.activeElement?.closest("[data-overlay-content]"),
  })))), contentType: "application/json" });
  await expect(nextAmount).toBeFocused();
  await closeOverlay(page);
  return stored;
}

async function notifyBusinessOrder(page: Page, fixture: BusinessFixture, info: TestInfo, site: Site, width: number) {
  const merchantOrderNo = `CONTINUOUS-BUSINESS-${width}`;
  // This is the business website's signed API request, not an administrator test order.
  await fixture.createNotifiableOrder(site.client_id, { amountCents: 2570, merchantOrderNo });
  await navigateSidebar(page, "订单");
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/admin/sites/${site.client_id}/orders`);
  await page.getByRole("searchbox", { name: "订单关键词搜索", exact: true }).fill(merchantOrderNo);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const orders = await readData<AdminOrderSummary[]>(page, fixture.origin, `/api/admin/v1/sites/${site.client_id}/orders?q=${merchantOrderNo}`);
  expect(orders).toHaveLength(1);
  const orderId = orders[0]!.order_id;
  await page.locator(`a[data-row-link][href*="${orderId}"]`).click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByText(merchantOrderNo, { exact: true })).toBeVisible();
  await expect(overlay.getByText("此订单已设置通知地址，暂无发送记录", { exact: true })).toBeVisible();
  await fixture.settleOrder(orderId);
  fixture.setNotificationMode("retryable-failure");
  await fixture.dispatchNotification();
  await overlay.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(overlay.getByText("收款已确认", { exact: true }).first()).toBeVisible();
  await expect(overlay.getByText("等待重试", { exact: true }).first()).toBeVisible();
  await screenshot(page, info, "07-business-payment-confirmed-notification-failed");
  await fixture.dispatchNotification({ advanceToNextAttempt: true });
  await overlay.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(overlay.getByText("已停止重试", { exact: true }).first()).toBeVisible();
  await overlay.getByRole("button", { name: "重新发送", exact: true }).click();
  const resend = page.getByRole("dialog", { name: "重新发送通知", exact: true });
  await expect(resend.getByText(fixture.notificationUrl, { exact: true })).toBeVisible();
  await resend.getByRole("textbox", { name: "操作理由", exact: true }).fill("连续验收：核对接收端后重新发送");
  await resend.getByRole("button", { name: "取消", exact: true }).click();
  await expect(overlay.getByText(merchantOrderNo, { exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "重新发送", exact: true }).click();
  await resend.getByRole("textbox", { name: "操作理由", exact: true }).fill("连续验收：接收端已恢复，重投原事件");
  fixture.setNotificationMode("success");
  const redelivered = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/redeliver") && response.request().method() === "POST");
  await resend.getByRole("button", { name: "确认重新发送", exact: true }).click();
  expect((await redelivered).ok()).toBe(true);
  await expect(resend).toHaveCount(0);
  await fixture.dispatchNotification();
  await overlay.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(overlay.getByText("通知已确认", { exact: true }).first()).toBeVisible();
  const deliveries = await readData<OrderWebhookDeliveryDetail[]>(page, fixture.origin, `/api/admin/v1/sites/${site.client_id}/orders/${orderId}/notifications/deliveries`);
  expect(deliveries).toHaveLength(2);
  expect(deliveries.some(item => item.delivery.status === "ACKNOWLEDGED" && item.delivery.generation === 2)).toBe(true);
  expect(deliveries.some(item => item.delivery.status === "DEAD_LETTER" && item.delivery.attempt_count === 2)).toBe(true);
  expect(new Set(deliveries.map(item => item.event.event_id)).size).toBe(1);
  const stored = await readData<AdminOrderDetail>(page, fixture.origin, `/api/admin/v1/sites/${site.client_id}/orders/${orderId}`);
  expect(stored.payment.status).toBe("CONFIRMED");
  expect(stored.received_amount_cents).toBe(stored.payable_amount_cents);
  expect(stored.notification.notify_url).toBe(fixture.notificationUrl);
  await screenshot(page, info, "08-business-notification-recovered");
  await closeOverlay(page);
  return { order: stored, deliveries };
}

async function traceAudit(page: Page, fixture: BusinessFixture, info: TestInfo, order: AdminOrderDetail, site: Site) {
  await fixture.flushAudit();
  await navigateSidebar(page, "审计日志");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/audit");
  await page.getByRole("searchbox", { name: "审计日志关键词搜索", exact: true }).fill(order.order_id);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const response = await page.request.get(fixture.origin + `/api/admin/v1/audit-events?source=core&q=${order.order_id}&limit=100`);
  expect(response.ok()).toBe(true);
  const audit = await response.json() as AuditEventPage;
  expect(audit.data.length).toBeGreaterThan(0);
  const row = page.locator("a[data-row-link]").first();
  await expect(row).toBeVisible();
  await screenshot(page, info, "10-business-audit-trail");
  await row.click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByRole("heading", { name: "审计日志详情", exact: true })).toBeVisible();
  await expect(overlay.getByText(site.configuration.name, { exact: true }).first()).toBeVisible();
  await overlay.getByRole("button", { name: "技术信息", exact: true }).click();
  const technical = page.locator("[data-technical-dialog]");
  await expect(technical).toContainText(order.order_id);
  await screenshot(page, info, "11-business-audit-detail");
  await technical.getByRole("button", { name: "关闭技术信息", exact: true }).click();
  await closeOverlay(page);
  expect(new URL(page.url()).searchParams.get("q")).toBe(order.order_id);
  expect(audit.data.some(event => event.action === "orders.created" && event.subject_id === order.order_id)).toBe(true);

  const match = order.reconciliation.matches[0]!;
  const operationId = match.creation_operation!.financial_operation_id;
  await page.getByRole("searchbox", { name: "审计日志关键词搜索", exact: true }).fill(operationId);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const financialResponse = await page.request.get(fixture.origin + `/api/admin/v1/audit-events?source=core&q=${operationId}&limit=100`);
  expect(financialResponse.ok()).toBe(true);
  const financial = await financialResponse.json() as AuditEventPage;
  const event = financial.data.find(event => event.action === "financial.auto_settlement" && event.subject_id === operationId);
  expect(event).toBeDefined();
  await page.locator(`a[data-row-link][href*="${event!.event_id}"]`).click();
  await overlay.getByRole("button", { name: "技术信息", exact: true }).click();
  await expect(technical).toContainText(order.order_id);
  await expect(technical).toContainText(match.ledger_entry_id);
  await screenshot(page, info, "12-financial-audit-correlation");
  await technical.getByRole("button", { name: "关闭技术信息", exact: true }).click();
  await closeOverlay(page);
  expect(new URL(page.url()).searchParams.get("q")).toBe(operationId);
  return [...audit.data, ...financial.data].map(event => ({ id: event.event_id, action: event.action, subject: event.subject_id, site: event.site_id }));
}

async function reconcileUnmatchedIncome(page: Page, fixture: BusinessFixture, info: TestInfo, site: Site, account: AlipayAccount, width: number) {
  const merchantOrderNo = `CONTINUOUS-MANUAL-${width}`;
  const manualOrder = await fixture.createNotifiableOrder(site.client_id, { amountCents: 3999, merchantOrderNo });
  const unmatched = await fixture.createUnmatchedIncome(account.id, { amountCents: manualOrder.payable_amount_cents + 25 });
  const before = await fixture.apiSnapshot();
  expect(before.exceptions.find(item => item.exception_id === unmatched.exceptionId)?.status).toBe("OPEN");
  await navigateSidebar(page, "对账");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/reconciliation");
  await page.locator(`a[data-row-link][href*="${unmatched.ledgerEntryId}"]`).click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.getByRole("heading", { name: "流水与对账详情", exact: true })).toBeVisible();
  await expect(overlay.getByText(account.name, { exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "人工关联收款", exact: true }).click();
  const manual = page.getByRole("dialog", { name: "人工关联收款", exact: true });
  const selectOrder = async () => {
    await manual.getByRole("searchbox", { name: "搜索订单", exact: true }).fill(merchantOrderNo);
    await manual.getByRole("button", { name: "搜索", exact: true }).click();
    await manual.getByRole("button", { name: /^选择订单：/ }).click();
    await expect(manual.getByRole("button", { name: "确认关联收款", exact: true })).toBeEnabled();
    await expect(manual).toContainText(merchantOrderNo);
    await expect(manual.getByText("支付宝交易金额与订单应付不同，请核对后确认。", { exact: true })).toBeVisible();
  };
  await selectOrder();
  await manual.getByRole("button", { name: "返回选择", exact: true }).click();
  await selectOrder();
  const accountIdentities: Array<{ label: string; href: string | null }> = [];
  for (const label of ["订单收款账号", "流水收款账号"]) {
    const field = manual.getByText(label, { exact: true }).locator("..");
    const identity = field.getByRole("link", { name: account.name, exact: true });
    await expectReachable(identity);
    const href = await identity.getAttribute("href");
    expect(new URL(href!, page.url()).searchParams.get("overlay")).toBe("/settings/accounts/" + account.id);
    accountIdentities.push({ label, href });
  }
  await screenshot(page, info, "09-manual-settlement-account-identities");
  await manual.getByRole("textbox", { name: "操作理由（可选）", exact: true }).fill("连续验收：已核对商户订单与收款账号，按实际收入人工关联");
  await expectReachable(manual.getByRole("textbox", { name: "操作理由（可选）", exact: true }));
  await expectReachable(manual.getByRole("button", { name: "确认关联收款", exact: true }));
  await screenshot(page, info, "09a-manual-settlement-reason-and-confirm");
  await info.attach("manual-settlement-confirmation-context", { body: Buffer.from(JSON.stringify({
    orderId: manualOrder.order_id, merchantOrderNo, ledgerEntryId: unmatched.ledgerEntryId, accountId: account.id,
    accountIdentities,
    text: await manual.innerText(),
  })), contentType: "application/json" });
  const saved = page.waitForResponse(response => new URL(response.url()).pathname.includes("/reconciliation/") && response.request().method() === "POST");
  await manual.getByRole("button", { name: "确认关联收款", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(manual).toHaveCount(0);
  await expect(overlay.getByText(merchantOrderNo, { exact: true })).toBeVisible();
  const persisted = await fixture.apiSnapshot();
  const stored = persisted.orders.find(order => order.order_id === manualOrder.order_id)!;
  expect(stored.payment).toMatchObject({ status: "CONFIRMED", basis: "MANUAL" });
  expect(stored.received_amount_cents).toBe(manualOrder.payable_amount_cents + 25);
  expect(stored.reconciliation.matches).toHaveLength(1);
  expect(stored.reconciliation.matches[0]!.ledger_entry_id).toBe(unmatched.ledgerEntryId);
  expect(stored.reconciliation.matches[0]!.creation_operation?.reason).toBe("连续验收：已核对商户订单与收款账号，按实际收入人工关联");
  expect(persisted.exceptions.find(item => item.exception_id === unmatched.exceptionId)?.status).toBe("RESOLVED");
  await screenshot(page, info, "09b-manual-settlement-persisted");

  await overlay.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
  const reverse = page.getByRole("dialog", { name: "撤销收款关联？", exact: true });
  const reverseSubmit = reverse.getByRole("button", { name: "确认撤销关联", exact: true });
  await expect(reverseSubmit).toBeDisabled();
  const reversalReason = "连续验收：复核发现归属错误，撤销本次人工关联";
  await reverse.getByRole("textbox", { name: "操作理由", exact: true }).fill(reversalReason);
  await expectReachable(reverseSubmit);
  await screenshot(page, info, "09c-reverse-mistaken-association");
  const reversedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/actions/reverse") && response.request().method() === "POST");
  await reverseSubmit.click();
  expect((await reversedResponse).ok()).toBe(true);
  await expect(reverse).toHaveCount(0);
  await expect(overlay.getByRole("heading", { name: "已撤销的历史关联（1）", exact: true })).toBeVisible();
  await fixture.dispatchNotification();
  const afterReversal = await fixture.apiSnapshot({ orderId: manualOrder.order_id });
  const reversedOrder = afterReversal.orders[0]!;
  expect(reversedOrder.payment.status).toBe("DISPUTED");
  expect(reversedOrder.reconciliation.matches).toHaveLength(1);
  expect(reversedOrder.reconciliation.matches[0]!.status).toBe("REVERSED");
  expect(reversedOrder.reconciliation.matches[0]!.resolution_operation?.reason).toBe(reversalReason);
  expect(new Set(afterReversal.deliveries.map(item => item.event.event_type))).toEqual(new Set(["PAYMENT_CONFIRMED", "PAYMENT_DISPUTED"]));
  expect(new Set(afterReversal.deliveries.map(item => item.event.event_id)).size).toBe(2);
  await screenshot(page, info, "09d-reversal-persisted");
  await closeOverlay(page);
  return { order: reversedOrder, settledPayment: stored.payment, ledgerEntryId: unmatched.ledgerEntryId, exceptionId: unmatched.exceptionId };
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`continuous real business flow ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, reducedMotion: "reduce", colorScheme: "light" });
    test("completes account-to-audit tasks with independent test, callback and manual orders", async ({ page }, info) => {
      test.setTimeout(300_000);
      const fixture = await createBusinessFlowFixture();
      const errors: string[] = [];
      const mutations: Array<{ method: string; path: string; status: number }> = [];
      page.on("pageerror", error => errors.push(error.message));
      page.context().on("page", popup => popup.on("pageerror", error => errors.push(error.message)));
      page.on("response", response => {
        const request = response.request();
        if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) mutations.push({ method: request.method(), path: new URL(request.url()).pathname, status: response.status() });
      });
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        const account = await test.step("Create and configure a collection account, retaining a rejected draft", () => createAccount(page, fixture, info, viewport.width));
        const site = await test.step("Create a website, assign its account and configure signed integration", () => createSite(page, fixture, info, account, viewport.width));
        const testOrder = await test.step("Create a website test order and confirm it through simulated external income", () => createAndPayTestOrder(page, fixture, info, site, viewport.width));
        const business = await test.step("Find the signed business order in the UI and recover its failed callback", () => notifyBusinessOrder(page, fixture, info, site, viewport.width));
        const manual = await test.step("Resolve a real unmatched-income exception through manual association", () => reconcileUnmatchedIncome(page, fixture, info, site, account, viewport.width));
        const audit = await test.step("Follow the business order into the real audit trail", () => traceAudit(page, fixture, info, business.order, site));
        const persisted = await fixture.apiSnapshot();
        expect(new Set([testOrder.order_id, business.order.order_id, manual.order.order_id]).size).toBe(3);
        expect(persisted.receiverCalls.filter(call => call.orderId === business.order.order_id).map(call => call.status)).toEqual([503, 503, 200]);
        expect(persisted.receiverCalls.every(call => call.signatureVerified)).toBe(true);
        expect(persisted.deliveries.some(item => item.event.order_id === testOrder.order_id)).toBe(false);
        const verifiedAudit: AuditEventDetail[] = [];
        for (const [action, order, operation] of [
          ["financial.auto_settlement", business.order, business.order.reconciliation.matches[0]!.creation_operation!],
          ["financial.manual_settlement", manual.order, manual.order.reconciliation.matches[0]!.creation_operation!],
          ["financial.reverse_settlement", manual.order, manual.order.reconciliation.matches[0]!.resolution_operation!],
        ] as const) {
          const event = persisted.audit.find(event => event.action === action && event.subject_id === operation.financial_operation_id);
          expect(event, action).toBeDefined();
          expect(event!.details).toMatchObject({ order_id: order.order_id, ledger_entry_id: operation.ledger_entry_id });
          verifiedAudit.push(event!);
        }
        const acknowledged = business.deliveries.find(item => item.delivery.status === "ACKNOWLEDGED")!;
        const redeliveryAudit = persisted.audit.find(event => event.action === "webhook.delivery_redelivered" && event.subject_id === acknowledged.delivery.delivery_id);
        expect(redeliveryAudit?.details).toMatchObject({ event_id: acknowledged.event.event_id, generation: 2 });
        verifiedAudit.push(redeliveryAudit!);
        expect(errors).toEqual([]);
        const evidence = {
          viewport, externalSimulation: fixture.simulation,
          account: { id: account.id, name: account.name },
          site: { id: site.client_id, name: site.configuration.name },
          testOrder: {
            id: testOrder.order_id, merchantOrderNo: testOrder.merchant_order_no,
            payment: testOrder.payment, notification: testOrder.notification,
          },
          businessOrder: {
            id: business.order.order_id, merchantOrderNo: business.order.merchant_order_no,
            payment: business.order.payment, notification: business.order.notification,
          },
          manualOrder: {
            id: manual.order.order_id, merchantOrderNo: manual.order.merchant_order_no,
            paymentBeforeReversal: manual.settledPayment, paymentAfterReversal: manual.order.payment,
            ledgerEntryId: manual.ledgerEntryId, resolvedExceptionId: manual.exceptionId,
            matchStatus: manual.order.reconciliation.matches[0]!.status,
            creationOperation: manual.order.reconciliation.matches[0]!.creation_operation,
            reversalOperation: manual.order.reconciliation.matches[0]!.resolution_operation,
            notifications: persisted.deliveries.filter(item => item.event.order_id === manual.order.order_id)
              .map(item => ({ eventId: item.event.event_id, type: item.event.event_type, deliveryId: item.delivery.delivery_id, status: item.delivery.status })),
          },
          deliveries: business.deliveries.map(item => ({ id: item.delivery.delivery_id, eventId: item.event.event_id,
            generation: item.delivery.generation, status: item.delivery.status, attempts: item.delivery.attempt_count })),
          receiverCalls: persisted.receiverCalls, uiViewedAudit: audit,
          verifiedAudit: verifiedAudit.map(event => ({ id: event.event_id, action: event.action, subject: event.subject_id,
            site: event.site_id, details: event.details })),
          mutations, pageErrors: errors,
        };
        await info.attach("business-flow-evidence", { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: "application/json" });
      } finally { await fixture.close(); }
    });
  });
}
