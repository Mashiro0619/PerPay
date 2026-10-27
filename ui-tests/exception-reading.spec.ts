import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { AdminOrderDetail, FinancialException, ReconciliationLedgerEntry } from "../web/src/api/generated/types.gen";

function path(manifest: Manifest, key: string) {
  const value = manifest.details[key];
  expect(value, "named exception fixture: " + key).toBeTruthy();
  return value!;
}
async function read<T>(page: Page, manifest: Manifest, endpoint: string): Promise<T> {
  const response = await page.request.get(manifest.origin + endpoint);
  expect(response.status(), endpoint).toBe(200);
  return (await response.json() as { data: T }).data;
}
function endpoint(manifest: Manifest, key: string) { return "/api/admin/v1" + path(manifest, key); }
async function appearance(page: Page, theme: "light" | "dark", mode: "compact" | "full") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(({ theme, mode }) => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", mode);
  }, { theme, mode });
}
async function open(page: Page, manifest: Manifest, key: string) {
  await page.goto(manifest.origin + "/admin" + path(manifest, key));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
  const card = page.getByRole("group", { name: "账务异常记录", exact: true });
  await expect(card).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return card;
}
async function geometry(page: Page, mode: "compact" | "full") {
  const main = page.locator("#main-content");
  const frame = await main.evaluate(main => {
    const content = main.querySelector("[data-content-width]")!, detail = main.querySelector("[data-detail-page]")!;
    return { width: content.getBoundingClientRect().width, maximum: Number.parseFloat(getComputedStyle(content).maxWidth), layout: content.getAttribute("data-content-layout"), gap: Number.parseFloat(getComputedStyle(detail).rowGap) };
  });
  expect(frame.layout).toBe("detail");
  expect(frame.maximum).toBe(mode === "compact" ? 1024 : 1280);
  expect(frame.width).toBeLessThanOrEqual(frame.maximum);
  if (page.viewportSize()?.width === 2190) expect(frame.width).toBe(frame.maximum);
  expect(frame.gap).toBe(24);
  const groups = await main.locator('[data-detail-fields][data-density="comfortable"]').evaluateAll(containers => containers.map(container => {
    const dl = container.querySelector("dl")!, bounds = container.getBoundingClientRect(), style = getComputedStyle(dl);
    return { width: bounds.width, left: bounds.left, right: bounds.right, credentials: !!container.closest("[data-detail-credentials]"), layout: container.getAttribute("data-layout"), display: style.display,
      columns: style.gridTemplateColumns.trim().split(/\s+/).length, columnGap: Number.parseFloat(style.columnGap), rowGap: Number.parseFloat(style.rowGap),
      fields: Array.from(dl.children).map(field => {
        const box = field.getBoundingClientRect(), term = field.querySelector("dt")!, value = field.querySelector("dd")!;
        return { name: term.textContent, wide: field.getAttribute("data-field-wide") === "true", width: box.width, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          gap: value.getBoundingClientRect().top - term.getBoundingClientRect().bottom, scrollWidth: value.scrollWidth, clientWidth: value.clientWidth,
          labelFont: Number.parseFloat(getComputedStyle(term).fontSize), valueFont: Number.parseFloat(getComputedStyle(value).fontSize) };
      }) };
  }));
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    expect(group.layout).toBe(group.credentials ? "columns" : "flow");
    expect(group.display).toBe(group.credentials ? "grid" : "flex");
    expect(group.columnGap).toBe(group.credentials ? 16 : 24);
    expect(group.rowGap).toBe(16);
    if (group.credentials) expect(group.columns).toBe(group.width >= 640 ? 2 : 1);
    const rows: Array<typeof group.fields> = [];
    for (const [index, field] of group.fields.entries()) {
      expect(field.left).toBeGreaterThanOrEqual(group.left - 1);
      expect(field.right).toBeLessThanOrEqual(group.right + 1);
      expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth + 1);
      expect(Math.abs(field.gap - 8)).toBeLessThanOrEqual(0.5);
      expect(field.labelFont).toBeGreaterThanOrEqual(14);
      expect(field.valueFont).toBeGreaterThanOrEqual(14);
      if (group.credentials) expect(Math.abs(field.width - (group.width - (group.columns - 1) * 16) / group.columns)).toBeLessThanOrEqual(1);
      else if (field.wide || group.width < 640) expect(Math.abs(field.width - group.width)).toBeLessThanOrEqual(1);
      else { expect(field.width).toBeGreaterThanOrEqual(191); expect(field.width).toBeLessThanOrEqual(257); }
      const previous = group.fields[index - 1];
      if (previous) {
        expect(field.top, "DOM reading order: " + field.name).toBeGreaterThanOrEqual(previous.top - 1);
        if (Math.abs(field.top - previous.top) <= 1) expect(field.left).toBeGreaterThan(previous.left);
      }
      const row = rows.at(-1);
      if (row && Math.abs(row[0]!.top - field.top) <= 1) row.push(field); else rows.push([field]);
    }
    for (const [index, row] of rows.entries()) {
      expect(row.length).toBeLessThanOrEqual(group.credentials ? group.columns : 4);
      expect(Math.abs(row[0]!.left - group.left)).toBeLessThanOrEqual(1);
      if (!group.credentials && (group.width < 640 || row.some(field => field.wide))) expect(row).toHaveLength(1);
      for (let item = 1; item < row.length; item++) expect(Math.abs(row[item]!.left - row[item - 1]!.right - group.columnGap)).toBeLessThanOrEqual(1);
      const previous = rows[index - 1];
      if (previous) expect(Math.abs(row[0]!.top - Math.max(...previous.map(field => field.bottom)) - 16)).toBeLessThanOrEqual(1);
    }
  }
  const card = page.locator("[data-financial-exception]");
  await expect(card).toHaveAttribute("data-size", "default");
  await expect(card.locator('[data-slot="card-footer"]')).toHaveCount(0);
  await expect(card.locator('[data-slot="card-action"]').getByRole("button", { name: "更多操作，异常记录操作", exact: true })).toBeVisible();
  await expect(main.locator("[data-detail-identifier]")).toHaveCount(0);
  return { frame, groups };
}

test("exception global and site details retain standard cards across the complete reading matrix", async ({ page, manifest }, info) => {
  test.setTimeout(360_000);
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET" && request.method() !== "HEAD") writes.push(request.method() + " " + new URL(request.url()).pathname); });
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) for (const key of ["exceptionOpen", "exceptionSite"]) {
    await page.setViewportSize({ width, height: 900 });
    await appearance(page, theme, mode);
    const card = await open(page, manifest, key);
    await expect(card.getByRole("heading", { level: 2 })).toHaveText("收银台结束后收到付款");
    await expect(card.locator("[data-detail-order-summary]")).toBeVisible();
    await expect(card.getByRole("region", { name: "核对凭据", exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="card-action"]').getByRole("button", { name: "人工关联收款", exact: true })).toBeVisible();
    await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
    await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
    const measured = await geometry(page, mode);
    await record(page, info, { feature: "exception-reading-matrix", key, width, theme, mode, measured, evidence: "local-synthetic-domain" });
    await screenshot(page, info, `exception-${key}-${width}-${theme}-${mode}`);
    if (width === 320 && mode === "compact") await audit(page, info, `exception-${key}-${theme}`);
  }
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test("genuine ignored, resolved, candidate and unlinked exceptions keep their evidence visible", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await appearance(page, "dark", "compact");
  for (const key of ["exceptionIgnored", "exceptionResolved", "exceptionCandidate", "exceptionUnmatched"]) {
    const exception = await read<FinancialException>(page, manifest, endpoint(manifest, key));
    const card = await open(page, manifest, key);
    if (key === "exceptionIgnored") {
      expect(exception.reminder_ignored).toBe(true);
      await expect(card.locator('[data-slot="card-action"]')).toContainText("未处理 · 已忽略");
    }
    if (key === "exceptionResolved") {
      expect(exception.status).toBe("RESOLVED");
      await expect(card.locator('[data-slot="card-action"]')).toContainText("已处理");
      await expect(card.getByText("处理结果", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(0);
    }
    if (key === "exceptionCandidate") {
      expect(exception.candidate_id).toBeTruthy();
      await expect(card.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
      await expect(card.getByText("金额占用时间", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(0);
    }
    if (key === "exceptionUnmatched") {
      expect(exception.order_id).toBeNull();
      await expect(card.getByText("尚未关联订单", { exact: true })).toBeVisible();
      await expect(card.locator("[data-detail-order-summary]")).toHaveCount(0);
    }
    if (exception.ledger_entry_id) await expect(card.getByRole("region", { name: "核对凭据", exact: true }).getByText(exception.ledger_entry_id, { exact: true })).toBeVisible();
    await record(page, info, { feature: "exception-domain-scenarios", key, exceptionType: exception.exception_type, status: exception.status, measured: await geometry(page, "compact") });
    await screenshot(page, info, "exception-" + key);
  }
});

test("retired and context-free synthetic exceptions remain readable without inventing related facts", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await login(page, manifest);
  const original = await read<FinancialException>(page, manifest, endpoint(manifest, "exceptionUnmatched"));
  for (const retired of [false, true]) {
    const exception: FinancialException = { ...structuredClone(original), order_id: null, candidate_id: null, ledger_entry_id: null, exception_type: retired ? "UNMATCHED_DEBIT" : "UNMATCHED_CREDIT" };
    await page.route(manifest.origin + endpoint(manifest, "exceptionUnmatched"), route => route.fulfill({ status: 200, json: { data: exception } }));
    const card = await open(page, manifest, "exceptionUnmatched");
    await expect(card.getByText("尚未关联订单", { exact: true })).toBeVisible();
    await expect(card.getByRole("region", { name: "核对凭据", exact: true })).toHaveCount(0);
    await expect(card.getByRole("heading", { name: "匹配依据", exact: true })).toHaveCount(0);
    if (retired) {
      await expect(card.locator('[data-slot="card-action"]')).toContainText("历史记录");
      await expect(card.getByText("旧版支出提示，不再提醒。", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(0);
    } else await expect(card.getByRole("button", { name: "人工关联收款", exact: true })).toBeVisible();
    await record(page, info, { feature: "exception-empty-retired", retired, evidence: "synthetic-exception-response-only" });
    await page.unroute(manifest.origin + endpoint(manifest, "exceptionUnmatched"));
  }
});

test("exception and source read failures stay explicit and recover only after retry", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const exceptionPath = endpoint(manifest, "exceptionOpen");
  const exception = await read<FinancialException>(page, manifest, exceptionPath);
  expect(exception.ledger_entry_id).toBeTruthy();
  for (const failedPath of [exceptionPath, "/api/admin/v1/reconciliation/ledger-entries/" + exception.ledger_entry_id]) {
    let unavailable = true;
    let reads = 0;
    await page.route(manifest.origin + failedPath, route => {
      reads++;
      return unavailable ? route.fulfill({ status: 503, json: { error: { code: "synthetic_exception_unavailable", message: "合成的异常凭据读取失败" } } }) : route.continue();
    });
    await page.goto(manifest.origin + "/admin" + path(manifest, "exceptionOpen"));
    const main = page.locator("#main-content");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
    const alert = main.getByRole("alert").filter({ hasText: "合成的异常凭据读取失败" });
    await expect(alert).toBeVisible();
    await expect(main.getByRole("region", { name: "核对凭据", exact: true })).toHaveCount(0);
    if (failedPath !== exceptionPath) await expect(main.locator("[data-detail-order-summary]")).toBeVisible();
    const before = reads;
    unavailable = false;
    await alert.getByRole("button", { name: "重试", exact: true }).click();
    await expect(main.getByRole("region", { name: "核对凭据", exact: true })).toBeVisible();
    await expect(alert).toHaveCount(0);
    expect(reads).toBeGreaterThan(before);
    await record(page, info, { feature: "exception-read-recovery", failedPath, before, after: reads, evidence: "synthetic-503-then-real-fixture-read" });
    await page.unroute(manifest.origin + failedPath);
  }
});

test("exception inline tools and manual confirmation preserve copy, scope and keyboard focus without writes", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const writes: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
  for (const key of ["exceptionOpen", "exceptionSite"]) {
    const exception = await read<FinancialException>(page, manifest, endpoint(manifest, key));
    const card = await open(page, manifest, key);
    const tools = card.getByRole("button", { name: "更多操作，异常记录操作", exact: true });
    await tools.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "技术详情", exact: true }).click();
    const technical = page.getByRole("dialog", { name: "技术详情", exact: true });
    await expect(technical.getByRole("heading", { name: "技术详情", exact: true })).toBeFocused();
    await technical.getByRole("button", { name: "复制异常编号", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exception.exception_id);
    await page.keyboard.press("Escape");
    await expect(technical).toHaveCount(0);
    await expect(tools).toBeFocused();
    const credentials = card.getByRole("region", { name: "核对凭据", exact: true });
    await credentials.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exception.ledger_entry_id);
    const action = card.getByRole("button", { name: "人工关联收款", exact: true });
    await action.focus();
    await page.keyboard.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "人工关联收款", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "确认关联收款", exact: true })).toBeEnabled();
    const reason = "核对原始凭据后再确认，保留完整理由。\n".repeat(12);
    await confirmation.getByLabel("操作理由（可选）", { exact: true }).fill(reason);
    await expect(confirmation.getByLabel("操作理由（可选）", { exact: true })).toHaveValue(reason);
    await expect(confirmation.locator('[data-detail-fields][data-layout="flow"]')).toHaveCount(0);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(action).toBeFocused();
    const scope = path(manifest, key).split("/reconciliation/")[0];
    await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", "/admin" + scope + "/orders/" + exception.order_id);
    await record(page, info, { feature: "exception-inline-focus-copy", key, reasonLength: reason.length, evidence: "read-only-confirmation-open-and-cancel" });
  }
  expect(writes).toEqual([]);
});

test("exception back navigation preserves scoped filters and record identity", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await login(page, manifest);
  for (const key of ["exceptionOpen", "exceptionSite"]) {
    const scope = path(manifest, key).split("/reconciliation/")[0];
    const listPath = scope ? scope + "/work-items?type=FINANCIAL_EXCEPTION&sort_by=created_at&sort_order=asc" : "/reconciliation?tab=exceptions&sort_by=created_at&sort_order=asc";
    await page.goto(manifest.origin + "/admin" + listPath);
    const links = page.locator('[data-business-row] a[data-row-link][href*="/reconciliation/exceptions/"]');
    await expect(links.first()).toBeVisible();
    const listUrl = page.url(), count = await links.count();
    const link = links.nth(count - 1), href = await link.getAttribute("href");
    await link.focus();
    await page.clock.runFor(100);
    const scrollBefore = await page.evaluate(() => scrollY);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
    const back = page.locator("[data-detail-navigation]").getByRole("link").first();
    await expect(back).toHaveAttribute("href", new URL(listUrl).pathname + new URL(listUrl).search);
    await back.click();
    await expect(page).toHaveURL(listUrl);
    await expect(links).toHaveCount(count);
    const scrollAfterReturn = await page.evaluate(() => scrollY);
    const returned = page.locator('[data-business-row] a[data-row-link][href="' + href + '"]');
    await expect(returned).toHaveCount(1);
    await expect(returned).toBeVisible();
    await record(page, info, { feature: "exception-list-return", key, count, listUrl, recordHref: href, scrollBefore, scrollAfterReturn, scrollRestoration: "not-provided-by-existing-exception-navigation", evidence: "local-synthetic-domain" });
    await returned.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
    await expect(page.locator("[data-financial-exception]")).toBeVisible();
  }
});

test("exception long credentials, counterparties and multiline notes wrap completely in both entry scopes", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const exception = await read<FinancialException>(page, manifest, endpoint(manifest, "exceptionOpen"));
  const order = await read<AdminOrderDetail>(page, manifest, "/api/admin/v1/orders/" + exception.order_id);
  const ledger = await read<ReconciliationLedgerEntry>(page, manifest, "/api/admin/v1/reconciliation/ledger-entries/" + exception.ledger_entry_id);
  const product = "完整商品名称与授权范围 · ".repeat(16) + "商品末尾";
  const site = "完整网站名称与经营主体 · ".repeat(16) + "网站末尾";
  const counterpart = "付款账户与交易对方 · ".repeat(16) + "对方末尾";
  const number = "20261021" + "0123456789".repeat(24);
  const memo = "第一行：保留异常凭据说明 <>&\n第二行：完整原始交易备注\n第三行：备注末尾";
  order.product_name = product; order.site_name = site; order.merchant_order_no = "MERCHANT-".repeat(30);
  ledger.provider_order_no = number; ledger.merchant_order_no = "ALIPAY-MERCHANT-".repeat(20); ledger.other_account = counterpart; ledger.memo = memo;
  await page.route(new RegExp("/api/admin/v1/(?:sites/[^/]+/)?orders/" + exception.order_id + "(?:\\?.*)?$"), route => route.fulfill({ status: 200, json: { data: order } }));
  await page.route(new RegExp("/api/admin/v1/(?:sites/[^/]+/)?reconciliation/ledger-entries/" + exception.ledger_entry_id + "(?:\\?.*)?$"), route => route.fulfill({ status: 200, json: { data: ledger } }));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) for (const key of ["exceptionOpen", "exceptionSite"]) {
    await page.setViewportSize({ width, height: 900 });
    await appearance(page, theme, "compact");
    const card = await open(page, manifest, key);
    await expect(card.locator('[data-detail-order-summary] [data-slot="item-title"]')).toHaveText(product);
    await expect(card.locator("dd").filter({ hasText: "第三行：备注末尾" })).toHaveText(memo);
    const wrapped = [];
    for (const [name, value] of [["所属网站", site], ["支付宝交易对方", counterpart], ["支付宝订单号", number]]) {
      const field = card.locator("dt").filter({ hasText: new RegExp("^" + name + "$") }).locator("..");
      await expect(field.locator("dd")).toContainText(value!);
      const measured = await field.evaluate(field => {
        const value = field.querySelector("dd")!, box = value.getBoundingClientRect();
        const textElement = value.querySelector("span.break-all") ?? value;
        const range = document.createRange(); range.selectNodeContents(textElement);
        const text = range.getBoundingClientRect(), textBox = textElement.getBoundingClientRect();
        return { name: field.querySelector("dt")!.textContent, height: box.height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight), textHeight: text.height, boxHeight: textBox.height, textRight: text.right, boxRight: textBox.right };
      });
      expect(measured.height).toBeGreaterThan(measured.lineHeight * 2);
      expect(measured.textHeight).toBeLessThanOrEqual(measured.boxHeight + 1);
      expect(measured.textRight).toBeLessThanOrEqual(measured.boxRight + 1);
      wrapped.push(measured);
    }
    await card.getByRole("button", { name: "复制支付宝订单号", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(number);
    const measured = await geometry(page, "compact");
    await record(page, info, { feature: "exception-long-content", key, width, theme, wrapped, measured, evidence: "synthetic-order-and-ledger-responses-only" });
    await screenshot(page, info, `exception-long-${key}-${width}-${theme}`);
  }
});
