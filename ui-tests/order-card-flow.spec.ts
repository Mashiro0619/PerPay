import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { AdminOrderDetail, OrderWebhookDeliveryPageEnvelope, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

function namedOrder(manifest: Manifest, key: "orderLong" | "orderPaid") {
  const path = manifest.details[key];
  expect(path, "named real-domain order fixture: " + key).toMatch(/^\/orders\/[^/]+$/);
  return path!;
}
async function source<T>(page: Page, manifest: Manifest, path: string): Promise<T> {
  const response = await page.request.get(manifest.origin + path);
  expect(response.status(), path).toBe(200);
  return await response.json() as T;
}
async function historyOrder(page: Page, manifest: Manifest) {
  if (manifest.details.orderHistory) return manifest.details.orderHistory;
  const notification = manifest.details.notificationHistory;
  expect(notification).toBeTruthy();
  const detail = await source<{ data: WebhookDeliveryDetail }>(page, manifest, "/api/admin/v1" + notification!.replace("/notifications/", "/webhooks/deliveries/"));
  return "/orders/" + detail.data.event.order_id;
}
async function configure(page: Page, theme: "light" | "dark", mode: "compact" | "full") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}
async function storageWidth(page: Page, mode: "compact" | "full") {
  // Exercise the existing same-origin preference notification without clicking
  // behind an open modal or moving focus to a different browser tab.
  await page.evaluate(mode => {
    const key = "perpay:content-width", oldValue = localStorage.getItem(key);
    localStorage.setItem(key, mode);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: mode, storageArea: localStorage, url: location.href }));
  }, mode);
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
}
async function openOrder(page: Page, manifest: Manifest, path: string) {
  await page.goto(manifest.origin + "/admin" + path);
  await expect(page.locator("[data-detail-card-grid]")).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  const pageActions = page.getByRole("button", { name: "页面操作", exact: true });
  if (await pageActions.isVisible()) {
    await pageActions.click();
    const actions = page.getByRole("menu", { name: "页面操作", exact: true });
    await expect(actions).toBeVisible();
    await expect(actions.getByRole("menuitem", { name: "刷新", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(actions).toHaveCount(0);
    await expect(pageActions).toBeFocused();
  } else {
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  }
  await expect(page.locator("[data-detail-card-grid]")).toHaveAttribute("data-measured", "true");
}
async function gridGeometry(page: Page) {
  return page.locator("[data-detail-card-grid]").evaluate(grid => {
    const root = grid.getBoundingClientRect(), style = getComputedStyle(grid);
    const widths = style.gridTemplateColumns.trim().split(/\s+/).map(Number.parseFloat);
    const gap = Number.parseFloat(style.columnGap);
    const items = [...grid.querySelectorAll<HTMLElement>(":scope > [data-detail-grid-item]")].map((item, index) => {
      const content = item.querySelector<HTMLElement>(":scope > [data-detail-grid-content]")!;
      const box = content.getBoundingClientRect();
      return { index, left: box.left - root.left, top: box.top - root.top, width: box.width, height: box.height,
        label: content.querySelector("[data-slot=card-title],h2,h3,[role=heading]")?.textContent ?? content.textContent?.slice(0, 40),
        span: getComputedStyle(item).gridRowEnd, retained: item.dataset.orderFlowRetained ?? null };
    });
    const cursors = widths.map(() => 0), previousBottoms: Array<number | null> = widths.map(() => null);
    const violations: string[] = [], verticalGaps: number[] = [];
    for (const item of items) {
      const expectedTop = Math.min(...cursors), column = cursors.indexOf(expectedTop);
      const expectedLeft = widths.slice(0, column).reduce((sum, width) => sum + width, 0) + gap * column;
      if (Math.abs(item.left - expectedLeft) > 1) violations.push(`item ${item.index} uses x=${item.left}, shortest column ${column} starts at ${expectedLeft}`);
      if (Math.abs(item.top - expectedTop) > 1) violations.push(`item ${item.index} uses y=${item.top}, shortest column ${column} is available at ${expectedTop}`);
      if (Math.abs(item.width - widths[column]!) > 1) violations.push(`item ${item.index} does not fill one equal-width column`);
      if (previousBottoms[column] !== null) {
        const actualGap = item.top - previousBottoms[column]!;
        verticalGaps.push(actualGap);
        if (actualGap < 16 - 0.02 || actualGap > 17 + 0.02) violations.push(`item ${item.index} has vertical gap ${actualGap}`);
      }
      const span = Math.max(1, Math.ceil(item.height + gap));
      if (Number.parseInt(item.span.replace("span", "").trim(), 10) !== span) violations.push(`item ${item.index} span ${item.span} does not match its natural height ${item.height}`);
      cursors[column] = expectedTop + span;
      previousBottoms[column] = item.top + item.height;
      if (item.left < -1 || item.left + item.width > root.width + 1) violations.push(`item ${item.index} escapes the grid width`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!, b = items[j]!;
      const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      if (overlapX > 1 && overlapY > 1) violations.push(`items ${i}/${j} overlap by ${overlapX}x${overlapY}`);
    }
    const firstRow = items.slice(0, widths.length), following = items[widths.length];
    const continuesBeforeTallest = widths.length > 1 && !!following && following.top + 1 < Math.max(...firstRow.map(item => item.top + item.height)) + gap;
    return { width: root.width, columns: widths.length, gap, rowGap: Number.parseFloat(style.rowGap), widths, items, verticalGaps, continuesBeforeTallest, violations };
  });
}
async function settledGrid(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document.querySelector("[data-detail-card-grid]")?.getAnimations({ subtree: true }) ?? [];
    await Promise.all(animations.filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined)));
  });
  await page.clock.runFor(50);
  await expect.poll(async () => (await gridGeometry(page)).violations).toEqual([]);
  const geometry = await gridGeometry(page);
  expect(geometry.gap).toBe(16);
  expect(geometry.rowGap).toBe(0);
  expect(geometry.columns).toBe(geometry.width >= 1280 ? 3 : geometry.width >= 768 ? 2 : 1);
  expect(geometry.items.length).toBeGreaterThanOrEqual(5);
  return geometry;
}
async function retainItems(page: Page) {
  return page.locator("[data-detail-card-grid] > [data-detail-grid-item]").evaluateAll(items => items.map((item, index) => {
    item.setAttribute("data-order-flow-retained", "original-item-" + index);
    return "original-item-" + index;
  }));
}
async function expectRetained(page: Page, values: string[]) {
  expect(await page.locator("[data-detail-card-grid] > [data-detail-grid-item]").evaluateAll(items => items.map(item => item.getAttribute("data-order-flow-retained")))).toEqual(values);
}

test("real order cards continue in the shortest column across themes and content widths", async ({ page, manifest }, info) => {
  test.setTimeout(300_000);
  await login(page, manifest);
  const observedColumns = new Set<number>();
  let shortestColumnWitness = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await configure(page, theme, mode);
    for (const key of ["orderLong", "orderPaid"] as const) {
      await openOrder(page, manifest, namedOrder(manifest, key));
      const geometry = await settledGrid(page);
      observedColumns.add(geometry.columns);
      shortestColumnWitness ||= geometry.continuesBeforeTallest;
      const children = page.locator("[data-detail-card-grid] > [data-detail-grid-item]");
      await expect(children.nth(0).locator('[data-order-card="amount"]')).toBeVisible();
      await expect(children.nth(1).locator('[data-order-card="order"]')).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator('[data-detail-card-grid] [data-detail-fields][data-density="dense"]')).toHaveCount(0);
      await record(page, info, { feature: "order-natural-card-flow", width, theme, mode, key, geometry, evidence: "isolated-real-domain-fixture" });
      await screenshot(page, info, `order-flow-${key}-${width}-${theme}-${mode}`);
      if (width === 320 && mode === "compact" && key === "orderPaid") await audit(page, info, `order-flow-${theme}`);
    }
  }
  expect([...observedColumns].sort()).toEqual([1, 2, 3]);
  expect(shortestColumnWitness, "at least one later card starts before the tallest previous-row card ends").toBe(true);
  expect(errors).toEqual([]);
});

test("natural card spans follow long notes, delayed real notifications and history expansion", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "full");
  const longPath = namedOrder(manifest, "orderLong");
  const longOrder = (await source<{ data: AdminOrderDetail }>(page, manifest, "/api/admin/v1" + longPath)).data;
  expect(longOrder.note!.length).toBeGreaterThan(200);
  await openOrder(page, manifest, longPath);
  const note = page.getByRole("region", { name: "业务网站传入的订单信息", exact: true }).locator("dd").filter({ hasText: longOrder.note! });
  await expect(note).toHaveText(longOrder.note!);
  const longGeometry = await settledGrid(page);
  expect(longGeometry.continuesBeforeTallest).toBe(true);
  await record(page, info, { feature: "order-flow-long-note", noteLength: longOrder.note!.length, geometry: longGeometry });
  await screenshot(page, info, "order-flow-long-note");

  const path = await historyOrder(page, manifest);
  const notificationPath = "/api/admin/v1" + path + "/notifications/deliveries";
  const original = await source<OrderWebhookDeliveryPageEnvelope>(page, manifest, notificationPath + "?limit=10");
  expect(original.data.length).toBeGreaterThan(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route(url => url.origin === manifest.origin && url.pathname === notificationPath, async route => {
    requested();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(manifest.origin + "/admin" + path);
    await started;
    await expect(page.locator('[data-order-card="order"]')).toBeVisible();
    await expect(page.locator("[data-detail-card-grid]")).toHaveAttribute("data-measured", "true");
    await expect(page.getByText("正在读取通知结果…", { exact: true })).toBeAttached();
    const retained = await retainItems(page);
    const pending = await settledGrid(page);
    await record(page, info, { feature: "order-flow-delayed-notification", state: "pending-real-response", geometry: pending });
    await screenshot(page, info, "order-flow-notification-pending");
    release();
    await expect(page.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(1);
    await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
    const loaded = await settledGrid(page);
    await expectRetained(page, retained);
    const notificationItem = page.locator("[data-detail-grid-item]").filter({ has: page.getByRole("group", { name: "通知记录", exact: true }) });
    const trigger = notificationItem.locator('[data-slot="accordion-trigger"]').first();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const before = await notificationItem.locator(":scope > [data-detail-grid-content]").evaluate(element => element.getBoundingClientRect().height);
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(2);
    const expanded = await settledGrid(page);
    const after = await notificationItem.locator(":scope > [data-detail-grid-content]").evaluate(element => element.getBoundingClientRect().height);
    expect(after).toBeGreaterThan(before + 100);
    await expectRetained(page, retained);
    await record(page, info, { feature: "order-flow-history", state: "expanded", beforeHeight: before, afterHeight: after, loaded, geometry: expanded });
    await screenshot(page, info, "order-flow-notification-history-expanded");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("group", { name: "通知记录", exact: true })).toHaveCount(1);
    const collapsed = await settledGrid(page);
    await expectRetained(page, retained);
    const finalHeight = await notificationItem.locator(":scope > [data-detail-grid-content]").evaluate(element => element.getBoundingClientRect().height);
    expect(Math.abs(finalHeight - before)).toBeLessThanOrEqual(1);
    await record(page, info, { feature: "order-flow-history", state: "collapsed", geometry: collapsed });
    await screenshot(page, info, "order-flow-notification-history-collapsed");
  } finally { release(); }
});

test("order menus and an unsaved refund declaration retain identity and focus through reflow", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "dark", "compact");
  const path = namedOrder(manifest, "orderPaid");
  const order = (await source<{ data: AdminOrderDetail }>(page, manifest, "/api/admin/v1" + path)).data;
  const writes: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
  await openOrder(page, manifest, path);
  const retained = await retainItems(page);
  const trigger = page.getByRole("button", { name: "订单操作", exact: true });
  await trigger.evaluate(element => element.setAttribute("data-order-flow-trigger", "original"));
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { includeHidden: true });
  await expect(menu).toBeVisible();
  await menu.evaluate(element => element.setAttribute("data-order-flow-menu", "original"));
  const technical = menu.getByRole("menuitem", { name: "技术详情", exact: true });
  await technical.focus();
  for (const width of [390, 1440, 2190]) {
    await page.setViewportSize({ width, height: 900 });
    await settledGrid(page);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-order-flow-menu", "original");
    await expect(technical).toBeFocused();
    await expectRetained(page, retained);
  }
  await storageWidth(page, "full");
  await settledGrid(page);
  await expect(menu).toHaveAttribute("data-order-flow-menu", "original");
  await expect(technical).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("data-order-flow-trigger", "original");
  await trigger.click();
  await menu.getByRole("menuitem", { name: order.refund_mark.marked ? "撤销退款标记" : "标记已退款", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: order.refund_mark.marked ? "撤销退款标记" : "标记已退款", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.evaluate(element => element.setAttribute("data-order-flow-dialog", "original"));
  const note = dialog.getByLabel("备注（可选）", { exact: true });
  const draft = "跨布局保留的未提交备注\n只打开并取消，不执行财务操作";
  await note.fill(draft);
  await note.focus();
  await note.evaluate(element => element.setAttribute("data-order-flow-draft", "original"));
  for (const [width, mode] of [[320, "compact"], [390, "full"], [1440, "compact"], [2190, "full"]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await storageWidth(page, mode);
    await settledGrid(page);
    await expect(dialog).toHaveAttribute("data-order-flow-dialog", "original");
    await expect(note).toHaveAttribute("data-order-flow-draft", "original");
    await expect(note).toHaveValue(draft);
    await expect(note).toBeFocused();
    await expectRetained(page, retained);
    await record(page, info, { feature: "order-flow-unsaved-dialog", width, mode, state: "unsubmitted-draft-retained" });
    await screenshot(page, info, `order-flow-dialog-${width}-${mode}`);
  }
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("data-order-flow-trigger", "original");
  expect(writes).toEqual([]);
});

test("resizing and the actual content-width toggle keep the same order and notification reads", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await configure(page, "light", "compact");
  const path = namedOrder(manifest, "orderPaid"), orderApi = "/api/admin/v1" + path;
  const notificationsApi = orderApi + "/notifications/deliveries";
  const reads: string[] = [], writes: string[] = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && [orderApi, notificationsApi].includes(pathname)) reads.push(pathname);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method() + " " + pathname);
  });
  await openOrder(page, manifest, path);
  await settledGrid(page);
  expect(reads.filter(value => value === orderApi)).toHaveLength(1);
  expect(reads.filter(value => value === notificationsApi)).toHaveLength(1);
  const initialReads = [...reads], retained = await retainItems(page);
  for (const width of [320, 390, 1440, 2190]) {
    await page.setViewportSize({ width, height: 900 });
    await settledGrid(page);
    await expectRetained(page, retained);
    expect(reads).toEqual(initialReads);
  }
  for (const mode of ["full", "compact", "full"] as const) {
    await page.getByRole("button", { name: mode === "full" ? "切换为全屏布局" : "切换为收缩布局", exact: true }).click();
    await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
    const geometry = await settledGrid(page);
    await expectRetained(page, retained);
    expect(reads).toEqual(initialReads);
    await record(page, info, { feature: "order-flow-query-stability", mode, reads, geometry });
  }
  expect(writes).toEqual([]);
  await screenshot(page, info, "order-flow-width-toggle-retains-queries");
});
