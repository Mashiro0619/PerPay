import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import type { AdminLedgerDetail, AdminLedgerPageEnvelope, PaymentMatchDetail } from "../web/src/api/generated/types.gen";

const transactions = "/reconciliation";
const transactionDetail = (id: string) => "/reconciliation/transactions/" + id;

test("ledger pagination and keyboard links restore filters, page and scroll position", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin" + transactions + "?direction=CREDIT");
  const rows = page.locator("[data-business-row]");
  await expect(rows).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  await expect(rows).toHaveCount(20);
  // Shared links may use equivalent percent encodings that must survive returns.
  const sharedListUrl = page.url().replace("direction=CREDIT", "direction=%43REDIT");
  await page.goto(sharedListUrl);
  await expect(rows).toHaveCount(20);
  const listUrl = page.url();
  expect(listUrl).toBe(sharedListUrl);
  const identity = await rows.first().locator("a[data-row-link]").getAttribute("href");
  const recordLink = rows.nth(12).locator("a[data-row-link]");
  await recordLink.focus();
  await page.clock.runFor(100);
  const scroll = await page.evaluate(() => scrollY);
  expect(scroll).toBeGreaterThan(0);
  const detailHref = await recordLink.getAttribute("href");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + detailHref);
  await expect(page.locator("#ledger-sources-heading")).toContainText("查账记录");
  await page.locator("#main-content").getByRole("link", { name: /返回.*(?:流水|对账)|^对账$/ }).first().click();
  await expect(page).toHaveURL(listUrl);
  await expect(rows.first().locator("a[data-row-link]")).toHaveAttribute("href", identity!);
  await expect.poll(() => page.evaluate(expected => Math.abs(scrollY - expected) < 5, scroll)).toBe(true);
  const order = rows.getByRole("link", { name: /^查看订单：/ }).first();
  await expect(order).toBeVisible();
  const orderHref = await order.getAttribute("href");
  await order.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(manifest.origin + orderHref);
  await page.locator("#main-content").getByRole("link", { name: /返回.*(?:流水|对账)|^对账$/ }).first().click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  await record(page, info);
});

test("ledger controls use transaction dates, exact amounts and reset pagination", async ({ page, manifest }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin" + transactions);
  const date = page.getByRole("combobox", { name: "交易日期范围" });
  await expect(date).toContainText("全部");
  await date.click();
  await page.getByRole("option", { name: "近 7 天", exact: true }).click();
  await expect(page).toHaveURL(/occurred_from=/);
  expect(new URL(page.url()).searchParams.has("created_from")).toBe(false);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/cursor=/);
  await page.getByRole("button", { name: "金额范围", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "金额范围", exact: true });
  await dialog.getByLabel("最低金额（元）").fill("0.001");
  await dialog.getByRole("button", { name: "应用金额", exact: true }).click();
  await expect(dialog).toContainText("最多保留两位小数");
  await dialog.getByLabel("最低金额（元）").fill("0");
  await dialog.getByLabel("最高金额（元）").fill("0");
  await dialog.getByRole("button", { name: "应用金额", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("[data-business-row]")).toHaveCount(0);
  const filtered = new URL(page.url()).searchParams;
  expect(filtered.get("min_amount_cents")).toBe("0");
  expect(filtered.get("max_amount_cents")).toBe("0");
  expect(filtered.has("cursor")).toBe(false);
  expect(filtered.has("page")).toBe(false);
});

test("switching websites keeps global ledger rows, cursor and requests stable", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin" + transactions + "?direction=CREDIT");
  await page.getByRole("button", { name: "切换导航", exact: true }).click();
  await expect(page.locator('[data-slot="sidebar"][data-collapsible="icon"]')).toBeVisible();
  await page.clock.runFor(250);
  await expect(page.locator("[data-business-row]")).toHaveCount(20);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "列表分页" })).toContainText("第 2 页");
  const cursor = new URL(page.url()).searchParams.get("cursor");
  const first = page.locator("[data-business-row]").first();
  await first.evaluate(element => { element.setAttribute("data-ledger-retained", "true"); });
  const ledgerRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/v1/ledger/entries") ledgerRequests.push(request.url());
  });
  const sites = (await (await page.request.get(manifest.origin + "/api/admin/v1/sites")).json()).data as Array<{ client_id: string; configuration: { name: string } }>;
  for (const site of [sites[0]!, sites[1]!, sites[0]!]) {
    await page.getByRole("button", { name: /切换业务网站/ }).click();
    await page.getByRole("dialog", { name: "业务网站", exact: true }).getByRole("link", { name: site.configuration.name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp("selected_site=" + site.client_id));
    await expect(first).toHaveAttribute("data-ledger-retained", "true");
    expect(new URL(page.url()).searchParams.get("cursor")).toBe(cursor);
    await page.clock.runFor(200);
  }
  expect(ledgerRequests).toEqual([]);
  await record(page, info, { ledgerRequests, navigationOnly: true });
});

test("unified transactions render both themes and width modes at 320, 390, 1440 and 2190 pixels", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const detailPaths = manifest.routes.filter(path => path.startsWith("/ledger/"));
  expect(detailPaths).toHaveLength(2);
  const versions = await Promise.all(detailPaths.map(async path => {
    const response = await page.request.get(manifest.origin + "/api/admin/v1" + path.replace("/ledger/", "/ledger/entries/"));
    expect(response.status()).toBe(200);
    return (await response.json()).data as AdminLedgerDetail;
  }));
  expect(versions.map(entry => entry.content_consistent)).toEqual([true, false]);
  const listResponse = await page.request.get(manifest.origin + "/api/admin/v1/ledger/entries");
  const list = await listResponse.json() as AdminLedgerPageEnvelope;
  expect(list.data).toHaveLength(20);
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"]) for (const mode of width < 1000 ? ["compact"] : ["compact", "full"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, { theme, mode });
    for (const path of [transactions, ...versions.map(entry => transactionDetail(entry.ledger_entry_id))]) {
      await page.goto(manifest.origin + "/admin" + path);
      if (path === transactions) await expect(page.locator("[data-business-row]")).toHaveCount(20);
      else await expect(page.locator("#ledger-sources-heading")).toContainText("查账记录");
      await record(page, info, { width, theme, mode, source: "local-synthetic-unified-transactions" });
      await screenshot(page, info, `transactions-${width}-${theme}-${mode}-${path.split("/").at(-1)}`);
      if (width === 320) await audit(page, info, `ledger-${theme}-${path.split("/").at(-1)}`);
    }
  }
  expect(errors).toEqual([]);
});

test("ledger tells the current order apart from reversed history without repeating an identical transaction", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const path = manifest.details.ledgerAssociated!;
  const apiPath = "/api/admin/v1" + path.replace("/ledger/", "/ledger/entries/");
  const response = await page.request.get(manifest.origin + apiPath);
  expect(response.status()).toBe(200);
  const entry = (await response.json() as { data: AdminLedgerDetail }).data;
  expect(entry.content_consistent).toBe(true);
  const current = entry.matches.find(match => match.status === "SETTLED");
  expect(current).toBeDefined();
  await page.goto(manifest.origin + "/admin" + transactionDetail(entry.ledger_entry_id));
  const summary = page.locator("[data-ledger-summary]");
  const currentCard = page.locator('[data-ledger-match="' + current!.payment_match_id + '"]');
  await expect(page.locator("#main-content").getByRole("heading", { name: "支付宝交易", exact: true })).toBeVisible();
  await expect(page.locator("#ledger-matches-heading")).toBeVisible();
  await expect(summary.getByText("已分配", { exact: true })).toHaveCount(0);
  await expect(summary.locator("dt").filter({ hasText: /商户订单号（业务网站）|内部流水编号/ })).toHaveCount(0);
  await expect(currentCard.getByText("已关联", { exact: true })).toBeVisible();
  await expect(currentCard.locator("dt").filter({ hasText: /^撤销时间$/ })).toHaveCount(0);
  await expect(page.locator("[data-ledger-source]").first().locator("dt").filter({ hasText: /^(内部流水编号（PerPay）|保存时间)$/ })).toHaveCount(2);
  await expect(page.locator("#ledger-conflicts-heading")).toHaveCount(0);
  await screenshot(page, info, "ledger-current-order-reading");

  const oldMatchResponse = await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details.matchReversed);
  expect(oldMatchResponse.status()).toBe(200);
  const oldMatch = (await oldMatchResponse.json() as { data: PaymentMatchDetail }).data;
  const reversedResponse = await page.request.get(manifest.origin + "/api/admin/v1/ledger/entries/" + oldMatch.ledger_entry_id);
  expect(reversedResponse.status()).toBe(200);
  const reversed = (await reversedResponse.json() as { data: AdminLedgerDetail }).data;
  expect(reversed.matches.some(match => match.payment_match_id === oldMatch.payment_match_id && match.status === "REVERSED")).toBe(true);
  await page.goto(manifest.origin + "/admin" + transactionDetail(reversed.ledger_entry_id));
  if (reversed.active_match_count === 0) {
    await expect(page.locator("[data-ledger-unmatched]")).toContainText("当前没有对应的收款订单");
    await expect(page.locator("[data-ledger-unmatched]")).toContainText("可在对应查账记录中人工关联。");
  }
  const reversedHistory = reversed.matches.filter(match => match.status === "REVERSED");
  await expect(page.getByRole("heading", { name: `已撤销的历史关联（${reversedHistory.length}）`, exact: true })).toBeVisible();
  await expect(page.locator("[data-ledger-match]")).toHaveCount(reversed.matches.length);
  for (const match of reversedHistory) {
    const card = page.locator('[data-ledger-match="' + match.payment_match_id + '"]');
    await expect(card.locator("dt").filter({ hasText: /^撤销时间$/ })).toBeVisible();
    await expect(card.getByText("已撤销", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: match.product_name, exact: true })).toHaveAttribute("href", "/admin/orders/" + match.order_id);
  }
  await record(page, info, { feature: "ledger-current-versus-history", evidence: "real-isolated-synthetic-current-and-reversed-records", activeMatchCount: reversed.active_match_count, historicalCount: reversedHistory.length });
  await screenshot(page, info, "ledger-reversed-order-reading");
});

test("closed ledger conflicts remain history while only open conflicts require action", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const path = manifest.details.ledgerAssociated!;
  const apiPath = "/api/admin/v1" + path.replace("/ledger/", "/ledger/entries/");
  const response = await page.request.get(manifest.origin + apiPath);
  expect(response.status()).toBe(200);
  const entry = structuredClone((await response.json() as { data: AdminLedgerDetail }).data);
  expect(entry.content_consistent).toBe(true);
  expect(entry.active_match_count).toBe(1);
  entry.states = ["CONFLICT"];
  entry.has_conflicts = true;
  entry.conflicts = [{
    conflict_id: "b0000000-0000-4000-8000-000000000004",
    conflict_type: "DUPLICATE_EXTERNAL_ID",
    status: "RESOLVED",
    existing_ledger_entry_id: entry.sources[0]!.ledger_entry_id,
    created_at: entry.created_at,
    resolved_at: new Date(manifest.epoch + 60_000).toISOString(),
  }];
  // Present known statuses through a synthetic read response; no financial write.
  await page.route(manifest.origin + apiPath, route => route.fulfill({ status: 200, json: { data: entry } }));
  for (const [status, visibleStatus] of [["RESOLVED", "已处理"], ["IGNORED", "已确认隔离"], ["OPEN", "待处理"]] as const) {
    entry.conflicts[0]!.status = status;
    entry.conflicts[0]!.resolved_at = status === "OPEN" ? null : new Date(manifest.epoch + 60_000).toISOString();
    await page.goto(manifest.origin + "/admin" + path);
    const conflict = page.locator("[data-ledger-conflict]");
    await expect(page.locator("#ledger-conflicts-heading")).toHaveText("账本冲突记录（1）");
    await expect(conflict.getByText(visibleStatus, { exact: true })).toBeVisible();
    await expect(conflict.getByRole("link", { name: "查看冲突记录", exact: true })).toHaveAttribute("href", "/admin/reconciliation/conflicts/" + entry.conflicts[0]!.conflict_id);
    if (status === "OPEN") await expect(page.locator("[data-ledger-warning]")).toContainText("有 1 条账本冲突待处理");
    else {
      await expect(page.locator("[data-ledger-warning]")).toHaveCount(0);
      await expect(page.locator("#main-content").getByText("待处理", { exact: true })).toHaveCount(0);
    }
    await expect(page.locator("[data-ledger-match]").getByText("已关联", { exact: true })).toBeVisible();
    await record(page, info, { feature: "ledger-conflict-reading-status", evidence: "synthetic-read-response-only", status, activeMatchCount: entry.active_match_count });
    await screenshot(page, info, "ledger-conflict-status-" + status.toLowerCase());
  }
});
