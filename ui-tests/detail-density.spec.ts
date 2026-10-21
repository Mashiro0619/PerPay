import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { AdminLedgerDetail, AdminOrderDetail, PaymentMatchDetail, WebhookAttempt, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

const scenarios = [
  { key: "notificationDns", kind: "notification", heading: "通知详情", tools: "通知记录操作" },
  { key: "matchInferred", kind: "match", heading: "收款关联详情", tools: "收款关联记录操作" },
  { key: "ledgerAssociated", kind: "ledger", heading: "支付宝流水详情", tools: "支付宝流水记录操作" },
] as const;
const layoutScenarios = [
  ...scenarios,
  { ...scenarios[0], key: "notificationSite" },
  { ...scenarios[1], key: "matchSite" },
] as const;

function detailPath(manifest: Manifest, key: string) {
  const value = manifest.details[key];
  expect(value, "named domain fixture: " + key).toBeTruthy();
  return value!;
}
function apiPath(path: string) {
  return "/api/admin/v1" + path.replace("/notifications/", "/webhooks/deliveries/").replace(/^\/ledger\//, "/ledger/entries/");
}
async function data<T>(page: Page, manifest: Manifest, path: string): Promise<T> {
  const response = await page.request.get(manifest.origin + path);
  expect(response.status(), path).toBe(200);
  return (await response.json() as { data: T }).data;
}
async function layout(page: Page, theme: "light" | "dark", mode: "compact" | "full") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}
async function openDetail(page: Page, manifest: Manifest, key: string) {
  await page.goto(manifest.origin + "/admin" + detailPath(manifest, key));
  await expect(page.locator("[data-detail-page]")).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.locator("#main-content [data-detail-identifier]")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
async function fields(page: Page, names: readonly string[]) {
  const main = page.locator("#main-content");
  for (const name of names) await expect(main.locator("dt").filter({ hasText: new RegExp("^" + name + "$") }).first()).toBeVisible();
}
async function keyboardTools(page: Page, label: string) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "技术详情", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "技术详情", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "技术详情", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
async function height(element: Locator) {
  await expect(element).toBeVisible();
  return element.evaluate(value => value.getBoundingClientRect().height);
}
async function denseGridGeometry(page: Page) {
  const grids = await page.locator('[data-detail-fields][data-density="dense"]').evaluateAll(containers => containers.map(container => {
    const dl = container.querySelector("dl")!;
    const width = container.getBoundingClientRect().width;
    return { width, columns: getComputedStyle(dl).gridTemplateColumns.trim().split(/\s+/).length };
  }));
  expect(grids.length).toBeGreaterThan(0);
  for (const grid of grids) expect(grid.columns, JSON.stringify(grid)).toBe(grid.width >= 1024 ? 3 : grid.width >= 640 ? 2 : 1);
  return grids;
}

test("detail cards reduce the measured e50b630 baseline by at least 25 percent", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await layout(page, "dark", "compact");
  // Captured at e50b630 with these same named synthetic-domain records, viewport,
  // expanded sidebar, dark theme and compact content width. Keep these thresholds
  // independent of the candidate layout; no fixed-height clipping is permitted.
  const baselines = { notification: 779.75, match: 586, source: 577.1875, association: 345.59375 };
  for (const key of ["notificationDns", "notificationHttp"]) {
    await openDetail(page, manifest, key);
    const actual = await height(page.locator("#main-content [data-content-width]"));
    expect(actual).toBeGreaterThan(0);
    expect(actual).toBeLessThanOrEqual(584.8125);
    await expect(page.getByRole("table", { name: "投递尝试（1）", exact: true }).locator("tbody tr").first()).toBeInViewport({ ratio: 1 });
    await record(page, info, { feature: "detail-density-baseline", key, baseline: baselines.notification, maximum: 584.8125, actual });
    await screenshot(page, info, "density-threshold-" + key);
  }
  await openDetail(page, manifest, "matchInferred");
  const match = await height(page.getByRole("group", { name: "收款关联记录", exact: true }));
  expect(match).toBeLessThanOrEqual(439.5);
  await expect(page.getByRole("heading", { name: "匹配依据", exact: true })).toBeInViewport({ ratio: 1 });
  await record(page, info, { feature: "detail-density-baseline", key: "matchInferred", baseline: baselines.match, maximum: 439.5, actual: match });
  await screenshot(page, info, "density-threshold-match");
  await openDetail(page, manifest, "ledgerAssociated");
  const source = await height(page.locator("[data-ledger-source]").first());
  const association = await height(page.locator("[data-ledger-match]").first());
  expect(source).toBeLessThanOrEqual(432.89);
  expect(association).toBeLessThanOrEqual(259.19);
  await record(page, info, { feature: "detail-density-baseline", key: "ledgerAssociated", baselines, actual: { source, association }, maximum: { source: 432.89, association: 259.19 } });
  await screenshot(page, info, "density-threshold-ledger");
});

test("three detail types retain expanded facts across widths, themes and content modes", async ({ page, manifest }, info) => {
  test.setTimeout(600_000);
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await layout(page, theme, mode);
    for (const scenario of layoutScenarios) {
      await openDetail(page, manifest, scenario.key);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(scenario.heading);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      if (scenario.kind === "notification") {
        await fields(page, scenario.key === "notificationSite" ? ["下次重试", "通知地址"] : ["所属网站", "下次重试", "通知地址"]);
        await expect(page.getByRole("heading", { name: "投递尝试（1）", exact: true })).toBeVisible();
        await expect(page.getByText(/通知域名解析失败/).first()).toBeVisible();
        await expect(page.locator("[data-detail-order-summary]")).toBeVisible();
      } else if (scenario.kind === "match") {
        await fields(page, ["支付宝交易金额", "支付宝交易时间", "支付宝交易对方", "支付宝订单号", "支付宝交易备注", "金额占用时间"]);
        await expect(page.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "匹配依据", exact: true })).toHaveCount(0);
      } else {
        await fields(page, ["交易金额", "收支方向", "交易时间", "原始流水编号", "支付宝 App ID"]);
        for (const id of ["ledger-sources-heading", "ledger-matches-heading", "ledger-conflicts-heading"]) await expect(page.locator("#" + id)).toBeVisible();
        await expect(page.locator("[data-ledger-source]").first()).toBeVisible();
        await expect(page.locator("[data-ledger-match]").first()).toBeVisible();
      }
      const grids = await denseGridGeometry(page);
      if (width === 1440) await keyboardTools(page, scenario.tools);
      const id = `dense-${scenario.key}-${width}-${theme}-${mode}`;
      await record(page, info, { feature: "detail-density-matrix", width, theme, mode, scenario: scenario.key, grids, evidence: "local-synthetic-domain" });
      await screenshot(page, info, id);
      if (width === 320 && mode === "compact") await audit(page, info, id);
    }
  }
  // The requested screen matrix jumps from phone to wide desktop. Exercise the
  // intermediate container width explicitly, so two columns are proven too.
  await page.setViewportSize({ width: 1100, height: 900 });
  await layout(page, "dark", "full");
  await openDetail(page, manifest, "ledgerAssociated");
  expect((await denseGridGeometry(page)).some(grid => grid.columns === 2)).toBe(true);
  await page.setViewportSize({ width: 2190, height: 900 });
  await openDetail(page, manifest, "ledgerAssociated");
  expect((await denseGridGeometry(page)).some(grid => grid.columns === 3)).toBe(true);
  const container = page.locator('[data-detail-fields][data-density="dense"]').first();
  const originalWidth = await container.evaluate(element => (element as HTMLElement).style.width);
  const boundaries: Array<{ requestedWidth: number; actualWidth: number; columns: number }> = [];
  try {
    for (const [requestedWidth, columns] of [[639, 1], [640, 2], [1023, 2], [1024, 3]] as const) {
      await container.evaluate((element, width) => { (element as HTMLElement).style.width = width + "px"; }, requestedWidth);
      const actual = await container.evaluate(element => ({ actualWidth: element.getBoundingClientRect().width, columns: getComputedStyle(element.querySelector("dl")!).gridTemplateColumns.trim().split(/\s+/).length }));
      expect(actual.actualWidth).toBe(requestedWidth);
      expect(actual.columns).toBe(columns);
      boundaries.push({ requestedWidth, ...actual });
    }
  } finally {
    await container.evaluate((element, width) => { (element as HTMLElement).style.width = width; }, originalWidth);
  }
  await record(page, info, { feature: "detail-container-breakpoints", boundaries, restoredInlineWidth: originalWidth });
  expect(errors).toEqual([]);
});

test("coarse-pointer detail actions retain 44 pixel targets in both content modes", async ({ browser, manifest }, info) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  try {
    const page = await context.newPage();
    await page.clock.install({ time: new Date(manifest.epoch) });
    await page.clock.setFixedTime(new Date(manifest.epoch));
    await page.route("**/*", route => new URL(route.request().url()).origin === manifest.origin ? route.continue() : route.abort("blockedbyclient"));
    await login(page, manifest);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    for (const width of [320, 390]) for (const mode of ["compact", "full"] as const) {
      await page.setViewportSize({ width, height: 900 });
      await layout(page, "dark", mode);
      for (const scenario of scenarios) {
        await openDetail(page, manifest, scenario.key);
        const targets = await page.locator('#main-content [class~="group/button"], #main-content [data-slot="button"]').evaluateAll(elements => elements.flatMap(element => {
          const bounds = element.getBoundingClientRect();
          if (!bounds.width || !bounds.height || getComputedStyle(element).visibility === "hidden") return [];
          return [{ label: element.getAttribute("aria-label") ?? element.textContent, width: bounds.width, height: bounds.height }];
        }));
        expect(targets.length).toBeGreaterThan(0);
        expect(targets.filter(target => target.width < 44 || target.height < 44)).toEqual([]);
        await record(page, info, { feature: "detail-touch-targets", width, mode, scenario: scenario.key, targets });
        await screenshot(page, info, `dense-touch-${scenario.kind}-${width}-${mode}`);
      }
    }
  } finally { await context.close(); }
});

test("named notification scenarios retain delivery facts and safe resend recovery", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const key of ["notificationPending", "notificationDns", "notificationHttp", "notificationDead", "notificationHistory", "notificationSite"]) {
    await openDetail(page, manifest, key);
    const detail = await data<WebhookDeliveryDetail>(page, manifest, apiPath(detailPath(manifest, key)));
    const card = page.getByRole("group", { name: "通知记录", exact: true });
    await expect(card.getByText(detail.target.target_url, { exact: true })).toBeVisible();
    await expect(card.getByRole("heading", { name: `投递尝试（${detail.delivery.attempt_count}）`, exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /^投递尝试（/ })).toHaveCount(0);
    if (key === "notificationPending") {
      expect(detail.delivery.attempt_count).toBe(0);
      await expect(card.getByText("暂无尝试明细", { exact: true })).toBeVisible();
    }
    if (key === "notificationDns" || key === "notificationSite") await expect(card.getByText(/通知域名解析失败/)).toBeVisible();
    if (key === "notificationHttp") await expect(card.getByText(/HTTP 503/)).toBeVisible();
    if (key === "notificationSite") await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", new RegExp("^/admin/sites/" + detail.target.api_client_id + "/orders/"));
    if (key === "notificationHistory") {
      expect(detail.is_latest).toBe(false);
      await expect(card.getByText(/历史投递/)).toBeVisible();
      await card.getByRole("button", { name: "通知记录操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "重新发送", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    if (key === "notificationDead") {
      const trigger = card.getByRole("button", { name: "重新发送", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "重新发送通知", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "确认重新发送", exact: true })).toBeDisabled();
      await dialog.getByLabel("操作理由", { exact: true }).fill("业务接收端已修复；取消本次验收操作");
      await expect(dialog.getByRole("button", { name: "确认重新发送", exact: true })).toBeEnabled();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await record(page, info, { feature: "notification-domain-scenarios", key, attemptCount: detail.delivery.attempt_count, latest: detail.is_latest });
    await screenshot(page, info, "dense-" + key);
  }
});

test("a clearly synthetic 21-attempt response stays expanded and pages newest-first without loss", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const deliveryPath = apiPath(detailPath(manifest, "notificationHttp"));
  const path = deliveryPath + "/attempts";
  const detail = structuredClone(await data<WebhookDeliveryDetail>(page, manifest, deliveryPath));
  const original = await data<WebhookAttempt[]>(page, manifest, path);
  expect(original.length).toBeGreaterThan(0);
  // The detail count and attempts read are synthetic responses. Clone every
  // required field from the isolated fixture; no notification is actually sent.
  detail.delivery.attempt_count = 21;
  const attempts = Array.from({ length: 21 }, (_, index) => {
    const entry = structuredClone(original[0]!);
    const started = new Date(manifest.epoch + index * 1000).toISOString();
    return { ...entry, attempt_id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, attempt_number: index + 1, request_timestamp: Math.floor(Date.parse(started) / 1000), started_at: started, finished_at: started };
  });
  await page.route(manifest.origin + deliveryPath, route => route.fulfill({ status: 200, json: { data: detail } }));
  await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: attempts } }));
  await openDetail(page, manifest, "notificationHttp");
  await expect(page.getByText("已尝试 21 次", { exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "投递尝试（21）", exact: true });
  await expect(table).toBeVisible();
  await expect(page.getByRole("button", { name: "投递尝试（21）", exact: true })).toHaveCount(0);
  const seen: number[] = [];
  for (let number = 1; number <= 3; number++) {
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(number === 3 ? 1 : 10);
    seen.push(...(await rows.locator("td:first-child").allTextContents()).map(value => Number(/第 (\d+) 次/.exec(value)![1])));
    if (number < 3) await page.getByRole("button", { name: "投递尝试下一页", exact: true }).click();
  }
  expect(seen).toEqual(Array.from({ length: 21 }, (_, index) => 21 - index));
  await expect(page.getByRole("button", { name: "投递尝试下一页", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "投递尝试上一页", exact: true }).click();
  await expect(table.locator("tbody tr").first()).toContainText("第 11 次");
  await record(page, info, { feature: "notification-attempt-pagination", evidence: "synthetic-detail-and-attempts-responses-no-sends", count: attempts.length, observed: seen });
  await screenshot(page, info, "dense-notification-21-attempts");
});

test("failed attempt reads retain an accurate unknown history and recover on explicit retry", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const path = apiPath(detailPath(manifest, "notificationHttp")) + "/attempts";
  const original = await data<WebhookAttempt[]>(page, manifest, path);
  expect(original).toHaveLength(1);
  let unavailable = true;
  let reads = 0;
  await page.route(manifest.origin + path, route => {
    reads++;
    return unavailable
      ? route.fulfill({ status: 503, json: { error: { code: "synthetic_attempts_unavailable", message: "合成的投递尝试读取失败" } } })
      : route.fulfill({ status: 200, json: { data: original } });
  });
  await openDetail(page, manifest, "notificationHttp");
  const main = page.locator("#main-content");
  await expect(main.getByText("尚未获得尝试明细，不能据此判断未曾投递。", { exact: true })).toBeVisible();
  await expect(main.getByText("投递尝试尚未读取", { exact: false })).toBeVisible();
  await expect(main.getByText("暂无尝试明细", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("table", { name: /^投递尝试/ })).toHaveCount(0);
  await expect(main.getByRole("alert")).toContainText("合成的投递尝试读取失败");
  const beforeRetry = reads;
  unavailable = false;
  await main.getByRole("button", { name: "重试", exact: true }).click();
  await expect(main.getByRole("table", { name: "投递尝试（1）", exact: true })).toBeVisible();
  await expect(main.getByText(/HTTP 503/)).toBeVisible();
  await expect(main.getByText(/不能据此判断未曾投递/)).toHaveCount(0);
  await expect(main.getByRole("alert")).toHaveCount(0);
  expect(reads).toBeGreaterThan(beforeRetry);
  await record(page, info, { feature: "notification-attempt-read-recovery", evidence: "synthetic-unavailable-response-then-original-attempts", beforeRetry, afterRetry: reads });
  await screenshot(page, info, "dense-notification-attempt-read-recovered");
});

test("automatic, manual, reversed and site match details retain their visible evidence", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const key of ["matchInferred", "matchManual", "matchReversed", "matchSite"]) {
    await openDetail(page, manifest, key);
    const match = await data<PaymentMatchDetail>(page, manifest, apiPath(detailPath(manifest, key)));
    const card = page.getByRole("group", { name: "收款关联记录", exact: true });
    await expect(card.getByText(match.ledger_entry.provider_order_no!, { exact: true })).toBeVisible();
    await expect(card.locator("[data-detail-order-summary]")).toContainText(match.order.merchant_order_no);
    if (match.candidate) {
      await expect(card.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
      await expect(card.getByText("金额占用时间", { exact: true })).toBeVisible();
    }
    if (match.evidence_type === "MANUAL") {
      await expect(card.getByText(/管理员人工关联/)).toBeVisible();
      expect(match.creation_operation.reason).toBeTruthy();
      await expect(card.locator("dd").filter({ hasText: match.creation_operation.reason! })).toBeVisible();
    }
    if (match.status === "REVERSED") {
      await fields(page, ["撤销时间", "撤销操作人", "撤销理由"]);
      expect(match.resolution_operation?.reason).toBeTruthy();
      await expect(card.locator("dd").filter({ hasText: match.resolution_operation!.reason! })).toBeVisible();
      await card.getByRole("button", { name: "收款关联记录操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "撤销错误关联", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    } else {
      const trigger = card.getByRole("button", { name: "收款关联记录操作", exact: true });
      await trigger.click();
      await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "撤销收款关联？", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("不会转出资金");
      await expect(dialog.getByRole("button", { name: "确认撤销关联", exact: true })).toBeDisabled();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    if (key === "matchSite") await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", new RegExp("^/admin/sites/" + match.order.api_client_id + "/orders/"));
    await record(page, info, { feature: "match-domain-scenarios", key, evidenceType: match.evidence_type, status: match.status });
    await screenshot(page, info, "dense-" + key);
  }
});

test("all genuine ledger versions and synthetic simultaneous associations remain visible", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const key of ["ledgerAssociated", "ledgerIdentical", "ledgerDisputed"]) {
    const entry = await data<AdminLedgerDetail>(page, manifest, apiPath(detailPath(manifest, key)));
    await openDetail(page, manifest, key);
    await expect(page.locator("[data-ledger-source]")).toHaveCount(entry.sources.length);
    await expect(page.locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
    await expect(page.locator("[data-ledger-conflict]")).toHaveCount(entry.conflicts.length);
    for (const source of entry.sources) await expect(page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`).getByText(source.ledger_entry_id, { exact: true })).toBeVisible();
    if (key === "ledgerIdentical") { expect(entry.content_consistent).toBe(true); expect(entry.sources.length).toBeGreaterThan(1); }
    if (key === "ledgerDisputed") {
      expect(entry.content_consistent).toBe(false);
      await expect(page.getByRole("alert")).toContainText("采集来源的交易信息有差异");
      await expect(page.locator("[data-ledger-summary]")).toContainText("有争议");
    }
    await record(page, info, { feature: "ledger-domain-scenarios", key, sources: entry.sources.length, matches: entry.matches.length, conflicts: entry.conflicts.length });
    await screenshot(page, info, "dense-" + key);
  }
  const path = apiPath(detailPath(manifest, "ledgerAssociated"));
  const entry = structuredClone(await data<AdminLedgerDetail>(page, manifest, path));
  const settled = entry.matches.find(match => match.status === "SETTLED");
  expect(settled).toBeTruthy();
  const second = { ...structuredClone(settled!), payment_match_id: "b0000000-0000-4000-8000-000000000002", order_id: "b0000000-0000-4000-8000-000000000003", merchant_order_no: "SYNTHETIC-SECOND-ACTIVE-ORDER", product_name: "合成的第二条生效关联" };
  entry.matches.push(second);
  entry.active_match_count = entry.matches.filter(match => match.status === "SETTLED").length;
  entry.active_match = null;
  await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: entry } }));
  await openDetail(page, manifest, "ledgerAssociated");
  await expect(page.getByRole("alert")).toContainText(`存在 ${entry.active_match_count} 条生效关联`);
  await expect(page.locator("[data-ledger-summary]")).toContainText("多条生效关联 · 请核查");
  await expect(page.locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
  await expect(page.getByText("当前实际关联", { exact: true })).toHaveCount(0);
  for (const match of [settled!, second]) await expect(page.locator(`[data-ledger-match="${match.payment_match_id}"]`).getByRole("link", { name: "查看订单：" + match.merchant_order_no, exact: true })).toHaveAttribute("href", "/admin/orders/" + match.order_id);
  await record(page, info, { feature: "ledger-multiple-associations", evidence: "synthetic-detail-response-only", activeMatchCount: entry.active_match_count });
  await screenshot(page, info, "dense-ledger-multiple-active-associations");
});

test("long products, complete identifiers and multiline details wrap without clipping", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const notificationPath = apiPath(detailPath(manifest, "notificationDns"));
  const notification = structuredClone(await data<WebhookDeliveryDetail>(page, manifest, notificationPath));
  const orderPath = "/api/admin/v1/orders/" + notification.event.order_id;
  const order = structuredClone(await data<AdminOrderDetail>(page, manifest, orderPath));
  const matchPath = apiPath(detailPath(manifest, "matchInferred"));
  const match = structuredClone(await data<PaymentMatchDetail>(page, manifest, matchPath));
  const ledgerPath = apiPath(detailPath(manifest, "ledgerAssociated"));
  const ledger = structuredClone(await data<AdminLedgerDetail>(page, manifest, ledgerPath));
  const product = "长商品名称与完整授权范围 · ".repeat(18) + "商品末尾标记";
  const memo = "第一行：保留详细业务说明和特殊字符 <>&\n第二行：保留原始换行及完整备注\n第三行：可见末尾标记";
  const identifier = "2026102122001010255800001184" + "0123456789".repeat(8);
  const target = new URL(notification.target.target_url);
  target.searchParams.set("description", "完整通知上下文".repeat(40));
  const targetUrl = target.href;
  expect(targetUrl.length).toBeGreaterThan(200);
  order.product_name = product;
  notification.target.target_url = targetUrl;
  notification.delivery.requested_by_type = "ADMIN";
  notification.delivery.requested_by_actor_id = "synthetic-layout-admin";
  notification.delivery.reason = memo;
  match.order.product_name = product;
  match.ledger_entry.provider_order_no = identifier;
  match.ledger_entry.memo = memo;
  ledger.memo = memo;
  ledger.provider_order_no = identifier;
  for (const source of ledger.sources) { source.memo = memo; source.provider_order_no = identifier; }
  for (const item of ledger.matches) item.product_name = product;
  for (const [path, value] of [[notificationPath, notification], [orderPath, order], [matchPath, match], [ledgerPath, ledger]] as const) await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: value } }));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await layout(page, theme, "compact");
    for (const scenario of scenarios) {
      await openDetail(page, manifest, scenario.key);
      const title = scenario.kind === "ledger" ? page.locator("[data-ledger-match] [data-slot=card-title]").first() : page.locator("[data-detail-order-summary] .detail-order-title");
      await expect(title).toHaveText(product);
      const bounds = await title.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        return { textHeight: text.height, boxHeight: box.height, textRight: text.right, boxRight: box.right };
      });
      expect(bounds.textHeight).toBeLessThanOrEqual(bounds.boxHeight + 1);
      expect(bounds.textRight).toBeLessThanOrEqual(bounds.boxRight + 1);
      await expect(page.locator("dd").filter({ hasText: "第三行：可见末尾标记" }).first()).toHaveText(memo);
      if (scenario.kind === "notification") {
        await expect(page.getByText(targetUrl, { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "复制通知地址", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(targetUrl);
      } else await expect(page.getByText(identifier, { exact: true }).first()).toBeVisible();
      await record(page, info, { feature: "detail-long-content", evidence: "synthetic-response-variants", width, theme, scenario: scenario.key, bounds, notificationUrlLength: targetUrl.length });
      await screenshot(page, info, `dense-long-${scenario.kind}-${width}-${theme}`);
    }
  }
});
