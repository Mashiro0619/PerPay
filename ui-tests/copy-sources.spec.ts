import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { screenshot } from "./audit";
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

async function optionalCopyField(page: Page, scope: Locator, label: string, value: string | null, button: string) {
  if (value !== null) await copyField(page, scope, label, value, button);
  else {
    const field = scope.getByText(label, { exact: true }).locator("..");
    await expect(field.locator("dd")).toHaveText("—");
    await expect(field.getByRole("button")).toHaveCount(0);
  }
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
      await expect(page).toHaveURL(manifest.origin + "/admin" + scenario.path.replace("/ledger/", "/reconciliation/transactions/"));
      const summary = page.locator("[data-ledger-summary]");
      await expect(summary).toBeVisible();
      await expect(summary.getByText("PerPay 处理状态", { exact: true })).toHaveCount(0);
      const credentials = summary.locator("[data-detail-credentials]");
      await copyField(page, credentials, "支付宝流水号", entry.external_event_id);
      await optionalCopyField(page, credentials, "支付宝订单号", entry.provider_order_no, "复制支付宝订单号");
      await optionalCopyField(page, credentials, "支付宝商户单号", entry.merchant_order_no, "复制支付宝商户单号");
      await expect(page.locator("[data-ledger-source]")).toHaveCount(entry.sources.length);
      await expect(page.locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
      for (const source of entry.sources) {
        const card = page.locator('[data-ledger-source="' + source.ledger_entry_id + '"]');
        await expect(card.getByText("PerPay 记录状态", { exact: true })).toBeVisible();
        await copyField(page, card, "内部流水编号（PerPay）", source.ledger_entry_id);
        if (!entry.content_consistent) {
          await optionalCopyField(page, card, "支付宝订单号", source.provider_order_no, "复制来源支付宝订单号");
          await optionalCopyField(page, card, "支付宝商户单号", source.merchant_order_no, "复制来源支付宝商户单号");
        } else {
          await expect(card.locator("[data-detail-fields]").first().locator("dt")).toHaveText(["内部流水编号（PerPay）", "保存时间"]);
        }
        await expect(card.getByRole("link", { name: "查看记录与处理", exact: true })).toHaveCount(0);
        const eligible = source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state);
        const actions = card.locator('[data-slot="item-actions"], [data-slot="card-action"]').first();
        await expect(actions.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(eligible ? 1 : 0);
      }
      for (const match of entry.matches) {
        const card = page.locator('[data-ledger-match="' + match.payment_match_id + '"]');
        await expect(card.locator("[data-match-evidence]").getByText(match.evidence_type === "MANUAL" ? "管理员人工关联" : "PerPay 按金额和付款时间推断", { exact: true })).toBeVisible();
        await copyField(page, card, "商户订单号（业务网站）", match.merchant_order_no, "复制商户订单号");
        await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", "/admin/orders/" + match.order_id);
        await copyField(page, card, "使用的查账记录", match.ledger_entry_id, "复制使用的查账记录编号");
        const sourceLink = card.getByRole("link", { name: "核对这份记录", exact: true });
        await expect(sourceLink).toHaveAttribute("href", /#source-/);
        expect(new URL((await sourceLink.getAttribute("href"))!, manifest.origin).hash).toBe("#source-" + match.ledger_entry_id);
        await sourceLink.click();
        await expect(page.locator('[data-ledger-source="' + match.ledger_entry_id + '"]')).toBeFocused();
        await expect(card.getByText("支付宝交易金额", { exact: true })).toHaveCount(0);
        const trigger = card.getByRole("button", { name: "收款关联记录操作", exact: true });
        await trigger.click();
        await page.getByRole("menuitem", { name: "技术详情", exact: true }).click();
        const technical = page.getByRole("dialog", { name: "技术详情", exact: true });
        await technical.getByRole("button", { name: "复制流水编号", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(match.ledger_entry_id);
        await technical.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(technical).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      await record(page, info, { feature: "copy-source-ledger", evidence: "isolated-local-domain-api", width, theme, scenario: scenario.name, sources: entry.sources.length, matches: entry.matches.length });
      if (scenario.name === "inferred") await screenshot(page, info, "copy-source-ledger-" + width + "-" + theme);
      if (entry.active_match) {
        const active = entry.active_match;
        await page.locator('[data-ledger-match="' + active.payment_match_id + '"] [data-detail-order-summary] a[href*="/orders/"]').click();
        await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + active.order_id);
        const websiteOrder = page.getByRole("region", { name: "业务网站传入的订单信息", exact: true });
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
    await expect(row.getByText("通知类型：收款已确认", { exact: true })).toBeVisible();
    await expect(row.getByText("应付 " + amount, { exact: true })).toBeVisible();
    await expect(row).toContainText(order.merchant_order_no);
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

test("a genuine default order summary keeps a contract-length synthetic merchant reference fully wrapped", async ({ page, manifest }, info) => {
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
      const card = page.getByRole("group", { name: "可能匹配的记录", exact: true });
      const reference = card.locator('[data-slot="item-description"]').filter({ hasText: "商户订单号（业务网站）：" });
      await expect(reference).toContainText(merchantOrderNo);
      await expect(reference.locator("time")).toHaveAttribute("datetime", original.created_at);
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
      expect(measured.whiteSpace).toBe("normal");
      expect(measured.textHeight).toBeLessThanOrEqual(measured.height + 1);
      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
      expect(measured.scrollHeight).toBeLessThanOrEqual(measured.clientHeight + 1);
      if (width === 390) expect(measured.lines).toBeGreaterThan(2);
      await record(page, info, { feature: "copy-source-default-order-reference", evidence: "synthetic-order-get-reference-only-within-64-character-contract", width, theme, measured });
      await screenshot(page, info, "copy-source-default-order-reference-" + width + "-" + theme);
      await card.getByRole("link", { name: original.product_name, exact: true }).click();
      await expect(page).toHaveURL(manifest.origin + "/admin/orders/" + original.order_id);
      await copyField(page, page.getByRole("region", { name: "业务网站传入的订单信息", exact: true }), "商户订单号", merchantOrderNo);
    }
  } finally { await page.unroute(manifest.origin + orderApi); }
  expect(writes).toEqual([]);
});

test("public checkout distinguishes inferred, manual and unavailable confirmation bases and historical refunds", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  const writes = observeWrites(page, manifest);
  const confirmedPath = manifest.checkouts.fullEvidence!;
  const confirmed = await data<PublicCheckoutEnvelope["data"]>(page, manifest, confirmedPath.replace("/checkout/", "/api/public/v1/checkouts/"));
  expect(confirmed.payment.status).toBe("CONFIRMED");
  expect(confirmed.payment.basis).toBe("INFERRED");
  const confirmedExplanation = (confirmed.display?.name ?? "PerPay") + " " + automaticCheckoutCopy;
  const serverDocument = await page.request.get(manifest.origin + confirmedPath);
  expect(serverDocument.status()).toBe(200);
  expect(await serverDocument.text()).toContain(confirmedExplanation);
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
    await expect(payment.getByText(confirmedExplanation, { exact: true })).toBeVisible();
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
        await expect(page.getByRole("heading", { name: "收款已确认", exact: true })).toBeVisible();
        await expect(payment.getByText((original.display?.name ?? "PerPay") + " " + automaticCheckoutCopy, { exact: true })).toHaveCount(0);
        if (scenario.basis === "MANUAL") await expect(payment.getByText(manualCheckoutCopy, { exact: true })).toBeVisible();
        else await expect(payment.getByText(manualCheckoutCopy, { exact: true })).toHaveCount(0);
        const refund = page.getByRole("region", { name: "订单信息", exact: true }).getByRole("alert");
        await expect(refund).toContainText("历史退款记录：" + scenario.refundLabel);
        await expect(refund.getByText("此为历史退款记录，具体金额请联系商家。", { exact: true })).toBeVisible();
        await expect(page.locator("[data-qr-image]")).toHaveCount(0);
        await record(page, info, { feature: "copy-source-checkout", evidence: "synthetic-public-get-response-only-no-financial-writes", width, theme, basis: scenario.basis, legacyRefund: scenario.refund });
        if (scenario.basis === "MANUAL") await screenshot(page, info, "copy-source-checkout-manual-" + width + "-" + theme);
      } finally { await page.unroute(manifest.origin + publicApi); }
    }
  }
  expect(writes).toEqual([]);
});
