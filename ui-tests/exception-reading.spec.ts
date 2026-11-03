import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { settleOverlay } from "./overlay-fixtures";
import { audit, screenshot } from "./audit";
import { expectDetailRecordLayout } from "./detail-layout";
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
  await settleOverlay(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
  const card = page.getByRole("group", { name: "账务异常记录", exact: true });
  await expect(card).toBeVisible();
  await expect(page.locator('[data-overlay-detail] [data-slot="skeleton"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return card;
}
// pre-wrap may hang line-ending spaces outside a line box. Check every
// non-whitespace character with the same 1 px tolerance, and retain raw ranges
// plus hanging whitespace as evidence instead of treating invisible advances as ink.
function completeFieldGeometry(field: Element) {
  const value = field.querySelector("dd")!, box = value.getBoundingClientRect();
  const textElement = value.querySelector("span.break-all") ?? value;
  const textBox = textElement.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(textElement);
  const raw = range.getBoundingClientRect();
  const walker = document.createTreeWalker(textElement, NodeFilter.SHOW_TEXT);
  const characters: Array<{ text: string; left: number; top: number; right: number; bottom: number }> = [];
  const hangingWhitespace: Array<{ text: string; right: number; beyondRight: number }> = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let offset = 0;
    for (const text of node.textContent ?? "") {
      const start = offset; offset += text.length;
      range.setStart(node, start); range.setEnd(node, offset);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        if (text.trim()) characters.push({ text, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
        else if (rect.right > textBox.right + 1) hangingWhitespace.push({ text, right: rect.right, beyondRight: rect.right - textBox.right });
      }
    }
  }
  const top = Math.min(...characters.map(character => character.top));
  const bottom = Math.max(...characters.map(character => character.bottom));
  return { name: field.querySelector("dt")!.textContent, fieldWidth: field.getBoundingClientRect().width,
    height: box.height, valueHeight: box.height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
    textHeight: bottom - top, boxHeight: textBox.height, textRight: Math.max(...characters.map(character => character.right)), boxRight: textBox.right,
    textBottom: bottom, boxBottom: textBox.bottom, characterCount: characters.length, characterText: characters.map(character => character.text).join(""),
    rawTextRight: raw.right, rawTextHeight: raw.height, hangingWhitespace };
}

async function geometry(page: Page, mode: "compact" | "full") {
  const main = page.locator("[data-overlay-detail]");
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
  const measured = await expectDetailRecordLayout(page);
  const card = main.locator("[data-financial-exception]");
  await expect(card).toHaveCSS("border-radius", "0px");
  await expect(card).toHaveCSS("box-shadow", "none");
  await expect(card.locator('[data-slot="card-footer"]')).toHaveCount(0);
  await expect(card.getByRole("button", { name: "技术信息", exact: true })).toBeVisible();
  await expect(main.locator("[data-detail-identifier]")).toHaveCount(0);
  return measured;
}

test("exception global and site overlays retain readable evidence across the complete reading matrix", async ({ page, manifest }, info) => {
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
      await expect(card.locator('[data-slot="card-header"]').getByText("未处理 · 已忽略", { exact: true })).toBeVisible();
    }
    if (key === "exceptionResolved") {
      expect(exception.status).toBe("RESOLVED");
      await expect(card.locator('[data-slot="card-header"]').getByText("已处理", { exact: true })).toBeVisible();
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
      await expect(card.locator('[data-slot="card-header"]').getByText("历史记录", { exact: true })).toBeVisible();
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
    const main = page.locator("[data-overlay-detail]");
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

test("exception technical dialogs and manual confirmation preserve copy, scope and keyboard focus without writes", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const writes: string[] = [];
  page.on("request", request => { if (!["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
  for (const key of ["exceptionOpen", "exceptionSite"]) {
    const exception = await read<FinancialException>(page, manifest, endpoint(manifest, key));
    const card = await open(page, manifest, key);
    const entry = card.locator("[data-technical-information]");
    const tools = entry.getByRole("button", { name: "技术信息", exact: true });
    const parent = page.locator("[data-overlay-content]");
    await tools.focus();
    const parentGeometry = () => parent.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>("[data-overlay-detail]")!;
      return { width: bounds.width, height: bounds.height, contentHeight: body.scrollHeight, scrollTop: body.scrollTop };
    });
    const beforeTechnical = await parentGeometry();
    const detailUrl = page.url();
    await page.keyboard.press("Enter");
    const technical = page.getByRole("dialog", { name: "技术信息", exact: true });
    await expect(technical).toBeVisible();
    await expect(technical.locator('pre[aria-label="技术信息"]')).toBeVisible();
    await expect(entry.locator("pre")).toHaveCount(0);
    expect(await technical.evaluate(element => !!element.closest("[data-overlay-content]"))).toBe(false);
    const duringTechnical = await parentGeometry();
    for (const name of ["width", "height", "contentHeight", "scrollTop"] as const) expect(duringTechnical[name]).toBeCloseTo(beforeTechnical[name], 1);
    expect(page.url()).toBe(detailUrl);
    await page.keyboard.press("Tab");
    await expect(technical.getByRole("button", { name: "关闭技术信息", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(technical.getByRole("button", { name: "复制异常编号", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exception.exception_id);
    if (key === "exceptionOpen") await page.keyboard.press("Escape");
    else await technical.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(technical).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(tools).toBeFocused();
    const afterTechnical = await parentGeometry();
    for (const name of ["width", "height", "contentHeight", "scrollTop"] as const) expect(afterTechnical[name]).toBeCloseTo(beforeTechnical[name], 1);
    const credentials = card.getByRole("region", { name: "核对凭据", exact: true });
    await credentials.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(exception.ledger_entry_id);
    const action = card.getByRole("button", { name: "人工关联收款", exact: true });
    await action.focus();
    await page.keyboard.press("Enter");
    const confirmation = page.getByRole("dialog", { name: "人工关联收款", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(page.locator("[data-overlay-content]")).not.toHaveAttribute("data-overlay-record", "true");
    await expect(confirmation.getByRole("button", { name: "确认关联收款", exact: true })).toBeEnabled();
    const reason = "核对原始凭据后再确认，保留完整理由。\n".repeat(12);
    await confirmation.getByLabel("操作理由（可选）", { exact: true }).fill(reason);
    await expect(confirmation.getByLabel("操作理由（可选）", { exact: true })).toHaveValue(reason);
    await expect(confirmation.locator('[data-detail-fields][data-layout="flow"]')).toHaveCount(0);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(action).toBeFocused();
    await expect(page.locator("[data-overlay-content]")).toHaveAttribute("data-overlay-record", "true");
    const scope = path(manifest, key).split("/reconciliation/")[0];
    const orderLink = card.locator('[data-detail-order-summary] [data-slot="item-title"] a');
    const orderHref = new URL((await orderLink.getAttribute("href"))!, page.url());
    expect(orderHref.searchParams.get("overlay")).toBe(scope + "/orders/" + exception.order_id);
    await record(page, info, { feature: "exception-technical-dialog-focus-copy", key, reasonLength: reason.length, parentBefore: beforeTechnical, parentDuring: duringTechnical, parentAfter: afterTechnical, evidence: "read-only-technical-dialog-and-confirmation-open-and-cancel" });
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
    const links = page.locator('[data-business-row] a[data-row-link][href*="%2Freconciliation%2Fexceptions%2F"]');
    await expect(links.first()).toBeVisible();
    const listUrl = page.url(), count = await links.count();
    const link = links.nth(count - 1), href = await link.getAttribute("href");
    await link.focus();
    await page.clock.runFor(100);
    const scrollBefore = await page.evaluate(() => scrollY);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + href);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
    const overlay = await settleOverlay(page);
    await overlay.getByRole("button", { name: "关闭对话框", exact: true }).click();
    await expect(page).toHaveURL(listUrl);
    await page.clock.runFor(250);
    await expect(page.locator("[data-overlay-content]")).toHaveCount(0);
    await expect(links).toHaveCount(count);
    const scrollAfterReturn = await page.evaluate(() => scrollY);
    const returned = page.locator('[data-business-row] a[data-row-link][href="' + href + '"]');
    await expect(returned).toHaveCount(1);
    await expect(returned).toBeVisible();
    await expect(returned).toBeFocused();
    expect(Math.abs(scrollAfterReturn - scrollBefore)).toBeLessThanOrEqual(5);
    await record(page, info, { feature: "exception-list-return", key, count, listUrl, recordHref: href, scrollBefore, scrollAfterReturn, scrollRestoration: "overlay-retains-list-scroll-and-trigger-focus", evidence: "local-synthetic-domain" });
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
      const measured = await field.evaluate(completeFieldGeometry);
      expect(measured.characterText).toBe(value!.replace(/\s/gu, ""));
      if (measured.hangingWhitespace.length || measured.textRight > measured.boxRight + 1) await info.attach(`text-bounds-${key}-${width}-${theme}-${name}`, {
        body: JSON.stringify(measured, null, 2), contentType: "application/json",
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
