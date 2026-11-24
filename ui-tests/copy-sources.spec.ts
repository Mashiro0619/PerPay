import { revealDetailSection } from "./detail-layout";
import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { screenshot } from "./audit";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import type {
  AdminLedgerDetail,
  AdminOrderDetail,
  AdminWorkItemPageEnvelope,
  ErrorEnvelope,
  MatchCandidate,
  PaymentMatchDetail,
  PublicCheckoutEnvelope,
  WebhookDeliveryPageEnvelope,
} from "../web/src/api/generated/types.gen";

const widths = [390, 1440] as const;
const themes = ["light", "dark"] as const;
const automaticCheckoutCopy = "按支付宝流水的金额和付款时间推断，已确认这笔收款。";
const manualCheckoutCopy = "商家管理员已根据支付宝流水人工确认这笔收款。";

async function read<T>(page: Page, manifest: Manifest, path: string): Promise<T> {
  const response = await page.request.get(manifest.origin + path);
  expect(response.status(), path).toBe(200);
  return await response.json() as T;
}

async function data<T>(page: Page, manifest: Manifest, path: string): Promise<T> {
  return (await read<{ data: T }>(page, manifest, path)).data;
}

async function presentation(page: Page, width: number, theme: "light" | "dark") {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(theme => {
    localStorage.setItem("perpay:theme", theme);
    localStorage.setItem("perpay:content-width", "full");
  }, theme);
}

async function copyField(page: Page, scope: Locator, label: string, value: string, button = "复制" + label) {
  const field = scope.getByText(label, { exact: true }).locator("..");
  await expect(field.locator("dd").getByText(value, { exact: true })).toBeVisible();
  await field.getByRole("button", { name: button, exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
}

/** A nullable identifier: copyable when present. Otherwise its row says `absent`, or is left out where `absent` is null. */
async function optionalCopyField(page: Page, scope: Locator, label: string, value: string | null, absent: string | null) {
  if (value !== null) { await copyField(page, scope, label, value); return; }
  const field = scope.getByText(label, { exact: true }).locator("..");
  if (absent === null) { await expect(field).toHaveCount(0); return; }
  await expect(field.locator("dd")).toHaveText(absent);
  await expect(field.getByRole("button")).toHaveCount(0);
}

function observeWrites(page: Page, manifest: Manifest) {
  const writes: Array<{ method: string; path: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === manifest.origin && url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) {
      writes.push({ method: request.method(), path: url.pathname });
    }
  });
  return writes;
}

test("ledger credentials keep genuine Alipay, website and PerPay identities distinct and copyable", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  const writes = observeWrites(page, manifest);
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const inferred = await data<PaymentMatchDetail>(page, manifest, "/api/admin/v1" + manifest.details.matchInferred!);
  const manual = await data<PaymentMatchDetail>(page, manifest, "/api/admin/v1" + manifest.details.matchManual!);
  expect(inferred.evidence_type).toBe("AMOUNT_INFERRED");
  expect(manual.evidence_type).toBe("MANUAL");
  const cases = await Promise.all([
    { name: "inferred", path: "/ledger/" + inferred.ledger_entry_id },
    { name: "manual", path: "/ledger/" + manual.ledger_entry_id },
    { name: "duplicate-sources", path: manifest.details.ledgerIdentical! },
  ].map(async item => ({
    ...item,
    entry: await data<AdminLedgerDetail>(page, manifest, "/api/admin/v1" + item.path.replace("/ledger/", "/ledger/entries/")),
  })));
  expect(cases[2]!.entry.sources.length).toBeGreaterThan(1);

  for (const width of widths) for (const theme of themes) {
    await presentation(page, width, theme);
    for (const scenario of cases) {
      const entry = scenario.entry;
      await page.goto(manifest.origin + "/admin" + scenario.path);
      const overlay = await settleOverlay(page);
      expect(new URL(page.url()).searchParams.get("overlay")).toMatch(/\/(?:ledger|reconciliation\/transactions)\//);
      const several = entry.sources.length > 1;
      // Alipay's own numbers describe the transaction, each named after Alipay.
      const transaction = overlay.locator('[data-detail-section="transaction"]');
      await expect(transaction.locator("[data-record-fields]")).toBeVisible();
      await expect(overlay.getByText("PerPay 处理状态", { exact: true })).toHaveCount(0);
      await copyField(page, transaction, "支付宝流水号", entry.external_event_id);
      // A number the stored copies disagree about is disputed; one that none of them carries is not provided.
      const disputed = (fact: "provider_order_no" | "merchant_order_no") => entry[fact] === null && entry.sources.some(source => source[fact] !== null);
      await optionalCopyField(page, transaction, "支付宝订单号", entry.provider_order_no, disputed("provider_order_no") ? "有争议" : entry.content_consistent ? "未提供" : "—");
      await optionalCopyField(page, transaction, "支付宝商户单号", entry.merchant_order_no, disputed("merchant_order_no") ? "有争议" : null);
      const sources = await revealDetailSection(page, "sources");
      // A single stored copy is the record itself; several are told apart as records of their own.
      await expect(sources.locator('article[id^="source-"]')).toHaveCount(several ? entry.sources.length : 0);
      const eligible = entry.active_match_count ? [] : entry.sources.filter(source => source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state));
      const shared = eligible.length > 0 && (!several || entry.content_consistent);
      for (const source of entry.sources) {
        const card = several ? sources.locator('article[id="source-' + source.ledger_entry_id + '"]') : sources;
        await copyField(page, card, "内部流水编号", source.ledger_entry_id);
        // A copy states an Alipay number of its own only where the copies disagree about it.
        for (const [label, fact] of [["支付宝订单号", "provider_order_no"], ["支付宝商户单号", "merchant_order_no"]] as const) {
          if (entry[fact] === null && source[fact]) await copyField(page, card, label, source[fact]);
          else await expect(card.getByText(label, { exact: true })).toHaveCount(0);
        }
        if (entry.content_consistent) await expect(card.locator("dt")).toHaveText([...(several ? [] : ["PerPay 记录状态"]), "内部流水编号", "保存时间"]);
        await expect(card.getByRole("link", { name: "查看记录与处理", exact: true })).toHaveCount(0);
        // A copy is named only where there is a choice to make among several.
        await expect(card.getByRole("button", { name: "用这份记录关联", exact: true })).toHaveCount(several && (eligible.length > 1 || !shared) && eligible.includes(source) ? 1 : 0);
      }
      await expect(overlay.locator("[data-overlay-footer]").getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(shared ? 1 : 0);
      const payments = await revealDetailSection(page, "payments");
      const history = payments.getByRole("button", { name: /^已撤销的关联/ });
      if (await history.count() && await history.getAttribute("aria-expanded") === "false") await history.click();
      await expect(payments.locator('article[id^="match-"]')).toHaveCount(entry.matches.length);
      const tools = overlay.locator("[data-overlay-footer]").getByRole("button", { name: "更多操作，流水操作", exact: true });
      for (const [index, match] of entry.matches.entries()) {
        const card = payments.locator('article[id="match-' + match.payment_match_id + '"]');
        // How the association came about is said under the order's name.
        await expect(card.locator("header")).toContainText(match.evidence_type === "MANUAL" ? "管理员人工关联" : "PerPay 按金额和付款时间推断");
        // Inside the order's own record the website's number needs no qualifier: Alipay's numbers stay with the transaction.
        await copyField(page, card, "商户订单号", match.merchant_order_no);
        await expect(transaction.getByText("商户订单号", { exact: true })).toHaveCount(0);
        const orderHref = await card.getByRole("link", { name: "查看订单", exact: true }).getAttribute("href");
        expect(new URL(orderHref!, manifest.origin).searchParams.get("overlay")).toBe("/orders/" + match.order_id);
        // Only a transaction with several stored copies has to say which of them an association uses.
        const sourceLink = card.getByRole("link", { name: /^查账记录 \d+$/ });
        await expect(sourceLink).toHaveCount(several ? 1 : 0);
        if (several) {
          const sourceTarget = new URL((await sourceLink.getAttribute("href"))!, manifest.origin).searchParams.get("overlay")!;
          expect(new URL(sourceTarget, manifest.origin).hash).toBe("#source-" + match.ledger_entry_id);
          await sourceLink.click();
          await expect(sources.locator('article[id="source-' + match.ledger_entry_id + '"]')).toBeFocused();
          await revealDetailSection(page, "payments");
        }
        await expect(card.getByText("支付宝交易金额", { exact: true })).toHaveCount(0);
        // The identifier of the stored copy an association uses is technical information, opened from the record's menu.
        await tools.click();
        await page.getByRole("menuitem", { name: /^收款关联技术信息/ }).nth(index).click();
        const reader = page.getByRole("dialog", { name: "收款关联技术信息", exact: true });
        await reader.getByRole("button", { name: "复制内部流水编号", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(match.ledger_entry_id);
        await reader.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(tools).toHaveAttribute("aria-expanded", "false");
        await expect(tools).toBeFocused();
      }
      await record(page, info, { feature: "copy-source-ledger", evidence: "isolated-local-domain-api", width, theme, scenario: scenario.name, sources: entry.sources.length, matches: entry.matches.length });
      if (scenario.name === "inferred") await screenshot(page, info, "copy-source-ledger-" + width + "-" + theme);
      if (entry.active_match) {
        const active = entry.active_match;
        await payments.locator('article[id="match-' + active.payment_match_id + '"]').getByRole("link", { name: "查看订单", exact: true }).click();
        await expectOverlayTarget(page, "/orders/" + active.order_id);
        const websiteOrder = page.getByRole("region", { name: "订单信息", exact: true });
        await copyField(page, websiteOrder, "商户订单号", active.merchant_order_no);
      }
    }
  }
  expect(writes).toEqual([]);
});

test("overview and normal notifications label payable amounts and actual events while real invalid pagination stays readable", async ({ page, manifest }, info) => {
  const writes = observeWrites(page, manifest);
  await login(page, manifest);
  const response = await read<WebhookDeliveryPageEnvelope>(page, manifest, "/api/admin/v1/webhooks/deliveries?limit=20&sort_by=created_at&sort_order=desc");
  const notification = response.data.find(item => item.order_summary && item.event.event_type === "PAYMENT_CONFIRMED");
  expect(notification, "normal generated notification with its business order summary").toBeTruthy();
  const item = notification!;
  const order = item.order_summary!;
  const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2 });
  const amount = money.format(order.payable_amount_cents / 100);
  const reminders = await read<AdminWorkItemPageEnvelope>(page, manifest, "/api/admin/v1/work-items?limit=4&sort_by=priority&sort_order=desc");
  const reminder = reminders.data.find(item => item.order_summary);
  expect(reminder, "normal overview reminder with a genuine order summary").toBeTruthy();
  const invalidCursor = "invalid-copy-source-cursor";
  const errorMessage = "翻页信息无效或与当前筛选不符，请返回第一页重新查询";

  for (const width of widths) for (const theme of themes) {
    await presentation(page, width, theme);
    await page.goto(manifest.origin + "/admin/");
    const overview = page.getByRole("list", { name: "概览待处理", exact: true });
    const overviewRow = overview.locator('[data-business-row="' + reminder!.type + ":" + reminder!.resource_id + '"]');
    const payable = overviewRow.locator('[title="应付金额"]');
    await expect(payable.getByText("应付", { exact: true })).toBeVisible();
    await expect(payable.getByLabel("应付金额 " + money.format(reminder!.order_summary!.payable_amount_cents / 100), { exact: true })).toBeVisible();
    await record(page, info, { feature: "copy-source-overview-payable", evidence: "isolated-local-domain-api", width, theme, payableAmountCents: reminder!.order_summary!.payable_amount_cents });
    if (width === 390 && theme === "dark") await screenshot(page, info, "copy-source-overview-payable");
    await page.goto(manifest.origin + "/admin/notifications");
    const row = page.locator('[data-business-row="' + item.delivery_id + '"]');
    await expect(row.locator("a[data-row-link]")).toHaveText(order.product_name);
    await row.locator("a[data-row-link]").click();
    const notificationOverlay = await settleOverlay(page);
    // A notification is titled by the event it actually reports.
    await expect(notificationOverlay.getByRole("heading", { level: 1 })).toHaveText("收款已确认");
    await revealDetailSection(page, "order");
    const orderSummary = notificationOverlay.locator('[data-detail-section="order"] article[data-sub-record]');
    // No Alipay number sits beside it here, so the merchant's order number needs no qualifier.
    const merchantOrder = orderSummary.locator("dt").filter({ hasText: /^商户订单号$/ }).locator("..").locator("dd");
    await expect(merchantOrder.getByText(order.merchant_order_no, { exact: true })).toBeVisible();
    const detailPayable = orderSummary.locator("dt").filter({ hasText: /^应付金额$/ }).locator("..").locator("dd");
    await expect(detailPayable).toHaveText(amount);
    await expect(detailPayable).toBeVisible();
    await record(page, info, { feature: "copy-source-notification", evidence: "isolated-local-domain-api", width, theme, eventType: item.event.event_type, payableAmountCents: order.payable_amount_cents });
    await screenshot(page, info, "copy-source-notification-" + width + "-" + theme);

    // This is the browser's actual local GET and server error, without response replay.
    const failedRead = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === manifest.origin && url.pathname === "/api/admin/v1/ledger/entries" && url.searchParams.get("cursor") === invalidCursor;
    });
    await page.goto(manifest.origin + "/admin/ledger?cursor=" + invalidCursor + "&page=2");
    const failed = await failedRead;
    expect(failed.request().method()).toBe("GET");
    expect(failed.status()).toBe(422);
    const payload = await failed.json() as ErrorEnvelope;
    expect(payload.error.message).toBe(errorMessage);
    const error = page.locator("#main-content").getByRole("alert").filter({ hasText: errorMessage });
    await expect(error.getByText(errorMessage, { exact: true })).toBeVisible();
    await record(page, info, { feature: "copy-source-invalid-pagination", evidence: "actual-isolated-local-browser-get", width, theme, status: failed.status(), message: payload.error.message });
    if (width === 390 && theme === "dark") await screenshot(page, info, "copy-source-invalid-pagination");
    await page.goto(manifest.origin + "/admin/ledger");
    await expect(page.locator("[data-business-row]")).toHaveCount(20);
  }
  expect(writes).toEqual([]);
});

test("a genuine associated order summary keeps a contract-length synthetic merchant reference fully wrapped", async ({ page, manifest }, info) => {
  const writes = observeWrites(page, manifest);
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const candidatePath = manifest.routes.find(path => path.startsWith("/reconciliation/candidates/"));
  expect(candidatePath).toBeTruthy();
  const candidate = await data<MatchCandidate>(page, manifest, "/api/admin/v1" + candidatePath!);
  const orderApi = "/api/admin/v1/orders/" + candidate.order_id;
  const original = await data<AdminOrderDetail>(page, manifest, orderApi);
  const merchantOrderNo = "SYNTHETIC-WEBSITE-ORDER-".padEnd(64, "9");
  expect(merchantOrderNo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  // Only the displayed reference is synthetic; the record, related reads and links stay genuine.
  await page.route(manifest.origin + orderApi, route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ status: 200, json: { data: { ...original, merchant_order_no: merchantOrderNo } } });
  });
  try {
    for (const width of widths) for (const theme of themes) {
      await presentation(page, width, theme);
      await page.goto(manifest.origin + "/admin" + candidatePath!);
      const orderSummary = page.locator('[data-overlay-content] [data-detail-section="order"] article[data-sub-record]');
      await expect(orderSummary).toBeVisible();
      const merchantField = orderSummary.locator('dl > div').filter({ has: page.getByText("商户订单号", { exact: true }) });
      const reference = merchantField.locator("dd > div > span").first();
      await expect(reference).toContainText(merchantOrderNo);
      const created = orderSummary.locator('dl > div').filter({ has: page.getByText("创建时间", { exact: true }) });
      await expect(created.locator("time")).toHaveAttribute("datetime", original.created_at);
      const measured = await reference.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        const lines = new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top)));
        return { clamp: style.webkitLineClamp, whiteSpace: style.whiteSpace, height: bounds.height, textHeight: text.height,
          width: bounds.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, lines: lines.size };
      });
      expect(measured.clamp).toBe("none");
      expect(measured.whiteSpace).toBe("pre-wrap");
      expect(measured.textHeight).toBeLessThanOrEqual(measured.height + 1);
      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
      expect(measured.scrollHeight).toBeLessThanOrEqual(measured.clientHeight + 1);
      if (width === 390) expect(measured.lines).toBeGreaterThan(1);
      await record(page, info, { feature: "copy-source-default-order-reference", evidence: "synthetic-order-get-reference-only-within-64-character-contract", width, theme, measured });
      await screenshot(page, info, "copy-source-default-order-reference-" + width + "-" + theme);
      await orderSummary.getByRole("link", { name: "查看订单", exact: true }).click();
      await expectOverlayTarget(page, "/orders/" + original.order_id);
      await copyField(page, page.getByRole("region", { name: "订单信息", exact: true }), "商户订单号", merchantOrderNo);
    }
  } finally { await page.unroute(manifest.origin + orderApi); }
  expect(writes).toEqual([]);
});

test("public checkout shows payment results and historical refunds without internal confirmation explanations", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  const writes = observeWrites(page, manifest);
  const confirmedPath = manifest.checkouts.fullEvidence!;
  const confirmed = await data<PublicCheckoutEnvelope["data"]>(page, manifest, confirmedPath.replace("/checkout/", "/api/public/v1/checkouts/"));
  expect(confirmed.payment.status).toBe("CONFIRMED");
  expect(confirmed.payment.basis).toBe("INFERRED");
  const serverDocument = await page.request.get(manifest.origin + confirmedPath);
  expect(serverDocument.status()).toBe(200);
  const serverMarkup = await serverDocument.text();
  expect(serverMarkup).toContain("付款成功");
  expect(serverMarkup).toContain("data-payable-amount");
  expect(serverMarkup).not.toContain(automaticCheckoutCopy);
  expect(serverMarkup).not.toContain(manualCheckoutCopy);
  await page.goto(manifest.origin + confirmedPath);
  const openPath = manifest.checkouts.open!;
  const publicApi = openPath.replace("/checkout/", "/api/public/v1/checkouts/");
  const original = await data<PublicCheckoutEnvelope["data"]>(page, manifest, publicApi);
  const scenarios = [
    { basis: "MANUAL", refund: "PARTIAL", refundLabel: "部分" },
    { basis: "NONE", refund: "FULL", refundLabel: "全额" },
  ] as const;

  for (const width of widths) for (const theme of themes) {
    await presentation(page, width, theme);
    await page.goto(manifest.origin + confirmedPath);
    const payment = page.locator("[data-checkout-payment]");
    await expect(payment.getByRole("heading", { name: "付款成功", exact: true })).toBeVisible();
    await expect(payment.locator("[data-payable-amount]")).toBeVisible();
    await expect(payment.getByText(automaticCheckoutCopy)).toHaveCount(0);
    await expect(payment.getByText(manualCheckoutCopy, { exact: true })).toHaveCount(0);
    await expect(page.locator("[data-qr-image]")).toHaveCount(0);
    await record(page, info, { feature: "copy-source-checkout", evidence: "isolated-local-domain-api-and-server-html", width, theme, basis: confirmed.payment.basis });
    for (const scenario of scenarios) {
      // Presentation-only synthetic GET responses cover states absent from current fixtures.
      // No order, ledger, refund or financial operation is written.
      const synthetic: PublicCheckoutEnvelope["data"] = {
        ...structuredClone(original),
        payment_instructions: null,
        payment: { status: "CONFIRMED", basis: scenario.basis, received_amount_cents: original.payment_instructions?.payable_amount_cents ?? original.requested_amount_cents },
        refund: { status: scenario.refund },
      };
      await page.route(manifest.origin + publicApi, route => {
        expect(route.request().method()).toBe("GET");
        return route.fulfill({ status: 200, json: { data: synthetic } });
      });
      try {
        await page.goto(manifest.origin + openPath);
        await page.clock.runFor(1600);
        await expect(page.getByRole("heading", { name: "付款成功", exact: true })).toBeVisible();
        await expect(payment.getByText(automaticCheckoutCopy)).toHaveCount(0);
        await expect(payment.getByText(manualCheckoutCopy, { exact: true })).toHaveCount(0);
        const refund = page.getByRole("region", { name: "订单信息", exact: true }).locator(".checkout-refund-alert");
        await expect(refund).toContainText("订单已有" + scenario.refundLabel + "退款记录");
        await expect(refund.getByText("具体退款金额与到账进度请联系商家确认。", { exact: true })).toBeVisible();
        await expect(page.locator("[data-qr-image]")).toHaveCount(0);
        await record(page, info, { feature: "copy-source-checkout", evidence: "synthetic-public-get-response-only-no-financial-writes", width, theme, basis: scenario.basis, legacyRefund: scenario.refund });
        if (scenario.basis === "MANUAL") await screenshot(page, info, "copy-source-checkout-manual-" + width + "-" + theme);
      } finally { await page.unroute(manifest.origin + publicApi); }
    }
  }
  expect(writes).toEqual([]);
});
