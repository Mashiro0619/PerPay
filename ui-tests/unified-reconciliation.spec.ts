import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { screenshot } from "./audit";
import type { AdminLedgerDetail, AdminLedgerPageEnvelope, AdminLedgerSummary, PaymentMatchDetail } from "../web/src/api/generated/types.gen";

const listPath = "/reconciliation";
const detailPath = (id: string) => "/reconciliation/transactions/" + id;
const list = (page: Page) => page.locator('[data-business-list="ledger"]');
const rows = (page: Page) => list(page).locator("[data-business-row]");
const groupedApi = "/api/admin/v1/ledger/entries";

async function ledgerPage(page: Page, origin: string, query: Record<string, string> = {}) {
  const response = await page.request.get(origin + groupedApi + "?" + new URLSearchParams({ limit: "20", ...query }));
  expect(response.status()).toBe(200);
  return await response.json() as AdminLedgerPageEnvelope;
}

async function ledgerDetail(page: Page, origin: string, id: string) {
  const response = await page.request.get(origin + groupedApi + "/" + id);
  expect(response.status()).toBe(200);
  return (await response.json() as { data: AdminLedgerDetail }).data;
}

async function matchDetail(page: Page, origin: string, path: string) {
  const response = await page.request.get(origin + "/api/admin/v1" + path);
  expect(response.status()).toBe(200);
  return (await response.json() as { data: PaymentMatchDetail }).data;
}

async function expectRows(page: Page, entries: readonly AdminLedgerSummary[]) {
  await expect(rows(page)).toHaveCount(entries.length);
  for (const [index, entry] of entries.entries()) {
    await expect(rows(page).nth(index).locator("a[data-row-link]"))
      .toHaveAttribute("href", "/admin" + detailPath(entry.ledger_entry_id));
    await expect(rows(page).nth(index).locator("a[data-row-link]")).toHaveText(entry.external_event_id);
  }
}

async function select(page: Page, control: Locator, option: string) {
  await control.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function expectRecoveryFocus(origin: Locator) {
  // A rejected attempt has not moved a financial record. The retained action or
  // the page's deliberate main/back fallback are all live recovery targets.
  await expect.poll(() => origin.evaluate(element => {
    const active = document.activeElement;
    const main = document.getElementById("main-content");
    return active === element || active === main ||
      (!!active?.isConnected && active instanceof HTMLAnchorElement && !!main?.contains(active) &&
        active.pathname === new URL("reconciliation", location.origin + "/admin/").pathname &&
        /对账/.test(active.textContent ?? ""));
  })).toBe(true);
}

test("one reconciliation table searches transaction, website product and association identities without row detail reads", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const match = await matchDetail(page, manifest.origin, manifest.details.matchManual!);
  const product = Array.from(match.order.product_name).slice(0, 32).join("");
  const requests: string[] = [];
  const writes: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/admin/v1/")) requests.push(url.pathname);
    if (!["GET", "HEAD"].includes(request.method()) && /settlement|matches.*reverse|ledger.*resolve/.test(url.pathname)) writes.push(url.pathname);
  });
  await page.goto(manifest.origin + "/admin" + listPath);
  await expect(page.getByRole("tab", { name: "支付宝流水", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "收款关联", exact: true })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(20);
  const navigation = page.getByRole("navigation", { name: "全局管理", exact: true });
  await expect(navigation.getByRole("link", { name: "对账", exact: true })).toHaveCount(1);
  await expect(navigation.getByRole("link", { name: "支付宝流水", exact: true })).toHaveCount(0);

  for (const keyword of [product, match.payment_match_id, match.ledger_entry_id]) {
    const expected = await ledgerPage(page, manifest.origin, { q: keyword });
    expect(expected.data.length).toBeGreaterThan(0);
    const search = page.getByRole("searchbox", { name: "支付宝流水关键词搜索", exact: true });
    await search.fill(keyword);
    await search.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(keyword);
    await expectRows(page, expected.data);
    expect(expected.data.some(entry => entry.external_event_id === match.ledger_entry.external_event_id)).toBe(true);
  }
  expect(requests.filter(path => /\/reconciliation\/matches\/[^/]+$|\/ledger\/entries\/[^/]+$/.test(path))).toEqual([]);
  expect(writes).toEqual([]);
  await record(page, info, { feature: "one-table-product-and-association-search", evidence: "isolated-synthetic-ledger-api", requests, writes });
});

test("current association, reversal history and association dates combine on the same grouped rows", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin" + listPath);
  await select(page, page.getByRole("combobox", { name: "关联状态筛选", exact: true }), "已关联");
  const matched = await ledgerPage(page, manifest.origin, { association_status: "MATCHED" });
  await expectRows(page, matched.data);
  expect(matched.page.next_cursor).toBeTruthy();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/);
  await select(page, page.getByRole("combobox", { name: "撤销记录筛选", exact: true }), "有撤销记录");
  const history = await ledgerPage(page, manifest.origin, { association_status: "MATCHED", has_reversals: "true" });
  expect(history.data.length).toBeGreaterThan(0);
  await expectRows(page, history.data);
  expect(new URL(page.url()).searchParams.get("has_reversals")).toBe("true");
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  for (const entry of history.data) {
    expect(entry.active_match_count).toBe(1);
    expect(entry.reversed_match_count).toBeGreaterThan(0);
    await expect(rows(page).filter({ has: page.locator('a[data-row-link][title="' + entry.external_event_id + '"]') })).toContainText("已关联");
  }

  const selected = history.data[0]!;
  const group = await ledgerDetail(page, manifest.origin, selected.ledger_entry_id);
  const oldAssociation = group.matches.find(match => match.status === "REVERSED")!;
  const associatedDate = new Date(Date.parse(oldAssociation.created_at) + 8 * 3_600_000).toISOString().slice(0, 10);
  await page.getByRole("combobox", { name: "关联日期范围", exact: true }).click();
  await page.getByRole("option", { name: "自定义日期", exact: true }).click();
  const dateDialog = page.getByRole("dialog", { name: "自定义关联日期", exact: true });
  await dateDialog.getByLabel("开始日期", { exact: true }).fill(associatedDate);
  await dateDialog.getByLabel("结束日期", { exact: true }).fill(associatedDate);
  await dateDialog.getByRole("button", { name: "应用日期", exact: true }).click();
  await expect(dateDialog).not.toBeVisible();
  const dates = new URL(page.url()).searchParams;
  expect(dates.get("associated_from")).toBe(associatedDate);
  expect(dates.get("associated_to")).toBe(associatedDate);
  expect(dates.has("occurred_from")).toBe(false);
  expect(dates.has("created_from")).toBe(false);
  const day = await ledgerPage(page, manifest.origin, { association_status: "MATCHED", has_reversals: "true", associated_from: associatedDate, associated_to: associatedDate });
  await expectRows(page, day.data);
  expect(day.data.some(entry => entry.ledger_entry_id === selected.ledger_entry_id)).toBe(true);
  for (const sortBy of ["occurred_at", "associated_at", "handled_at", "amount_cents", "event_sequence"]) {
    const query = { association_status: "MATCHED", has_reversals: "true", sort_by: sortBy, sort_order: "desc" };
    const expected = await ledgerPage(page, manifest.origin, query);
    await page.goto(manifest.origin + "/admin" + listPath + "?" + new URLSearchParams(query));
    await expectRows(page, expected.data);
  }
  await record(page, info, { feature: "current-and-reversed-coexist", evidence: "real-isolated-synthetic-records", selectedSource: selected.ledger_entry_id, reversedMatch: oldAssociation.payment_match_id, associatedDate });
  await screenshot(page, info, "unified-current-association-with-reversal-history");
});

test("legacy list bookmarks migrate association semantics and discard incompatible cursors", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const match = await matchDetail(page, manifest.origin, manifest.details.matchManual!);
  const associatedDate = new Date(Date.parse(match.created_at) + 8 * 3_600_000).toISOString().slice(0, 10);
  for (const status of ["SETTLED", "REVERSED"]) {
    const query = new URLSearchParams({ tab: "matches", status, sort_by: "created_at", sort_order: "asc", q: match.order.product_name, created_from: associatedDate, created_to: associatedDate, cursor: "legacy-not-a-transaction-cursor", page: "8", selected_site: match.order.api_client_id! });
    await page.goto(manifest.origin + "/admin/reconciliation?" + query);
    await expect(page.getByRole("tab", { name: "支付宝流水", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("transactions");
    const migrated = new URL(page.url()).searchParams;
    expect(migrated.get("sort_by")).toBe("associated_at");
    expect(migrated.get("sort_order")).toBe("asc");
    expect(migrated.get("q")).toBe(match.order.product_name);
    expect(migrated.get("selected_site")).toBe(match.order.api_client_id);
    expect(migrated.get("associated_from")).toBe(associatedDate);
    expect(migrated.get("associated_to")).toBe(associatedDate);
    expect(migrated.has("created_from")).toBe(false);
    expect(migrated.has("created_to")).toBe(false);
    expect(migrated.has("cursor")).toBe(false);
    expect(migrated.has("page")).toBe(false);
    expect(migrated.has("status")).toBe(false);
    if (status === "REVERSED") {
      expect(migrated.get("has_reversals")).toBe("true");
      expect(migrated.has("association_status")).toBe(false);
    } else expect(migrated.get("association_status")).toBe("MATCHED");
  }
  await page.goto(manifest.origin + "/admin/ledger?direction=CREDIT&min_amount_cents=0&selected_site=" + match.order.api_client_id);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/admin/reconciliation");
  expect(new URL(page.url()).searchParams.get("direction")).toBe("CREDIT");
  expect(new URL(page.url()).searchParams.get("min_amount_cents")).toBe("0");
  expect(new URL(page.url()).searchParams.get("selected_site")).toBe(match.order.api_client_id);
  await expect(rows(page)).toHaveCount(20);
  await record(page, info, { feature: "legacy-list-migration", incompatibleCursorRemoved: true });
});

test("legacy global details resolve the unified transaction while site evidence stays scoped", async ({ page, manifest }, info) => {
  await login(page, manifest);
  const match = await matchDetail(page, manifest.origin, manifest.details.matchManual!);
  const group = await ledgerDetail(page, manifest.origin, match.ledger_entry_id);
  for (const path of ["/ledger/" + match.ledger_entry_id, "/reconciliation/ledger/" + match.ledger_entry_id, manifest.details.matchManual!]) {
    await page.goto(manifest.origin + "/admin" + path);
    await expect(page).toHaveURL(/\/admin\/reconciliation\/transactions\//);
    await expect(page.locator("[data-ledger-summary]")).toContainText(group.external_event_id);
    await expect(page.locator('[data-ledger-match="' + match.payment_match_id + '"]')).toBeVisible();
  }
  const refreshed: string[] = [];
  const refreshedRequest = (request: { url(): string }) => refreshed.push(new URL(request.url()).pathname);
  page.on("request", refreshedRequest);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect.poll(() => [
    groupedApi + "/" + match.ledger_entry_id,
    "/api/admin/v1/reconciliation/matches/" + match.payment_match_id,
    ...group.sources.filter(source => source.direction === "CREDIT").map(source => "/api/admin/v1/reconciliation/ledger-entries/" + source.ledger_entry_id + "/candidates"),
  ].every(path => refreshed.includes(path))).toBe(true);
  page.off("request", refreshedRequest);
  const sitePath = manifest.details.matchSite!;
  const siteMatch = await matchDetail(page, manifest.origin, sitePath);
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.includes("/reconciliation/matches/")) requests.push(url.pathname);
  });
  await page.goto(manifest.origin + "/admin" + sitePath);
  await expect(page).toHaveURL(manifest.origin + "/admin" + sitePath);
  await expect(page.locator("[data-match-summary]")).toContainText(siteMatch.order.product_name);
  expect(requests).toContain("/api/admin/v1" + sitePath);
  expect(requests).not.toContain("/api/admin/v1/reconciliation/matches/" + siteMatch.payment_match_id);
  await record(page, info, { feature: "legacy-global-and-scoped-detail", sitePath, siteRequests: requests, refreshed });
});

test("source anchors preserve the originating page while rapid site memory changes retain the user scroll", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/reconciliation?association_status=%4dATCHED&sort_by=amount_cents&sort_order=desc");
  await expect(rows(page)).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "列表分页", exact: true })).toContainText("第 2 页");
  await page.goto(page.url().replace("association_status=MATCHED", "association_status=%4dATCHED"));
  await expect(rows(page)).toHaveCount(20);
  const original = new URL(page.url());
  const originalFirst = await rows(page).first().locator("a[data-row-link]").getAttribute("href");
  const selected = rows(page).nth(12).locator("a[data-row-link]");
  const href = await selected.getAttribute("href");
  const sourceId = href!.split("/").at(-1)!.split(/[?#]/)[0]!;
  const entry = await ledgerDetail(page, manifest.origin, sourceId);
  const current = entry.matches.find(match => match.status === "SETTLED")!;
  expect(current).toBeDefined();
  await selected.focus();
  await page.clock.runFor(100);
  const originalScroll = await page.evaluate(() => scrollY);
  expect(originalScroll).toBeGreaterThan(0);
  await selected.press("Enter");
  const matchCard = page.locator('[data-ledger-match="' + current.payment_match_id + '"]');
  await matchCard.getByRole("link", { name: "核对这份记录", exact: true }).click();
  const sourceCard = page.locator('[data-ledger-source="' + current.ledger_entry_id + '"]');
  await expect.poll(() => new URL(page.url()).hash).toBe("#source-" + current.ledger_entry_id);
  await expect(sourceCard).toBeFocused();
  const back = page.locator("#main-content").getByRole("link", { name: /返回.*对账|^对账$/ }).first();
  await expect(back).toHaveAttribute("href", original.pathname + original.search);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await page.clock.runFor(100);
  const userScroll = await page.evaluate(() => scrollY);
  const sites = (await (await page.request.get(manifest.origin + "/api/admin/v1/sites")).json()).data as Array<{ client_id: string; configuration: { name: string } }>;
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(groupedApi) || /\/reconciliation\/(?:matches|ledger-entries)\//.test(url.pathname)) requests.push(url.pathname);
  });
  await page.getByRole("button", { name: "切换导航", exact: true }).click();
  await expect(page.locator('[data-slot="sidebar"][data-collapsible="icon"]')).toBeVisible();
  await page.clock.runFor(200);
  await expect.poll(() => page.evaluate(expected => Math.abs(scrollY - expected) < 5, userScroll)).toBe(true);
  for (const site of [sites[0]!, sites[1]!, sites[0]!]) {
    await page.getByRole("button", { name: /切换业务网站/ }).click();
    const picker = page.getByRole("dialog", { name: "业务网站", exact: true });
    await expect(picker).toBeVisible();
    await page.clock.runFor(150);
    const option = picker.getByRole("link", { name: site.configuration.name, exact: true });
    await expect(option).toBeInViewport({ ratio: 1 });
    const box = await option.boundingBox();
    expect(box).toBeTruthy();
    // Click the visible choice without CDP scrolling its fixed popover's document.
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect.poll(() => new URL(page.url()).searchParams.get("selected_site")).toBe(site.client_id);
    await expect(picker).not.toBeVisible();
    await page.clock.runFor(150);
    await expect.poll(() => page.evaluate(expected => Math.abs(scrollY - expected) < 5, userScroll)).toBe(true);
    expect(new URL(page.url()).hash).toBe("#source-" + current.ledger_entry_id);
  }
  expect(requests).toEqual([]);
  const backHref = new URL((await back.getAttribute("href"))!, manifest.origin);
  expect(backHref.searchParams.get("cursor")).toBe(original.searchParams.get("cursor"));
  expect(backHref.searchParams.get("page")).toBe("2");
  expect(backHref.searchParams.get("selected_site")).toBe(sites[0]!.client_id);
  expect(backHref.search).toContain("association_status=%4dATCHED");
  await back.click();
  await expect(page).toHaveURL(backHref.href);
  await expect(rows(page).first().locator("a[data-row-link]")).toHaveAttribute("href", originalFirst! + "?selected_site=" + sites[0]!.client_id);
  await expect.poll(() => page.evaluate(expected => Math.abs(scrollY - expected) < 5, originalScroll)).toBe(true);
  await record(page, info, { feature: "source-anchor-and-site-memory", original: original.href, back: backHref.href, originalScroll, userScroll, requests });
});

test("merged financial actions keep the chosen source and match identity without changing the read-only fixture", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, manifest);
  const id = manifest.details.ledgerIdentical!.split("/").at(-1)!;
  const before = await ledgerDetail(page, manifest.origin, id);
  const source = before.sources.find(entry => entry.ledger_entry_id !== before.ledger_entry_id && entry.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(entry.state));
  expect(source).toBeDefined();
  const blocked: Array<{ path: string; body: Record<string, unknown> }> = [];
  // Only this disposable random-port fixture is used. Intercept every financial
  // POST before it reaches the server; the demo database stays read-only.
  await page.route("**/api/admin/v1/reconciliation/**", async route => {
    if (route.request().method() !== "POST") return route.continue();
    blocked.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() as Record<string, unknown> });
    await route.fulfill({ status: 403, json: { error: { code: "demo_read_only", message: "只读验收：财务请求已截获，未发送。" } } });
  });
  const evidenceReads: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/reconciliation/ledger-entries/" + source!.ledger_entry_id)) evidenceReads.push(url.pathname);
  });
  await page.goto(manifest.origin + "/admin" + detailPath(before.ledger_entry_id));
  const sourceCard = page.locator('[data-ledger-source="' + source!.ledger_entry_id + '"]');
  const associate = sourceCard.getByRole("button", { name: "人工关联收款", exact: true });
  await associate.click();
  const financial = page.getByRole("dialog", { name: "人工关联收款", exact: true });
  await financial.getByRole("button", { name: "取消", exact: true }).click();
  await expect(financial).not.toBeVisible();
  await expect(associate).toBeFocused();
  await associate.click();
  await financial.getByRole("button", { name: "全部可关联", exact: true }).click();
  const choose = financial.getByRole("button", { name: /^选择订单：/ }).first();
  await expect(choose).toBeVisible();
  await choose.click();
  await expect(financial.getByRole("button", { name: "确认关联收款", exact: true })).toBeEnabled();
  expect(evidenceReads).toEqual(["/api/admin/v1/reconciliation/ledger-entries/" + source!.ledger_entry_id]);
  await financial.getByLabel("操作理由（可选）", { exact: true }).fill("仅校验原始来源身份，不执行账务变更。");
  // Permit the client to form a request only after the route above guarantees
  // that every financial POST receives the synthetic 403 response.
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  await financial.getByRole("button", { name: "确认关联收款", exact: true }).click();
  await expect(financial.getByRole("button", { name: "响应详情", exact: true })).toBeVisible();
  await financial.getByRole("button", { name: "响应详情", exact: true }).click();
  await expect(financial).toContainText("只读验收：财务请求已截获，未发送。");
  expect(blocked).toHaveLength(1);
  expect(blocked[0]!.path).toBe("/api/admin/v1/reconciliation/settlements/manual");
  expect(blocked[0]!.body.ledger_entry_id).toBe(source!.ledger_entry_id);
  expect(blocked[0]!.body.ledger_entry_id).not.toBe(before.ledger_entry_id);
  expect(blocked[0]!.body.order_id).toEqual(expect.any(String));
  expect(blocked[0]!.body.financial_operation_id).toEqual(expect.any(String));
  const selectedOrderResponse = await page.request.get(manifest.origin + "/api/admin/v1/orders/" + String(blocked[0]!.body.order_id));
  expect(selectedOrderResponse.status()).toBe(200);
  const selectedOrder = (await selectedOrderResponse.json()).data as { product_name: string; payment: { status: string } };
  await expect(financial).toContainText(selectedOrder.product_name);
  expect(selectedOrder.payment.status).toBe("UNPAID");
  await financial.getByRole("button", { name: "关闭并刷新", exact: true }).click();
  await expect(financial).not.toBeVisible();
  await expectRecoveryFocus(associate);
  const unchanged = await ledgerDetail(page, manifest.origin, id);
  expect(unchanged.matches).toEqual(before.matches);
  expect(unchanged.sources).toEqual(before.sources);

  const match = await matchDetail(page, manifest.origin, manifest.details.matchManual!);
  await page.goto(manifest.origin + "/admin" + detailPath(match.ledger_entry_id));
  const matchCard = page.locator('[data-ledger-match="' + match.payment_match_id + '"]');
  const tools = matchCard.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true });
  await tools.click();
  await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
  const reversal = page.getByRole("dialog", { name: "撤销收款关联？", exact: true });
  await expect(reversal).toContainText(match.order.product_name);
  await expect(reversal).toContainText(match.order.merchant_order_no);
  await reversal.getByRole("button", { name: "取消", exact: true }).click();
  await expect(reversal).not.toBeVisible();
  await expect(tools).toBeFocused();
  await tools.click();
  await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
  await reversal.getByLabel("操作理由", { exact: true }).fill("只校验关联身份，不实际撤销。");
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  await reversal.getByRole("button", { name: "确认撤销关联", exact: true }).click();
  await expect(reversal.getByRole("button", { name: "响应详情", exact: true })).toBeVisible();
  await reversal.getByRole("button", { name: "响应详情", exact: true }).click();
  await expect(reversal).toContainText("只读验收：财务请求已截获，未发送。");
  expect(blocked).toHaveLength(2);
  expect(blocked[1]!.path).toBe("/api/admin/v1/reconciliation/matches/" + match.payment_match_id + "/actions/reverse");
  expect(blocked[1]!.body.financial_operation_id).toEqual(expect.any(String));
  await reversal.getByRole("button", { name: "关闭并刷新", exact: true }).click();
  await expect(reversal).not.toBeVisible();
  await expectRecoveryFocus(tools);
  const stillSettled = await matchDetail(page, manifest.origin, manifest.details.matchManual!);
  expect(stillSettled.status).toBe("SETTLED");
  expect(stillSettled.resolution_operation).toEqual(match.resolution_operation);
  expect(stillSettled.resolved_at).toBe(match.resolved_at);
  await record(page, info, { feature: "financial-source-and-match-identities", evidence: "synthetic-403-route-interception-no-server-writes", groupedAnchor: before.ledger_entry_id, actualSource: source!.ledger_entry_id, blocked, evidenceReads });
});
