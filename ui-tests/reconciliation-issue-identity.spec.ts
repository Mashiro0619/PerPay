import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { money } from "../web/src/lib/format";
import type { FinancialException, LedgerConflictPageEnvelope } from "../web/src/api/generated/types.gen";

async function readException(page: Page, manifest: Manifest, key: string) {
  const response = await page.request.get(manifest.origin + "/api/admin/v1" + manifest.details[key]);
  expect(response.status()).toBe(200);
  return (await response.json() as { data: FinancialException }).data;
}

async function appearance(page: Page, hiddenOrder: boolean) {
  await page.evaluate(hiddenOrder => {
    localStorage.setItem("perpay:content-width", "full");
    localStorage.setItem("perpay.table-columns.v2.reconciliation-exceptions", JSON.stringify(hiddenOrder ? { order: false } : {}));
  }, hiddenOrder);
}

test("one order's different incoming payments keep distinct list identities and working order targets", async ({ page, manifest }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const originals = await Promise.all(["exceptionIgnored", "exceptionOpen"].map(key => readException(page, manifest, key)));
  const order = originals[0]!.context!.order_summary!;
  expect(order).toBeTruthy();
  const items = originals.map((original, index) => {
    const ledger = original.context!.ledger_entry_summary!;
    expect(ledger).toBeTruthy();
    return {
      ...structuredClone(original),
      exception_type: "AMOUNT_MISMATCH" as const,
      reminder_ignored: false,
      status: "OPEN" as const,
      created_at: new Date(manifest.epoch).toISOString(),
      order_id: order.order_id,
      context: {
        order_summary: order,
        ledger_entry_summary: { ...ledger, amount_cents: 1_002 + index },
        raw_event_summary: null,
      },
    } satisfies FinancialException;
  });
  expect(items[0]!.context.ledger_entry_summary.external_event_id).not.toBe(items[1]!.context.ledger_entry_summary.external_event_id);
  // Only the list response is synthetic; both order and source targets exist in
  // the isolated fixture. No financial write is issued by this regression test.
  await page.route(url => url.pathname === "/api/admin/v1/reconciliation/exceptions", route => route.fulfill({ status: 200, json: { data: items, page: { next_cursor: null } } }));
  const listUrl = manifest.origin + "/admin/reconciliation?tab=exceptions";
  for (const scenario of [{ width: 1600, hiddenOrder: false }, { width: 1600, hiddenOrder: true }, { width: 390, hiddenOrder: false }, { width: 320, hiddenOrder: false }]) {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await appearance(page, scenario.hiddenOrder);
    await page.goto(listUrl);
    const rows = page.locator("[data-business-row]");
    await expect(rows).toHaveCount(2);
    if (scenario.hiddenOrder) {
      // Explicit choices suppress the associated column and its fallback.
      // Restore it through the UI before exercising the independent targets.
      await expect(page.getByRole("columnheader", { name: "关联记录", exact: true })).toHaveCount(0);
      await expect(rows.getByRole("link", { name: /^查看订单：/ })).toHaveCount(0);
      await expect(rows.getByRole("link", { name: /^查看流水：/ })).toHaveCount(0);
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("perpay.table-columns.v2.reconciliation-exceptions") ?? "{}").order)).toBe(false);
      await page.getByRole("button", { name: "显示列", exact: true }).click();
      const relatedColumn = page.getByRole("menuitemcheckbox", { name: "关联记录", exact: true });
      await expect(relatedColumn).toHaveAttribute("aria-checked", "false");
      await relatedColumn.click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("columnheader", { name: "关联记录", exact: true })).toBeVisible();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("perpay.table-columns.v2.reconciliation-exceptions") ?? "{}").order)).toBe(true);
    }
    for (const item of items) {
      const row = page.locator('[data-business-row="' + item.exception_id + '"]');
      await expect(row).toContainText(money(item.context.ledger_entry_summary.amount_cents));
      await expect(row).toContainText(item.context.ledger_entry_summary.external_event_id);
      const orderLink = row.locator('a[href="/admin/orders/' + order.order_id + '"]');
      await expect(orderLink).toBeVisible();
      await expect(row.locator("a a")).toHaveCount(0);
      const primary = row.locator("a[data-row-link]");
      await expect(primary).toHaveAttribute("href", "/admin/reconciliation/exceptions/" + item.exception_id);
      const targets = await row.locator("a").evaluateAll(links => links.map(link => {
        const rect = link.getBoundingClientRect();
        return { href: link.getAttribute("href"), width: rect.width, height: rect.height };
      }));
      expect(targets.every(target => target.width > 0 && target.height > 0)).toBe(true);
    }
    expect(await rows.nth(0).innerText()).not.toBe(await rows.nth(1).innerText());
    await record(page, info, { feature: "same-order-payment-identities", ...scenario, evidence: "synthetic-list-response-with-existing-fixture-targets" });
    await screenshot(page, info, "same-order-" + scenario.width + (scenario.hiddenOrder ? "-hidden-order" : ""));
    if (scenario.width === 390) await audit(page, info, "same-order-list");

    const orderLink = rows.first().locator('a[href="/admin/orders/' + order.order_id + '"]');
    await orderLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + order.order_id);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(order.product_name);
    await expect(page.locator('[data-order-card="amount"]')).toBeVisible();
    await page.goto(listUrl);
    const ledger = items[0]!.context.ledger_entry_summary;
    await rows.first().getByRole("link", { name: /查看流水：/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(manifest.origin + "/admin/reconciliation/transactions/" + ledger.ledger_entry_id + "#source-" + ledger.ledger_entry_id);
    await expect(page.getByRole("heading", { name: "支付宝交易", exact: true })).toBeVisible();
    await page.goto(listUrl);
    await rows.first().locator("a[data-row-link]").click();
    await expect(page).toHaveURL(manifest.origin + "/admin/reconciliation/exceptions/" + items[0]!.exception_id);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("账务异常详情");
  }

  for (const [index, item] of items.entries()) {
    item.context.ledger_entry_summary.amount_cents = 999_999_999_999;
    item.context.ledger_entry_summary.external_event_id = "same-payment-prefix-".repeat(12) + (index ? "beta" : "alpha");
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(listUrl);
  for (const item of items) {
    const row = page.locator('[data-business-row="' + item.exception_id + '"]');
    await expect(row).toContainText(money(item.context.ledger_entry_summary.amount_cents));
    await expect(row).toContainText(item.context.ledger_entry_summary.external_event_id);
  }
  await record(page, info, { feature: "payment-list-amount-and-reference-limits", width: 320, evidence: "synthetic-list-response-only" });
  await screenshot(page, info, "same-order-reference-and-amount-limits");
  expect(errors).toEqual([]);
});

test("default conflict summaries preserve transfer numbers and invalid calendar evidence", async ({ page, manifest }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page, manifest);
  const response = await page.request.get(manifest.origin + "/api/admin/v1/ledger/conflicts?status=ALL&limit=200");
  expect(response.status()).toBe(200);
  const original = await response.json() as LedgerConflictPageEnvelope;
  const rawConflicts = original.data.filter(item => item.context?.raw_event_summary).slice(0, 2);
  expect(rawConflicts).toHaveLength(2);
  const invalidTime = "2026-02-30T10:00:00Z";
  const items = rawConflicts.map((item, index) => ({
    ...item,
    conflict_type: "INVALID_TIMESTAMP" as const,
    external_event_id: "review-transfer-" + (index ? "beta" : "alpha"),
    created_at: new Date(manifest.epoch).toISOString(),
    status: "OPEN" as const,
    reminder_ignored: false,
    context: {
      order_summary: null,
      ledger_entry_summary: null,
      raw_event_summary: {
        ...item.context!.raw_event_summary!,
        external_event_id: "review-transfer-" + (index ? "beta" : "alpha"),
        occurred_at_text: invalidTime,
        amount_text: "12.34",
        direction_text: "CREDIT",
        other_account: "同一付款人",
        memo: "同一备注",
      },
    },
  }));
  await page.route(url => url.pathname === "/api/admin/v1/ledger/conflicts", route => route.fulfill({ status: 200, json: { data: items, page: { next_cursor: null } } }));
  for (const width of [1600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => localStorage.setItem("perpay:content-width", "full"));
    await page.goto(manifest.origin + "/admin/reconciliation?tab=conflicts");
    const rows = page.locator("[data-business-row]");
    await expect(rows).toHaveCount(2);
    for (const item of items) {
      const row = page.locator('[data-business-row="' + item.conflict_id + '"]');
      await expect(row).toContainText(item.external_event_id);
      await expect(row).toContainText(invalidTime);
      await expect(row).toContainText("同一付款人");
      await expect(row).not.toContainText("2026/03/02");
    }
    expect(await rows.nth(0).innerText()).not.toBe(await rows.nth(1).innerText());
    await record(page, info, { feature: "conflict-raw-evidence-identities", width, evidence: "synthetic-conflict-list-response-only" });
    await screenshot(page, info, "conflict-identities-" + width);
    if (width === 390) await audit(page, info, "conflict-list-identities");
  }
});
