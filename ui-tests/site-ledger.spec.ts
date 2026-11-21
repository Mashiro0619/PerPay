import type { Page } from "@playwright/test";
import type { AdminOrderDetail, FinancialException, MatchCandidate, PaymentMatchDetail, ReconciliationLedgerEntry } from "../web/src/api/generated/types.gen";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import { closeTechnicalDialog, detailSection, expectDetailRecordLayout, expectTechnicalDialogLayout, openTechnicalDialog, revealDetailSection } from "./detail-layout";

// A website's own view of one Alipay transaction. It is reached from that website's match or exception,
// reads only the website's API, and leaves choosing an order for a bare transaction to the console for all websites.
const layouts = [
  { width: 1440, height: 900, text: 100, theme: "light" },
  { width: 390, height: 844, text: 100, theme: "dark" },
  { width: 320, height: 560, text: 200, theme: "light" },
] as const;
const scenarios = [
  // Settled by amount: the transaction is allocated and names the order it was matched to.
  { key: "matchSite", state: "ALLOCATED", stateLabel: "已分配" },
  // Paid after the order was closed: nothing is allocated and no order is suggested.
  { key: "exceptionSite", state: "UNALLOCATED", stateLabel: "未分配" },
] as const;

const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 });
const count = (title: string, value: number) => new RegExp("^" + title + "\\s*，共\\s*" + value + "\\s*项$");

async function read<T>(page: Page, manifest: Manifest, path: string): Promise<T> {
  const response = await page.request.get(manifest.origin + path);
  expect(response.status(), path).toBe(200);
  return (await response.json() as { data: T }).data;
}
function overlayTarget(manifest: Manifest, href: string | null) {
  const target = new URL(href!, manifest.origin).searchParams.get("overlay");
  expect(target, "record links keep an explicit overlay resource").toBeTruthy();
  return new URL(target!, manifest.origin);
}

for (const layout of layouts) for (const scenario of scenarios) {
  test(`${layout.width}x${layout.height}, ${layout.text}% ${layout.theme}: a website reads its ${scenario.state.toLowerCase()} transaction as one record`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
    await page.addInitScript(theme => localStorage.setItem("perpay:theme", theme), layout.theme);
    await login(page, manifest);

    const sourcePath = manifest.details[scenario.key]!;
    const site = sourcePath.split("/")[2]!;
    const scope = "/api/admin/v1/sites/" + site;
    const source = await read<PaymentMatchDetail | FinancialException>(page, manifest, "/api/admin/v1" + sourcePath);
    const ledgerId = source.ledger_entry_id!;
    expect(ledgerId, "the named record refers to a transaction").toBeTruthy();
    const entry = await read<ReconciliationLedgerEntry>(page, manifest, scope + "/reconciliation/ledger-entries/" + ledgerId);
    const candidates = await read<MatchCandidate[]>(page, manifest, scope + "/reconciliation/ledger-entries/" + ledgerId + "/candidates");
    expect(entry.direction).toBe("CREDIT");
    expect(entry.state, "the named local fixture keeps its bookkeeping state").toBe(scenario.state);
    expect(candidates.length > 0, "only the allocated fixture has a matched order").toBe(scenario.state === "ALLOCATED");

    const reads: string[] = [], writes: string[] = [], errors: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return;
      if (request.method() === "GET") reads.push(url.pathname);
      else writes.push(request.method() + " " + url.pathname);
    });
    page.on("pageerror", error => errors.push(error.message));

    // The transaction is opened from the record that refers to it and stays inside the same drawer.
    await page.goto(manifest.origin + "/admin" + sourcePath);
    const overlay = await settleOverlay(page);
    const recordPath = "/sites/" + site + "/reconciliation/ledger/" + ledgerId;
    const link = (await revealDetailSection(page, "ledger")).getByRole("link", { name: "查看流水", exact: true });
    expect(overlayTarget(manifest, await link.getAttribute("href")).pathname).toBe(recordPath);
    await link.click();
    await expectOverlayTarget(page, recordPath);
    await settleOverlay(page);
    await expect(detailSection(page, "transaction")).toBeVisible();
    await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", layout.text);
    await page.evaluate(() => document.fonts.ready);
    await page.clock.runFor(100);

    await expect(overlay.getByRole("heading", { level: 1 })).toHaveText("支付宝收款 · " + entry.other_account);
    await expect(overlay.locator("[data-overlay-eyebrow-text]")).toHaveText("对账详情");
    await expect(overlay.getByRole("button", { name: "返回上一步", exact: true })).toBeVisible();
    // The summary carries the amount, the direction, the bookkeeping state, the time and the receiving account.
    const summary = overlay.getByRole("group", { name: "流水概况", exact: true });
    await expect(summary.locator("[data-record-summary-value]")).toHaveText("+" + currency.format(entry.amount_cents / 100));
    await expect(summary.getByText("收入", { exact: true })).toBeVisible();
    await expect(summary.getByText(scenario.stateLabel, { exact: true })).toBeVisible();
    await expect(summary.locator("[data-record-summary-meta]")).toContainText(entry.alipay_account_name!);

    const candidateTitle = candidates.length ? count("可能匹配的订单", candidates.length) : /^可能匹配的订单$/;
    expect(await overlay.locator("[data-detail-section]").evaluateAll(sections => sections.map(section => section.getAttribute("data-detail-section")))).toEqual(["transaction", "candidates", "record"]);
    await expect(overlay.locator("[data-overlay-detail]").getByRole("heading", { level: 2 })).toHaveText([/^交易信息$/, candidateTitle, /^PerPay 记录$/]);
    // A drawer too short for a fixed summary has no section navigation.
    const navigation = overlay.getByRole("navigation", { name: "分区导航", exact: true });
    if (await navigation.isVisible()) await expect(navigation.getByRole("button")).toHaveText([/^交易信息$/, candidateTitle, /^PerPay 记录$/]);

    // Alipay's facts stand alone: the website's and PerPay's own numbers are not among them.
    const transaction = await revealDetailSection(page, "transaction");
    await expect(transaction.locator("dt")).toHaveText(["交易对方", ...(entry.memo ? ["支付宝备注"] : []), "支付宝流水号", "支付宝订单号",
      ...(entry.merchant_order_no ? ["支付宝商户单号"] : [])]);
    await expect(transaction.getByText(entry.external_event_id, { exact: true })).toBeVisible();
    await expect(transaction.getByRole("button", { name: "复制支付宝流水号", exact: true })).toBeVisible();
    await expect(transaction.locator("dt").filter({ hasText: /^商户订单号|内部流水编号/ })).toHaveCount(0);

    const suggestions = await revealDetailSection(page, "candidates");
    await expect(suggestions.locator("article[data-sub-record]")).toHaveCount(candidates.length);
    if (!candidates.length) {
      // Nothing to suggest takes one line, not an empty block.
      await expect(suggestions).toHaveAttribute("data-section-empty", "true");
      await expect(suggestions).toContainText("暂无可能匹配的订单。");
    }
    for (const candidate of candidates) {
      const order = await read<AdminOrderDetail>(page, manifest, scope + "/orders/" + candidate.order_id);
      const card = suggestions.locator('article[id="candidate-' + candidate.candidate_id + '"]');
      await expect(card.getByRole("heading", { level: 3 })).toHaveText(order.product_name);
      await expect(card.getByText(order.merchant_order_no, { exact: true })).toBeVisible();
      await expect(card.locator("dt").first()).toHaveText("商户订单号");
      // Its order and its own record both open inside the same website.
      expect(overlayTarget(manifest, await card.getByRole("link", { name: "查看订单", exact: true }).getAttribute("href")).pathname).toBe("/sites/" + site + "/orders/" + candidate.order_id);
      expect(overlayTarget(manifest, await card.getByRole("link", { name: "查看匹配详情", exact: true }).getAttribute("href")).pathname).toBe("/sites/" + site + "/reconciliation/candidates/" + candidate.candidate_id);
    }

    const stored = await revealDetailSection(page, "record");
    await expect(stored.locator("dt")).toHaveText(["内部流水编号", "保存时间"]);
    await expect(stored.getByText(entry.ledger_entry_id, { exact: true })).toBeVisible();
    await expect(stored.getByRole("button", { name: "复制内部流水编号", exact: true })).toBeVisible();

    // Everything on this record was read through the website's own API.
    const ledgerReads = reads.filter(path => /\/ledger[-/]entries\//.test(path));
    expect(ledgerReads).toContain(scope + "/reconciliation/ledger-entries/" + ledgerId);
    expect(ledgerReads).toContain(scope + "/reconciliation/ledger-entries/" + ledgerId + "/candidates");
    expect(ledgerReads.filter(path => !path.startsWith(scope + "/")), "a website's record never reads the transaction for all websites").toEqual([]);

    const measured = await expectDetailRecordLayout(page);
    const id = `${scenario.key}-${layout.width}-${layout.text}-${layout.theme}`;
    await screenshot(page, info, "site-ledger-" + id);
    await audit(page, info, "site-ledger-" + id);

    // The footer holds the record's raw data, and nothing here associates a payment by itself.
    const footer = overlay.locator("[data-overlay-footer]");
    await expect(overlay.getByRole("button", { name: /关联/ })).toHaveCount(0);
    const session = await openTechnicalDialog(page, footer.locator('button[aria-label="更多操作，流水记录操作"]'), "流水技术信息");
    await expect(session.body.getByRole("button", { name: "复制内部流水编号", exact: true })).toBeVisible();
    await expect(session.body.getByRole("button", { name: "复制支付宝流水号", exact: true })).toBeVisible();
    const technical = await expectTechnicalDialogLayout(session);
    await closeTechnicalDialog(session);

    const handOff = footer.getByRole("link", { name: "到全部网站处理这笔流水", exact: true });
    if (scenario.state === "ALLOCATED") {
      // An allocated transaction has nothing left to hand over; the way back is the record it was opened from.
      await expect(footer.getByRole("link")).toHaveCount(0);
      await overlay.getByRole("button", { name: "返回上一步", exact: true }).click();
      await expectOverlayTarget(page, sourcePath);
    } else {
      // A website cannot choose the order for a bare transaction, so it leads to the record for all websites.
      const globalPath = "/reconciliation/transactions/" + ledgerId;
      expect(overlayTarget(manifest, await handOff.getAttribute("href")).pathname).toBe(globalPath);
      await handOff.click();
      await expect.poll(() => overlayTarget(manifest, page.url()).pathname).toBe(globalPath);
      await settleOverlay(page);
      await expect(overlay.locator("[data-overlay-eyebrow-text]")).toHaveText("流水与对账详情");
      await expect(overlay.getByRole("heading", { level: 1 })).toHaveText("支付宝收款 · " + entry.other_account);
      await expect(overlay.locator("[data-overlay-footer]").getByRole("button", { name: "人工关联收款", exact: true })).toBeVisible();
      await overlay.getByRole("button", { name: "返回上一步", exact: true }).click();
      await expectOverlayTarget(page, recordPath);
      await expect(overlay.locator("[data-overlay-footer]").getByRole("link", { name: "到全部网站处理这笔流水", exact: true })).toBeVisible();
    }
    await record(page, info, { feature: "site-ledger-record", scenario: scenario.key, layout, evidence: "named local domain records",
      candidates: candidates.length, measured, technical });
    expect(writes, "reading a transaction and following its links never submits a business action").toEqual([]);
    expect(errors).toEqual([]);
  });
}
