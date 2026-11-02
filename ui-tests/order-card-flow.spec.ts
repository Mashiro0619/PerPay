import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";
import { expectOverlayFits, openRecord } from "./overlay-fixtures";
import { expectDetailRecordLayout } from "./detail-layout";
import type { AdminOrderDetail, OrderWebhookDeliveryPageEnvelope } from "../web/src/api/generated/types.gen";

test("order details keep complete business facts and load notifications only when selected", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  const path = manifest.details.orderLong!;
  const response = await page.request.get(manifest.origin + "/api/admin/v1" + path);
  const order: AdminOrderDetail = (await response.json()).data;
  const notificationsApi = "/api/admin/v1" + path + "/notifications/deliveries";
  const reads: string[] = [];
  page.on("request", request => { if (request.method() === "GET") reads.push(new URL(request.url()).pathname); });
  const dialog = await openRecord(page, manifest, path);
  await expect(dialog.getByRole("region", { name: "订单信息", exact: true })).toContainText(order.note!);
  await expect(dialog.getByRole("button", { name: "复制商户订单号" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "打开收银台", exact: true })).toHaveAttribute("target", "_blank");
  const overviewLayout = await expectDetailRecordLayout(page);
  expect(reads.filter(path => path === notificationsApi)).toHaveLength(0);
  await dialog.getByRole("tab", { name: "通知", exact: true }).click();
  await expect(dialog.getByText("正在读取通知结果…", { exact: true })).toHaveCount(0);
  await expect.poll(() => reads.filter(path => path === notificationsApi).length).toBe(1);
  await expectOverlayFits(page);
  await dialog.getByRole("tab", { name: "概况", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "订单信息", exact: true })).toContainText(order.note!);
  await record(page, info, { feature: "order-record-facts-and-lazy-tabs", noteLength: order.note!.length, layout: overviewLayout });
  await screenshot(page, info, "order-detail-long-note");
});

test("notification loading and historical deliveries stay within their order tab", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const path = manifest.details.orderHistory ?? "/orders/" + (await (await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details.notificationHistory!.replace("/notifications/", "/webhooks/deliveries/"))).json()).data.event.order_id;
  const notificationPath = "/api/admin/v1" + path + "/notifications/deliveries";
  const result = await page.request.get(manifest.origin + notificationPath + "?limit=10");
  const original: OrderWebhookDeliveryPageEnvelope = await result.json();
  expect(original.data.length).toBeGreaterThan(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.origin === manifest.origin && url.pathname === notificationPath, async route => {
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  try {
    const dialog = await openRecord(page, manifest, path);
    await dialog.getByRole("tab", { name: "通知", exact: true }).click();
    await expect(dialog.getByText("正在读取通知结果…", { exact: true })).toBeAttached();
    await expect(dialog.getByRole("tab", { name: "概况", exact: true })).toBeEnabled();
    release();
    await expect(dialog.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(1);
    const history = dialog.locator('[data-slot="accordion-trigger"]').first();
    await history.focus(); await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(2);
    await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("aria-expanded", "false");
    await expect(dialog.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(1);
    await expectOverlayFits(page);
    await screenshot(page, info, "order-notification-history");
  } finally { release(); }
});

test("a refund mark becomes an internal step and retains its draft through responsive changes", async ({ page, manifest }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  const writes: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
  const dialog = await openRecord(page, manifest, manifest.details.orderPaid!);
  await expect(dialog).toHaveAttribute("data-overlay-record", "true");
  await dialog.getByRole("button", { name: "更多操作，订单操作", exact: true }).click();
  await page.getByRole("menuitem", { name: /^(标记已退款|撤销退款标记)$/ }).click();
  const step = page.locator("[data-overlay-step]:visible");
  const note = step.getByLabel("备注（可选）", { exact: true });
  const draft = "跨尺寸保留的未提交备注\n外部退款核对记录";
  await note.fill(draft); await note.focus();
  for (const width of [320, 390, 768, 1440, 1680]) {
    await page.setViewportSize({ width, height: 900 }); await page.clock.runFor(100);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.locator('[data-slot="dialog-overlay"]:visible')).toHaveCount(1);
    await expect(dialog).not.toHaveAttribute("data-overlay-record", "true");
    await expect(note).toHaveValue(draft); await expect(note).toBeFocused();
    await expectOverlayFits(page);
  }
  await record(page, info, { feature: "single-business-overlay-with-refund-step" });
  await screenshot(page, info, "refund-internal-step");
  await step.getByRole("button", { name: "取消", exact: true }).click();
  await expect(step).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "更多操作，订单操作", exact: true })).toBeFocused();
  await expect(dialog).toHaveAttribute("data-overlay-record", "true");
  expect(writes).toEqual([]);
});

test("resizing a displayed order does not repeat its reads or lose the selected section", async ({ page, manifest }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await login(page, manifest);
  const path = manifest.details.orderPaid!, orderApi = "/api/admin/v1" + path;
  const notificationApi = orderApi + "/notifications/deliveries";
  const reads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && [orderApi, notificationApi].includes(url.pathname)) reads.push(url.pathname);
  });
  const dialog = await openRecord(page, manifest, path);
  await dialog.getByRole("tab", { name: "通知", exact: true }).click();
  await expect.poll(() => reads.length).toBe(2); await expectOverlayFits(page);
  for (const width of [320, 390, 768, 1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 900 }); await expectOverlayFits(page);
    await expect(dialog.getByRole("tab", { name: "通知", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(reads).toEqual([orderApi, notificationApi]);
  }
  await record(page, info, { feature: "order-overlay-query-stability", reads });
});
