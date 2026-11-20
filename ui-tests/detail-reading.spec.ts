import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import { expectTouchTarget, measureTouchTarget, waitForControlAnimations } from "./touch-targets";
import { closeTechnicalDialog, detailSection, expectDetailFields, expectDetailRecordLayout, expectTechnicalDialogLayout, openTechnicalDialog } from "./detail-layout";
import type { AdminLedgerDetail, AdminOrderDetail, PaymentMatchDetail, WebhookAttempt, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

const scenarios = [
  // A notification is titled by the event it reports.
  { key: "notificationDns", kind: "notification", heading: "收款已确认", tools: "更多操作，通知记录操作" },
  { key: "matchSite", kind: "match", heading: "收款关联", tools: "更多操作，收款关联记录操作" },
  // A transaction is titled by its kind and its counterparty; all of its technical entries sit in the footer's menu.
  { key: "ledgerAssociated", kind: "ledger", heading: /^支付宝收款 · /, tools: "更多操作，流水操作" },
] as const;
const layoutScenarios = [
  ...scenarios,
  { ...scenarios[0], key: "notificationSite" },
  // The former global match detail now resolves to its unified transaction;
  // the site detail above still exercises its scoped evidence sections.
  { ...scenarios[2], key: "matchInferred" },
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
const foreground = (page: Page) => page.locator("[data-overlay-content]");
const detailBody = (page: Page) => foreground(page).locator("[data-overlay-detail]");
function targetUrl(page: Page, href = page.url()) {
  const outer = new URL(href, page.url());
  const target = outer.searchParams.get("overlay");
  expect(target, "record links retain an explicit overlay resource").toBeTruthy();
  return new URL(target!, outer.origin);
}
async function readDetailSection(page: Page, name: string | RegExp) {
  const section = detailBody(page).getByRole("region", { name, exact: true }).and(detailBody(page).locator("[data-detail-section]"));
  await expect(section).toBeVisible();
  await section.evaluate(element => element.scrollIntoView({ block: "start", behavior: "instant" }));
  await expect(section).toBeInViewport();
  return section;
}
async function openDetail(page: Page, manifest: Manifest, key: string) {
  await page.goto(manifest.origin + "/admin" + detailPath(manifest, key));
  await settleOverlay(page);
  await expect(detailBody(page).locator("[data-detail-page]")).toBeVisible();
  if (key.startsWith("notification")) await expect(detailSection(page, "order").locator("article[data-sub-record]")).toBeVisible();
  else if (key.startsWith("order")) await expect(detailSection(page, "overview").locator("[data-record-fields]").first()).toBeVisible();
  else if (key.startsWith("match")) {
    const target = targetUrl(page);
    const matchId = detailPath(manifest, key).split("/").at(-1)!;
    // A site's match opens as its own record; the global one is a record among its transaction's orders.
    if (target.pathname.startsWith("/sites/")) await expect(detailSection(page, "order").locator("article[data-sub-record]")).toBeVisible();
    else await expect(detailSection(page, "payments").locator(`article[id="match-${matchId}"]`)).toBeVisible();
  }
  else await expect(detailSection(page, "transaction").locator("[data-record-fields]")).toBeVisible();
  await expect(detailBody(page).locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(detailBody(page).locator("[data-detail-identifier]")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function fields(owner: Locator, names: readonly string[]) {
  for (const name of names) await expect(owner.locator("dt").filter({ hasText: new RegExp("^" + name + "$") })).toBeVisible();
}
/** What a source states for itself: its state when it is the only one, then only what the transaction as a whole cannot state. */
function sourceTerms(entry: AdminLedgerDetail, source: AdminLedgerDetail["sources"][number]) {
  return [
    ...(entry.sources.length === 1 ? ["PerPay 记录状态"] : []),
    ...(entry.amount_cents === null ? ["交易金额"] : []), ...(entry.direction === null ? ["收支方向"] : []), ...(entry.occurred_at === null ? ["交易时间"] : []),
    ...(entry.other_account === null && source.other_account ? ["对方"] : []), ...(entry.memo === null && source.memo ? ["支付宝备注"] : []),
    ...(entry.provider_order_no === null && source.provider_order_no ? ["支付宝订单号"] : []),
    ...(entry.merchant_order_no === null && source.merchant_order_no ? ["支付宝商户单号"] : []),
    "PerPay 流水编号", "保存时间",
  ];
}

/** A notification's attempts section: the latest ten in view, or one line when nothing was attempted. */
async function expectAttempts(page: Page, count: number) {
  const section = detailSection(page, "attempts");
  await expect(section.getByRole("heading", { level: 2 })).toHaveText(/^投递尝试/);
  if (!count) {
    await expect(section).toHaveAttribute("data-section-empty", "true");
    await expect(section.getByText("尚未开始投递", { exact: true })).toBeVisible();
    await expect(section.getByRole("list")).toHaveCount(0);
    return section;
  }
  // The section's name carries the count, so the list does not repeat it.
  await expect(section).toHaveAccessibleName(new RegExp(`^投递尝试\\s*，共\\s*${count}\\s*项$`));
  const list = section.getByRole("list", { name: "投递尝试", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(Math.min(count, 10));
  return list;
}
/**
 * Where a detail keeps its technical entry. A record with a footer has its
 * entries in the footer's menu, under `menuItem`; the others end the owning
 * content with one.
 */
async function technicalEntry(page: Page, label: string, menuItem?: string): Promise<{ technical: Locator; menuItem?: string }> {
  // Found by attribute: the page behind an open dialog is hidden from role queries.
  const footerMenu = foreground(page).locator("[data-overlay-footer]").locator(`button[aria-label="${label}"]`);
  if (label.includes("通知")) return { technical: footerMenu, menuItem: "通知技术信息" };
  // A transaction lists its own entry, and one for each of its sources, associations, suggestions and conflicts.
  if (label.includes("流水操作")) return { technical: footerMenu, menuItem: menuItem ?? "流水技术信息" };
  return { technical: footerMenu, menuItem: menuItem ?? "收款关联技术信息" };
}
async function keyboardTools(page: Page, label: string) {
  const { technical, menuItem } = await technicalEntry(page, label);
  const session = await openTechnicalDialog(page, technical, menuItem);
  await page.keyboard.press("Tab");
  await expect(session.close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(session.body.getByRole("button", { name: /^复制/ }).first()).toBeFocused();
  const secondary = await expectTechnicalDialogLayout(session);
  const restored = await closeTechnicalDialog(session);
  return { secondary, parentOpened: session.opened, restored };
}
// pre-wrap may hang line-ending spaces outside a line box. Check every
// non-whitespace character with the same 1 px tolerance, and retain raw ranges
// plus hanging whitespace as evidence instead of treating invisible advances as ink.
function completeFieldGeometry(field: Element) {
  const value = field.querySelector("dd")!, box = value.getBoundingClientRect();
  // A record's value is the first span of its row; the copy button beside it is not part of the text.
  const textElement = value.querySelector("span.break-all") ?? value.querySelector("span") ?? value;
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
    containerWidth: field.parentElement!.parentElement!.getBoundingClientRect().width,
    height: box.height, valueHeight: box.height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
    textHeight: bottom - top, boxHeight: textBox.height, textRight: Math.max(...characters.map(character => character.right)), boxRight: textBox.right,
    textBottom: bottom, boxBottom: textBox.bottom, characterCount: characters.length, characterText: characters.map(character => character.text).join(""),
    rawTextRight: raw.right, rawTextHeight: raw.height, hangingWhitespace };
}

async function readingFlowGeometry(page: Page, _longContent = false) {
  const groups = await expectDetailFields(detailBody(page).locator("[data-record-fields]:visible"));
  expect(groups.length).toBeGreaterThan(0);
  return groups;
}
async function headerControlsGeometry(page: Page) {
  const header = foreground(page).locator('[data-overlay-primary] > [data-slot="dialog-header"]');
  const refresh = header.getByRole("button", { name: "刷新", exact: true });
  const close = header.getByRole("button", { name: "关闭对话框", exact: true });
  await expect(refresh).toBeVisible();
  await expect(close).toBeVisible();
  const measurements = await Promise.all([refresh, close].map(control => control.evaluate(element => {
    const bounds = element.getBoundingClientRect(), header = element.closest('[data-slot="dialog-header"]')!.getBoundingClientRect();
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    return { box: bounds.toJSON(), header: header.toJSON(), center, hit: hit === element || !!hit && element.contains(hit) };
  })));
  const [refreshGeometry, closeGeometry] = measurements;
  expect(Math.abs(refreshGeometry!.center.y - closeGeometry!.center.y), "refresh and close share a visual center line").toBeLessThanOrEqual(1);
  expect(Math.abs(refreshGeometry!.box.width - closeGeometry!.box.width), "header actions have equal widths").toBeLessThanOrEqual(1);
  expect(Math.abs(refreshGeometry!.box.height - closeGeometry!.box.height), "header actions have equal heights").toBeLessThanOrEqual(1);
  expect(Math.abs(closeGeometry!.box.right - closeGeometry!.header.right), "close occupies the trailing edge of the header").toBeLessThanOrEqual(1);
  for (const control of measurements) {
    expect(control.hit, "the center is an actionable part of its control").toBe(true);
    expect(control.box.left).toBeGreaterThanOrEqual(control.header.left - 1);
    expect(control.box.right).toBeLessThanOrEqual(control.header.right + 1);
    expect(control.box.top).toBeGreaterThanOrEqual(control.header.top - 1);
    expect(control.box.bottom).toBeLessThanOrEqual(control.header.bottom + 1);
  }
  return { refresh: refreshGeometry!, close: closeGeometry! };
}
/** A record's sections share one left edge with their titles and with the facts, sub-records and timelines directly under them. */
async function recordSectionAlignment(page: Page) {
  const sections = await detailBody(page).locator("[data-record-sections] > [data-detail-section]").evaluateAll(sections => sections.map(section => {
    const left = (element: Element) => element.getBoundingClientRect().left;
    return { id: section.getAttribute("data-detail-section"), left: left(section), title: left(section.querySelector("h2")!),
      blocks: [...section.querySelectorAll(":scope > [data-record-fields], :scope > [data-sub-record], :scope > [data-record-timeline]")].map(left) };
  }));
  if (!sections.length) return null;
  for (const section of sections) {
    expect(Math.abs(section.left - sections[0]!.left), "sections share one left edge: " + section.id).toBeLessThanOrEqual(1);
    for (const edge of [section.title, ...section.blocks]) expect(Math.abs(edge - section.left), "a section's title and content start at its left edge: " + section.id).toBeLessThanOrEqual(1);
  }
  return sections;
}
async function readingLayout(page: Page, mode: "compact" | "full") {
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
  const geometry = await expectDetailRecordLayout(page);
  const header = await headerControlsGeometry(page);
  const sections = await recordSectionAlignment(page);
  // A record laid out in sections has no cards; the other details still group their facts in flat cards.
  if (!sections) expect(geometry.cards.length).toBeGreaterThan(0);
  return { ...geometry, header, sections };
}

test("headers without refresh keep close at the trailing edge and fully clickable", async ({ page, manifest }, info) => {
  await login(page, manifest);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(manifest.origin + "/admin/settings/accounts/new");
    const overlay = await settleOverlay(page);
    await expectOverlayTarget(page, "/settings/accounts/new");
    await expect(overlay.getByRole("textbox", { name: "账号名称", exact: true })).toBeVisible();
    const header = overlay.locator('[data-overlay-primary] > [data-slot="dialog-header"]');
    await expect(header.getByRole("button", { name: "刷新", exact: true })).toHaveCount(0);
    const close = header.getByRole("button", { name: "关闭对话框", exact: true });
    await waitForControlAnimations(close);
    const edges = await close.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const centerHit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return { close: bounds.toJSON(), header: element.closest('[data-slot="dialog-header"]')!.getBoundingClientRect().toJSON(),
        borderRadius: getComputedStyle(element).borderRadius, centerHit: centerHit === element || !!centerHit && element.contains(centerHit) };
    });
    expect(Math.abs(edges.close.right - edges.header.right), "an empty action slot leaves no gap after close").toBeLessThanOrEqual(1);
    const hitArea = width < 768 ? await expectTouchTarget(close) : await close.evaluate(measureTouchTarget);
    expect(hitArea.fits, "the complete close target stays within the viewport").toBe(true);
    expect(hitArea.points).toHaveLength(9);
    if (width < 768) {
      expect(hitArea.hits, "all nine mobile touch probes belong to close").toBe(true);
      expect(hitArea.width).toBeGreaterThanOrEqual(44);
      expect(hitArea.height).toBeGreaterThanOrEqual(44);
    } else {
      // Desktop icons may have rounded, non-painted bounding-box corners.
      // Retain those raw probes, then verify the actual pointer and keyboard entry.
      expect(edges.centerHit, "the desktop close center is actionable").toBe(true);
      await close.focus();
      await expect(close).toBeFocused();
    }
    await record(page, info, { feature: "overlay-empty-actions-header", width, edges, hitArea });
    const capture = info.outputPath(`header-without-refresh-${width}.png`);
    await page.screenshot({ path: capture, fullPage: false });
    await info.attach(`header-without-refresh-${width}`, { path: capture, contentType: "image/png" });
    if (width < 768) await close.click();
    else await page.keyboard.press("Enter");
    await page.clock.runFor(250);
    await expect(overlay).toHaveCount(0);
  }
});

test("detail overlays separate facts into readable business sections", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await layout(page, "dark", "compact");
  let readingWidth: number | undefined;
  for (const scenario of [...scenarios, { ...scenarios[0], key: "notificationHttp" }]) {
    await openDetail(page, manifest, scenario.key);
    const width = (await foreground(page).boundingBox())!.width;
    readingWidth ??= width;
    expect(width, "notifications, payment evidence and transaction details share the same reading width").toBe(readingWidth);
    await expect(foreground(page).getByRole("tab")).toHaveCount(0);
    if (scenario.kind === "notification") {
      // One heading per section, in reading order; the related order is a record of its own inside the last one.
      await expect(detailBody(page).getByRole("heading", { level: 2 })).toHaveText(["投递信息", /^投递尝试/, "关联订单"]);
      await expect(detailSection(page, "order").locator("article[data-sub-record]").getByRole("link", { name: "查看订单", exact: true })).toBeVisible();
      await expect(foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: scenario.tools, exact: true })).toBeVisible();
      await readDetailSection(page, /^投递尝试/);
      await expectAttempts(page, 1);
      await readDetailSection(page, "投递信息");
    } else if (scenario.kind === "match") {
      await expect(detailBody(page).getByRole("heading", { level: 2 })).toHaveText(["关联订单", "支付宝流水", "匹配依据", "处理记录"]);
      await expect(detailSection(page, "order").locator("article[data-sub-record]").getByRole("link", { name: "查看订单", exact: true })).toBeVisible();
      await expect(detailSection(page, "ledger").locator("[data-record-fields]")).toBeVisible();
      await expect(detailSection(page, "evidence").getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
      await expect(foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: scenario.tools, exact: true })).toBeVisible();
    } else {
      // What the summary states (the amount, the direction, the time and the account) is not repeated among the facts.
      await expect(detailBody(page).getByRole("heading", { level: 2 })).toHaveText(["交易信息", /^对应订单/, /^采集记录/]);
      await expect(foreground(page).getByRole("group", { name: "流水概况", exact: true }).locator("[data-record-summary-value]")).toHaveText(/^\+¥/);
      await expect(detailSection(page, "transaction").locator("dt")).toHaveText(["对方", "支付宝备注", "支付宝流水号", "支付宝订单号"]);
      await expect(detailBody(page).locator("dt").filter({ hasText: /^(支付宝 App ID|交易金额|收款账号|收支方向|交易时间)$/ })).toHaveCount(0);
      await readDetailSection(page, /^对应订单/);
      await expect(detailSection(page, "payments").locator("article[data-sub-record]").first()).toBeVisible();
      await readDetailSection(page, /^采集记录/);
      await expect(detailSection(page, "sources").locator("[data-record-fields]").first()).toBeVisible();
      await expect(detailSection(page, "conflicts")).toHaveCount(0);
      await readDetailSection(page, "交易信息");
    }
    const geometry = await readingLayout(page, "compact");
    const flows = await readingFlowGeometry(page);
    await record(page, info, { feature: "detail-reading-sections", key: scenario.key, geometry, flows, evidence: "local-synthetic-domain" });
    await screenshot(page, info, "reading-sections-" + scenario.key);
  }
});

test("summaries and credentials retain reading order in stable responsive columns", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await layout(page, "dark", "full");
  const checkWrapping = async (container: Locator) => {
    const originalWidth = await container.evaluate(element => (element as HTMLElement).style.width);
    const originalFont = await page.evaluate(() => document.documentElement.style.fontSize);
    const names = await container.locator("dt").allTextContents();
    const wrapping = [];
    try {
      for (const textPercent of [100, 200]) {
        await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", textPercent);
        // Root-font changes animate rem-sized copy buttons before their final geometry settles.
        for (const button of await container.getByRole("button").all()) await waitForControlAnimations(button);
        const samples: Awaited<ReturnType<typeof expectDetailFields>> = [];
        for (const requestedWidth of [320, 480, 720, 960]) {
          await container.evaluate((element, width) => { (element as HTMLElement).style.width = width + "px"; }, requestedWidth);
          // With reduced motion every style change still runs a 0.01ms transition, so the new width applies a frame later.
          await waitForControlAnimations(container);
          const measured = (await expectDetailFields(container))[0]!;
          expect(measured.width).toBe(requestedWidth);
          expect(measured.fields.map(field => field.name)).toEqual(names);
          expect(measured.rows.flat(), "responsive wrapping retains DOM reading order").toEqual(names);
          samples.push(measured);
          wrapping.push({ textPercent, requestedWidth, height: measured.height, rows: measured.rows,
            fieldWidths: measured.fields.map(field => ({ name: field.name, wide: field.wide, width: field.width, inline: field.inline })) });
        }
        const narrow = samples[0]!, roomy = samples.at(-1)!;
        expect(roomy.height, "additional width never adds vertical space to the same facts").toBeLessThanOrEqual(narrow.height + 1);
        if (roomy.orderSummary) {
          const shortFacts = ["应付金额", "实收金额", "所属网站"];
          expect(roomy.fields.filter(field => shortFacts.includes(field.name!))).toHaveLength(shortFacts.length);
          const columnCount = roomy.width >= 44 * roomy.rootFont ? 2 : 1;
          expect(roomy.rows.every(row => row.length <= columnCount), "field groups use at most the responsive column count").toBe(true);
          expect(narrow.rows.every(row => row.length === 1), "narrow content has one predictable field per row").toBe(true);
          if (columnCount === 2) {
            const first = roomy.fields.find(field => field.name === "应付金额")!, second = roomy.fields.find(field => field.name === "实收金额")!;
            expect(roomy.rows[0]).toEqual(["应付金额", "实收金额"]);
            expect(Math.abs(first.width - second.width), "the two monetary fields share equal column widths").toBeLessThanOrEqual(1);
            expect(roomy.rows.length).toBeLessThan(narrow.rows.length);
          }
        }
      }
    } finally {
      await container.evaluate((element, width) => { (element as HTMLElement).style.width = width; }, originalWidth);
      await page.evaluate(font => document.documentElement.style.fontSize = font, originalFont);
    }
    return wrapping;
  };
  // Every record lists its facts in one column and stacks the whole list once its container is narrow.
  await openDetail(page, manifest, "matchSite");
  const wrapping = await checkWrapping(detailSection(page, "order").locator("[data-record-fields]"));
  await record(page, info, { feature: "detail-flow-content-wrapping", wrapping });
  await screenshot(page, info, "reading-flow-wrapping-restored");

  const ledgerWrapping = await checkWrapping(detailSection(page, "ledger").locator("[data-record-fields]"));
  await record(page, info, { feature: "detail-flow-ledger-wrapping", evidence: "local-synthetic-domain", wrapping: ledgerWrapping });
  await screenshot(page, info, "reading-flow-two-facts");

  // A transaction's identifiers are rows of its field list, which stacks as a whole once it is narrow.
  await openDetail(page, manifest, "ledgerAssociated");
  const credentialWrapping = await checkWrapping(detailSection(page, "transaction").locator("[data-record-fields]"));
  await record(page, info, { feature: "detail-credential-content-wrapping", credentialWrapping });
});

test.describe("detail reading width matrix", () => {
  // Give each viewport its own trace and let both workers share the 80 scenarios.
  test.describe.configure({ mode: "parallel" });
  for (const width of [320, 390, 1440, 2190]) {
    test(`${width}px: three detail types retain expanded facts across themes and content modes`, async ({ page, manifest }, info) => {
      test.setTimeout(600_000);
      await login(page, manifest);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await layout(page, theme, mode);
        for (const scenario of layoutScenarios) {
          await openDetail(page, manifest, scenario.key);
          await expect(foreground(page).getByRole("heading", { level: 1 })).toHaveText(scenario.heading);
          await expect(foreground(page).getByRole("heading", { level: 1 })).toHaveCount(1);
          await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
          if (scenario.kind === "notification") {
            // A site workspace has one website, so its records do not name it again.
            await expect(detailSection(page, "overview").locator("dt").filter({ hasText: /^业务网站$/ })).toHaveCount(scenario.key === "notificationSite" ? 0 : 1);
            await fields(detailSection(page, "overview"), ["通知地址", "创建时间"]);
            // The summary states when the next attempt is due, so the facts do not repeat it.
            await expect(foreground(page).getByRole("group", { name: "通知状态", exact: true }).locator("[data-record-summary-meta]")).toContainText(/已尝试 1 次 · 下次重试 /);
            await expect(detailSection(page, "order").locator("article[data-sub-record]")).toBeVisible();
            await readDetailSection(page, /^投递尝试/);
            await expect((await expectAttempts(page, 1)).getByText(/通知域名解析失败/)).toBeVisible();
            await readDetailSection(page, "投递信息");
          } else if (scenario.kind === "match") {
            await expect(detailSection(page, "order").locator("article[data-sub-record]")).toBeVisible();
            await readDetailSection(page, "支付宝流水");
            await fields(detailSection(page, "ledger"), ["交易金额", "交易时间", "对方", "支付宝流水号", "支付宝订单号", "支付宝备注", "PerPay 流水编号"]);
            await readDetailSection(page, "匹配依据");
            await fields(detailSection(page, "evidence"), ["金额占用时间"]);
            await expect(detailSection(page, "evidence").getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
            await expect(detailSection(page, "evidence").getByRole("button", { name: "匹配依据", exact: true })).toHaveCount(0);
            await readDetailSection(page, "关联订单");
          } else {
            await readDetailSection(page, "交易信息");
            await fields(detailSection(page, "transaction"), ["对方", "支付宝流水号", "支付宝订单号"]);
            // The amount, the direction and the time stand in the summary, above the facts.
            await expect(foreground(page).getByRole("group", { name: "流水概况", exact: true }).locator("[data-record-summary-value]")).toHaveText(/^\+¥/);
            await expect(detailBody(page).locator('dt').filter({ hasText: /^(支付宝 App ID|交易金额|收支方向|交易时间)$/ })).toHaveCount(0);
            await readDetailSection(page, /^采集记录/);
            await fields(detailSection(page, "sources"), ["PerPay 流水编号"]);
            await readingFlowGeometry(page);
            await readDetailSection(page, /^对应订单/);
            await expect(detailSection(page, "payments").locator("article[data-sub-record]").first()).toBeVisible();
            await readingFlowGeometry(page);
            await expect(detailSection(page, "conflicts")).toHaveCount(0);
            await readDetailSection(page, "交易信息");
          }
          const flows = await readingFlowGeometry(page);
          const geometry = await readingLayout(page, mode);
          const technicalDialog = await keyboardTools(page, scenario.tools);
          const id = `reading-${scenario.key}-${width}-${theme}-${mode}`;
          await record(page, info, { feature: "detail-reading-matrix", width, theme, mode, scenario: scenario.key, flows, geometry, technicalDialog, evidence: "local-synthetic-domain" });
          await screenshot(page, info, id);
          if (width === 320 && mode === "compact") await audit(page, info, id);
        }
      }
      if (width === 2190) {
        // Exercise the intermediate viewport as well as the explicit container
        // widths above; each real fact group chooses its own natural wrapping.
        await page.setViewportSize({ width: 1100, height: 900 });
        await layout(page, "dark", "full");
        await openDetail(page, manifest, "ledgerAssociated");
        await readingFlowGeometry(page);
        await page.setViewportSize({ width: 2190, height: 900 });
        await openDetail(page, manifest, "ledgerAssociated");
        await readingFlowGeometry(page);
      }
      expect(errors).toEqual([]);
    });
  }
});

test("coarse-pointer detail actions retain compact touch targets in both content modes", async ({ browser, manifest }, info) => {
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
      // An order has the fullest summary and action bar: four section links, and two actions beside the menu.
      for (const key of [...scenarios.map(scenario => scenario.key), "orderLong"]) {
        await openDetail(page, manifest, key);
        const headerGeometry = await headerControlsGeometry(page);
        const header = foreground(page).locator('[data-overlay-primary] > [data-slot="dialog-header"]');
        const refreshTouch = await expectTouchTarget(header.getByRole("button", { name: "刷新", exact: true }));
        const closeTouch = await expectTouchTarget(header.getByRole("button", { name: "关闭对话框", exact: true }));
        expect(Math.abs(refreshTouch.width - closeTouch.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(refreshTouch.height - closeTouch.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(refreshTouch.y + refreshTouch.height / 2 - closeTouch.y - closeTouch.height / 2)).toBeLessThanOrEqual(1);
        const targets = [];
        // Every button of the record: in its content, among the summary's section links and in the action bar.
        const regions = { summary: 0, detail: 0, footer: 0 };
        for (const button of await foreground(page).locator(':is([data-overlay-summary], [data-overlay-detail], [data-overlay-footer]) :is([class~="group/button"], [data-slot="button"])').all()) {
          if (!await button.isVisible() || !await button.isEnabled()) continue;
          // Reveal the complete generated touch slot, including its margins.
          await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await page.clock.runFor(100);
          targets.push(await expectTouchTarget(button));
          regions[await button.evaluate(element => element.closest("[data-overlay-summary]") ? "summary" : element.closest("[data-overlay-footer]") ? "footer" : "detail")]++;
        }
        expect(targets.length).toBeGreaterThan(0);
        if (key === "orderLong") {
          expect(regions.summary, "four section links").toBe(4);
          // On phones the secondary action moves into the menu beside a primary action.
          expect(regions.footer, "the menu and the primary action").toBe(2);
        }
        await record(page, info, { feature: "detail-touch-targets", width, mode, scenario: key, regions, targets, headerGeometry, headerTargets: [refreshTouch, closeTouch] });
        await screenshot(page, info, `reading-touch-${key}-${width}-${mode}`);
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
    const summary = foreground(page).getByRole("group", { name: "通知状态", exact: true });
    const overview = detailSection(page, "overview");
    const footer = foreground(page).locator("[data-overlay-footer]");
    await expect(overview.getByText(detail.target.target_url, { exact: true })).toBeVisible();
    // The summary states how often delivery was attempted and when the next attempt is due, so the facts repeat neither.
    await expect(summary.locator("[data-record-summary-meta]")).toContainText(`已尝试 ${detail.delivery.attempt_count} 次`);
    await expect(overview.locator("dt").filter({ hasText: /^(尝试次数|下次重试|计划投递)$/ })).toHaveCount(0);
    if (key === "notificationSite") {
      const order = detailSection(page, "order").getByRole("link", { name: "查看订单", exact: true });
      expect(targetUrl(page, (await order.getAttribute("href"))!).pathname).toBe("/sites/" + detail.target.api_client_id + "/orders/" + detail.event.order_id);
    }
    await readDetailSection(page, /^投递尝试/);
    const attempts = await expectAttempts(page, detail.delivery.attempt_count);
    if (key === "notificationPending") expect(detail.delivery.attempt_count).toBe(0);
    if (key === "notificationDns" || key === "notificationSite") await expect(attempts.getByText(/通知域名解析失败/)).toBeVisible();
    if (key === "notificationHttp") await expect(attempts.getByText(/HTTP 503/)).toBeVisible();
    await readDetailSection(page, "投递信息");
    if (key === "notificationHistory") {
      expect(detail.is_latest).toBe(false);
      await expect(summary.getByText("历史投递", { exact: true })).toBeVisible();
      await expect(overview.getByRole("link", { name: "已重新发送，查看最新结果", exact: true })).toBeVisible();
      // A delivery replaced by a resend offers none of its own; its technical information stays available.
      await expect(foreground(page).getByRole("button", { name: "重新发送", exact: true })).toHaveCount(0);
      await footer.getByRole("button", { name: "更多操作，通知记录操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "通知技术信息", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "重新发送", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
    if (key === "notificationDead") {
      // A stopped delivery offers the resend as the record's primary action.
      const trigger = footer.locator("[data-record-primary-actions]").getByRole("button", { name: "重新发送", exact: true });
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
    await screenshot(page, info, "reading-" + key);
  }
});

test("notification history loads after its delivery succeeds and does not reload when sections reflow", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  const route = detailPath(manifest, "notificationHttp"), deliveryPath = apiPath(route);
  const detail = await data<WebhookDeliveryDetail>(page, manifest, deliveryPath);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let deliveryReads = 0, attemptReads = 0, available = true;
  await page.route(manifest.origin + deliveryPath, async request => {
    deliveryReads++;
    await gate;
    return available
      ? request.fulfill({ status: 200, json: { data: detail } })
      : request.fulfill({ status: 503, json: { error: { code: "synthetic_delivery_unavailable", message: "合成的通知详情读取失败" } } });
  });
  await page.route(manifest.origin + deliveryPath + "/attempts", request => { attemptReads++; return request.continue(); });
  try {
    await page.goto(manifest.origin + "/admin" + route);
    await expect.poll(() => deliveryReads).toBe(1);
    // Until the delivery is read, the drawer keeps its general title.
    await expect(foreground(page).getByRole("heading", { level: 1 })).toHaveText("通知详情");
    await page.clock.runFor(100);
    expect(attemptReads, "history cannot start before the delivery read succeeds").toBe(0);
    release();
    await expect.poll(() => attemptReads).toBe(1);
    await expectAttempts(page, detail.delivery.attempt_count);
    await expect(foreground(page).getByRole("heading", { level: 1 })).toHaveText("收款已确认");
    await expect(detailSection(page, "overview").getByText(detail.target.target_url, { exact: true })).toBeVisible();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await revealHistory();
      expect({ deliveryReads, attemptReads }).toEqual({ deliveryReads: 1, attemptReads: 1 });
    }
    const successfulReads = { deliveryReads, attemptReads };
    available = false;
    attemptReads = 0;
    await page.reload();
    await expect(foreground(page).getByText("合成的通知详情读取失败", { exact: true })).toBeVisible();
    expect(attemptReads, "a failed delivery never starts an unrelated attempt read").toBe(0);
    await record(page, info, { feature: "notification-dependent-history-read", evidence: "gated local delivery response and real local attempts; no sends", successfulReads, failedDeliveryAttemptReads: attemptReads });
  } finally { release(); }

  async function revealHistory() {
    await readDetailSection(page, /^投递尝试/);
    await expect(foreground(page).getByRole("tab")).toHaveCount(0);
    await page.clock.runFor(100);
  }
});

test("a clearly synthetic 21-attempt response keeps the latest ten in view and folds the rest, newest-first without loss", async ({ page, manifest }, info) => {
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
  await expect(foreground(page).getByRole("group", { name: "通知状态", exact: true }).locator("[data-record-summary-meta]")).toContainText("已尝试 21 次");
  await readDetailSection(page, /^投递尝试/);
  const section = detailSection(page, "attempts");
  const numbers = async (list: Locator) => (await list.getByRole("listitem").allTextContents()).map(value => Number(/第 (\d+) 次/.exec(value)![1]));
  const latest = await expectAttempts(page, 21);
  const seen = await numbers(latest);
  expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => 21 - index));
  const earlier = section.getByRole("button", { name: /^更早的尝试/ });
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await expect(earlier).toContainText("11");
  await expect(section.getByRole("list")).toHaveCount(1);
  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-expanded", "true");
  const folded = section.getByRole("list", { name: "更早的尝试", exact: true });
  await expect(folded.getByRole("listitem")).toHaveCount(11);
  seen.push(...await numbers(folded));
  expect(seen).toEqual(Array.from({ length: 21 }, (_, index) => 21 - index));
  // Folding the earlier attempts again leaves the latest ten as they were.
  await earlier.click();
  await expect(earlier).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("list")).toHaveCount(1);
  expect(await numbers(latest)).toEqual(seen.slice(0, 10));
  await record(page, info, { feature: "notification-attempt-folding", evidence: "synthetic-detail-and-attempts-responses-no-sends", count: attempts.length, observed: seen });
  await screenshot(page, info, "reading-notification-21-attempts");
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
  await readDetailSection(page, /^投递尝试/);
  const main = detailBody(page), section = detailSection(page, "attempts");
  const unread = section.getByText("投递尝试读取失败，请刷新重试。", { exact: true });
  // The drawer's notice reports the failure; the section says which part is missing, without calling it empty.
  await expect(unread).toBeVisible();
  await expect(section).not.toHaveAttribute("data-section-empty", "true");
  await expect(section.getByText("尚未开始投递", { exact: true })).toHaveCount(0);
  await expect(section.getByRole("list")).toHaveCount(0);
  const alert = main.getByRole("alert", { name: "服务连接提示", exact: true });
  await expect(alert).toContainText("合成的投递尝试读取失败");
  // The header's refresh is the retry the section points to.
  const beforeRefresh = reads;
  await foreground(page).getByRole("button", { name: "刷新", exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(beforeRefresh);
  await expect(unread).toBeVisible();
  const beforeRetry = reads;
  unavailable = false;
  await alert.getByRole("button", { name: "重试", exact: true }).click();
  await expect((await expectAttempts(page, 1)).getByText(/HTTP 503/)).toBeVisible();
  await expect(unread).toHaveCount(0);
  await expect(alert).toHaveCount(0);
  expect(reads).toBeGreaterThan(beforeRetry);
  await record(page, info, { feature: "notification-attempt-read-recovery", evidence: "synthetic-unavailable-response-then-original-attempts", beforeRetry, afterRetry: reads });
  await screenshot(page, info, "reading-notification-attempt-read-recovered");
});

test("automatic, manual and reversed matches keep full evidence in unified and site details", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const key of ["matchInferred", "matchManual", "matchReversed", "matchSite"]) {
    await openDetail(page, manifest, key);
    const match = await data<PaymentMatchDetail>(page, manifest, apiPath(detailPath(manifest, key)));
    const scoped = key === "matchSite";
    // Both a scoped match detail and a global transaction use the record layout: the scoped one has its own sections,
    // while the global one sits among its transaction's orders and does not repeat the transaction's facts.
    const card = scoped ? detailSection(page, "order").locator("article[data-sub-record]")
      : detailSection(page, "payments").locator(`article[id="match-${match.payment_match_id}"]`);
    const transaction = scoped ? detailSection(page, "ledger") : detailSection(page, "transaction");
    const evidence = scoped ? detailSection(page, "evidence") : card;
    const history = scoped ? detailSection(page, "history") : card;
    if (!scoped) {
      await expectOverlayTarget(page, "/reconciliation/transactions/" + match.ledger_entry_id + "#match-" + match.payment_match_id);
      // The link leads to the association itself, wherever it stands among the orders.
      await expect(card).toBeInViewport();
      await expect(card.getByText("支付宝交易金额", { exact: true })).toHaveCount(0);
      const entry = await data<AdminLedgerDetail>(page, manifest, "/api/admin/v1/ledger/entries/" + match.ledger_entry_id);
      // Only a transaction with several sources has to say which of them an association uses.
      const sourceLink = card.getByRole("link", { name: /^采集记录 \d+$/ });
      await expect(sourceLink).toHaveCount(entry.sources.length > 1 ? 1 : 0);
      if (entry.sources.length > 1) expect(targetUrl(page, (await sourceLink.getAttribute("href"))!).hash).toBe("#source-" + match.ledger_entry_id);
      await readDetailSection(page, "交易信息");
    } else await readDetailSection(page, "支付宝流水");
    await expect(transaction.getByText(match.ledger_entry.provider_order_no!, { exact: true })).toBeVisible();
    await readDetailSection(page, scoped ? "关联订单" : /^对应订单/);
    await expect(card).toContainText(match.order.merchant_order_no);
    if (match.candidate) {
      if (scoped) {
        await readDetailSection(page, "匹配依据");
        await expect(evidence.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
      } else {
        // Folded until asked for: it holds only what the transaction does not state itself.
        const basis = card.getByRole("button", { name: /^匹配依据/ });
        await expect(basis).toHaveAttribute("aria-expanded", "false");
        await basis.click();
        await expect(basis).toHaveAttribute("aria-expanded", "true");
      }
      await expect(evidence.getByText("金额占用时间", { exact: true })).toBeVisible();
    }
    if (match.evidence_type === "MANUAL") {
      if (scoped) {
        await readDetailSection(page, "处理记录");
        await expect(history.getByText("管理员人工关联", { exact: true })).toBeVisible();
        expect(match.creation_operation.reason).toBeTruthy();
        await expect(history).toContainText(match.creation_operation.reason!);
      } else {
        await expect(card.locator("header")).toContainText("管理员人工关联 · ");
        expect(match.creation_operation.reason).toBeTruthy();
        await expect(card.locator("dd").filter({ hasText: match.creation_operation.reason! })).toBeVisible();
      }
    }
    if (match.status === "REVERSED") {
      expect(match.resolution_operation?.reason).toBeTruthy();
      if (scoped) {
        await readDetailSection(page, "处理记录");
        await expect(history).toContainText("撤销收款关联");
        await expect(history).toContainText(match.resolution_operation!.reason!);
        await foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: "更多操作，收款关联记录操作", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "收款关联技术信息", exact: true })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "撤销错误关联", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
      } else {
        await fields(card, ["撤销时间", "撤销操作人", "撤销理由"]);
        await expect(card.locator("dd").filter({ hasText: match.resolution_operation!.reason! })).toBeVisible();
        await expect(page.getByRole("menuitem", { name: "撤销错误关联", exact: true })).toHaveCount(0);
        // A reversed association offers nothing; its technical information stays in the transaction's menu.
        await expect(card.getByRole("button", { name: "撤销错误关联", exact: true })).toHaveCount(0);
        await foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: "更多操作，流水操作", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: /^收款关联技术信息/ }).first()).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
    } else {
      // A scoped match puts the destructive reversal in its footer menu; a sub-record with a single action shows it as a button.
      const trigger = scoped
        ? foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: "更多操作，收款关联记录操作", exact: true })
        : card.getByRole("button", { name: "撤销错误关联", exact: true });
      await trigger.click();
      if (scoped) await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "撤销收款关联？", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("不会转出资金");
      await expect(dialog.getByRole("button", { name: "确认撤销关联", exact: true })).toBeDisabled();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    const orderPrefix = scoped ? "/sites/" + match.order.api_client_id : "";
    if (scoped) await readDetailSection(page, "关联订单");
    const orderLink = card.getByRole("link", { name: "查看订单", exact: true });
    expect(targetUrl(page, (await orderLink.getAttribute("href"))!).pathname).toBe(orderPrefix + "/orders/" + match.order_id);
    await record(page, info, { feature: "match-domain-scenarios", key, evidenceType: match.evidence_type, status: match.status });
    await screenshot(page, info, "reading-" + key);
  }
});

test("all genuine ledger versions and synthetic simultaneous associations remain visible", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  for (const key of ["ledgerAssociated", "ledgerIdentical", "ledgerDisputed"]) {
    const entry = await data<AdminLedgerDetail>(page, manifest, apiPath(detailPath(manifest, key)));
    await openDetail(page, manifest, key);
    const several = entry.sources.length > 1;
    // The transaction's identifiers are in view at once, each stated a single time.
    await expect(detailBody(page).getByText(entry.external_event_id, { exact: true })).toHaveCount(1);
    await expect(detailSection(page, "transaction").getByText(entry.external_event_id, { exact: true })).toBeVisible();
    if (key === "ledgerDisputed") await expect(foreground(page).getByRole("group", { name: "流水概况", exact: true })).toContainText("有争议");
    await readDetailSection(page, /^对应订单/);
    await expect(detailSection(page, "payments").locator('article[id^="match-"]')).toHaveCount(entry.matches.length);
    if (entry.conflicts.length) {
      await readDetailSection(page, /^账本冲突/);
      await expect(detailSection(page, "conflicts").locator('article[id^="conflict-"]')).toHaveCount(entry.conflicts.length);
    } else await expect(detailSection(page, "conflicts")).toHaveCount(0);
    const sources = await readDetailSection(page, /^采集记录/);
    // A single source is the record itself; several are told apart as records of their own.
    await expect(sources.locator('article[id^="source-"]')).toHaveCount(several ? entry.sources.length : 0);
    for (const [index, source] of entry.sources.entries()) {
      const owner = several ? sources.locator(`article[id="source-${source.ledger_entry_id}"]`) : sources;
      if (several) await expect(owner.getByRole("heading", { level: 3 })).toHaveText("采集记录 " + (index + 1));
      await expect(owner.getByText(source.ledger_entry_id, { exact: true })).toBeVisible();
      await expect(owner.locator("dt")).toHaveText(sourceTerms(entry, source));
      await expect(owner.getByRole("link", { name: "查看记录与处理", exact: true })).toHaveCount(0);
    }
    if (key === "ledgerIdentical") { expect(entry.content_consistent).toBe(true); expect(several).toBe(true); }
    if (key === "ledgerDisputed") {
      expect(entry.content_consistent).toBe(false);
      await expect(foreground(page).locator("[data-record-notice]")).toContainText("账单信息存在不同版本");
      expect(entry.amount_cents, "the genuine versions differ in their amounts").toBeNull();
      // Each version states its own amount; the versions are never added up.
      for (const source of entry.sources) {
        const amount = sources.locator(`article[id="source-${source.ledger_entry_id}"]`).locator("dt").filter({ hasText: /^交易金额$/ }).locator("..").locator("dd");
        await expect(amount).toHaveText(/^¥/);
      }
    } else await expect(foreground(page).locator("[data-record-notice]")).toHaveCount(0);
    // The record offers the association for copies that agree, and nobody offers one while an association is in effect.
    const eligible = entry.active_match_count ? [] : entry.sources.filter(source => source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state));
    const shared = eligible.length > 0 && (!several || entry.content_consistent);
    await expect(foreground(page).locator("[data-overlay-footer]").getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(shared ? 1 : 0);
    // A copy is named wherever there is a choice to make: among several copies, or where differing copies leave no default.
    await expect(sources.getByRole("button", { name: "用这份记录关联", exact: true })).toHaveCount(several && (eligible.length > 1 || !shared) ? eligible.length : 0);
    await expect(sources.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(0);
    await record(page, info, { feature: "ledger-domain-scenarios", key, sources: entry.sources.length, matches: entry.matches.length, conflicts: entry.conflicts.length });
    await screenshot(page, info, "reading-" + key);
  }
  const path = apiPath(detailPath(manifest, "ledgerAssociated"));
  const entry = structuredClone(await data<AdminLedgerDetail>(page, manifest, path));
  const settled = entry.matches.find(match => match.status === "SETTLED");
  expect(settled).toBeTruthy();
  const second = { ...structuredClone(settled!), payment_match_id: "b0000000-0000-4000-8000-000000000002", order_id: "b0000000-0000-4000-8000-000000000003", merchant_order_no: "SYNTHETIC-SECOND-ACTIVE-ORDER", product_name: "合成的第二条生效关联" };
  const full = await data<PaymentMatchDetail>(page, manifest, "/api/admin/v1/reconciliation/matches/" + settled!.payment_match_id);
  const secondDetail: PaymentMatchDetail = { ...structuredClone(full), payment_match_id: second.payment_match_id, order_id: second.order_id,
    order: { ...structuredClone(full.order), order_id: second.order_id, merchant_order_no: second.merchant_order_no, product_name: second.product_name } };
  entry.matches.push(second);
  entry.active_match_count = entry.matches.filter(match => match.status === "SETTLED").length;
  entry.active_match = null;
  await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: entry } }));
  await page.route(manifest.origin + "/api/admin/v1/reconciliation/matches/" + second.payment_match_id, route => route.fulfill({ status: 200, json: { data: secondDetail } }));
  await openDetail(page, manifest, "ledgerAssociated");
  const notice = foreground(page).locator("[data-record-notice]");
  await expect(notice).toHaveAttribute("data-record-notice", "danger");
  await expect(notice).toContainText(`有 ${entry.active_match_count} 条有效关联`);
  await expect(notice).toContainText("无法确定唯一订单");
  await expect(foreground(page).getByRole("group", { name: "流水概况", exact: true }).getByText("多笔关联", { exact: true })).toBeVisible();
  // The notice leads to the associations it is about.
  await notice.getByRole("button", { name: "核对各条关联", exact: true }).click();
  const associations = detailSection(page, "payments");
  await expect(associations).toBeFocused();
  await expect(associations).toBeInViewport();
  await expect(associations.locator('article[id^="match-"]')).toHaveCount(entry.matches.length);
  await expect(detailBody(page).getByText("当前实际关联", { exact: true })).toHaveCount(0);
  for (const match of [settled!, second]) {
    const card = associations.locator(`article[id="match-${match.payment_match_id}"]`);
    expect(targetUrl(page, (await card.getByRole("link", { name: "查看订单", exact: true }).getAttribute("href"))!).pathname).toBe("/orders/" + match.order_id);
    await expect(card.getByText("存在多条关联", { exact: true })).toBeVisible();
  }
  await record(page, info, { feature: "ledger-multiple-associations", evidence: "synthetic-detail-response-only", activeMatchCount: entry.active_match_count });
  await screenshot(page, info, "reading-ledger-multiple-active-associations");
});

test("technical record identifiers remain copyable without crowding the business details", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const notification = await data<WebhookDeliveryDetail>(page, manifest, apiPath(detailPath(manifest, "notificationDns")));
  const match = await data<PaymentMatchDetail>(page, manifest, apiPath(detailPath(manifest, "matchInferred")));
  const ledger = await data<AdminLedgerDetail>(page, manifest, apiPath(detailPath(manifest, "ledgerAssociated")));
  expect(ledger.sources).toHaveLength(1);
  const source = ledger.sources[0]!;
  const copies = await data<AdminLedgerDetail>(page, manifest, apiPath(detailPath(manifest, "ledgerIdentical")));
  expect(copies.sources.length).toBeGreaterThan(1);
  const copy = copies.sources[1]!;
  // A transaction keeps every technical entry in its footer's menu. Its only source's identifiers stand with
  // its own; several sources each have an entry.
  const cases: Array<{ key: string; tools: string; item?: string; values: Array<[string, string | null]> }> = [
    { key: "notificationDns", tools: "更多操作，通知记录操作", values: [["投递编号", notification.delivery.delivery_id], ["事件编号", notification.event.event_id]] },
    { key: "matchInferred", tools: "更多操作，流水操作", item: "收款关联技术信息", values: [["关联编号", match.payment_match_id], ["PerPay 流水编号", match.ledger_entry_id]] },
    { key: "ledgerAssociated", tools: "更多操作，流水操作", values: [["PerPay 流水编号", ledger.ledger_entry_id], ["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key]] },
    { key: "ledgerIdentical", tools: "更多操作，流水操作", item: "采集记录 2 技术信息", values: [["PerPay 流水编号", copy.ledger_entry_id], ["支付宝 App ID", copy.app_id], ["采集来源标识", copy.provider_account_key]] },
  ];
  for (const scenario of cases) {
    await openDetail(page, manifest, scenario.key);
    await expect(detailBody(page).locator('dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
    const { technical, menuItem } = await technicalEntry(page, scenario.tools, scenario.item);
    const session = await openTechnicalDialog(page, technical, menuItem);
    await page.keyboard.press("Tab");
    await expect(session.close).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(session.body.getByRole("button", { name: /^复制/ }).first()).toBeFocused();
    for (const [name, value] of scenario.values) {
      expect(value, name).toBeTruthy();
      await expect(session.body.getByText(value!, { exact: true })).toBeVisible();
      await session.body.getByRole("button", { name: "复制" + name, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
    const secondary = await expectTechnicalDialogLayout(session);
    await screenshot(page, info, "reading-technical-" + scenario.key + "-" + (menuItem ?? "entry"));
    const restored = await closeTechnicalDialog(session);
    await expect(detailBody(page).locator('dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
    await record(page, info, { feature: "detail-technical-identifiers", scenario: scenario.key, tools: scenario.tools,
      copiedFields: scenario.values.map(([name]) => name), secondary, parentOpened: session.opened, restored, evidence: "local-synthetic-domain" });
  }
});

test("long products, complete identifiers and multiline details wrap without clipping", async ({ page, manifest }, info) => {
  test.setTimeout(180_000);
  await login(page, manifest);
  const notificationPath = apiPath(detailPath(manifest, "notificationDns"));
  const notification = structuredClone(await data<WebhookDeliveryDetail>(page, manifest, notificationPath));
  const orderPath = "/api/admin/v1/orders/" + notification.event.order_id;
  const order = structuredClone(await data<AdminOrderDetail>(page, manifest, orderPath));
  const matchPath = apiPath(detailPath(manifest, "matchSite"));
  const match = structuredClone(await data<PaymentMatchDetail>(page, manifest, matchPath));
  const ledgerPath = apiPath(detailPath(manifest, "ledgerAssociated"));
  const ledger = structuredClone(await data<AdminLedgerDetail>(page, manifest, ledgerPath));
  const product = "长商品名称与完整授权范围 · ".repeat(18) + "商品末尾标记";
  const siteName = "完整业务网站名称与所属经营主体 · ".repeat(16) + "网站末尾标记";
  const counterparty = "完整交易对方与付款账户 · ".repeat(16) + "payer@example.test 对方末尾标记";
  const memo = "第一行：保留详细业务说明和特殊字符 <>&\n第二行：保留原始换行及完整备注\n第三行：可见末尾标记";
  const identifier = "2026102122001010255800001184" + "0123456789".repeat(22);
  const externalIdentifier = "流水完整编号_" + "0123456789".repeat(22);
  const merchantIdentifier = "MERCHANT-".repeat(30) + "商户单末尾";
  const target = new URL(notification.target.target_url);
  target.searchParams.set("description", "完整通知上下文".repeat(40));
  const targetUrl = target.href;
  expect(targetUrl.length).toBeGreaterThan(200);
  order.product_name = product;
  order.site_name = siteName;
  notification.target.target_url = targetUrl;
  notification.target.site_name = siteName;
  notification.delivery.requested_by_type = "ADMIN";
  notification.delivery.requested_by_actor_id = "synthetic-layout-admin";
  notification.delivery.reason = memo;
  match.order.product_name = product;
  match.order.site_name = siteName;
  match.ledger_entry.provider_order_no = identifier;
  match.ledger_entry.other_account = counterparty;
  match.ledger_entry.memo = memo;
  ledger.memo = memo;
  ledger.external_event_id = externalIdentifier;
  ledger.provider_order_no = identifier;
  ledger.merchant_order_no = merchantIdentifier;
  ledger.other_account = counterparty;
  for (const source of ledger.sources) { source.memo = memo; source.provider_order_no = identifier; source.merchant_order_no = merchantIdentifier; source.other_account = counterparty; }
  for (const item of ledger.matches) item.product_name = product;
  for (const [path, value] of [[notificationPath, notification], [orderPath, order], [matchPath, match], [ledgerPath, ledger]] as const) await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: value } }));
  for (const item of ledger.matches) {
    const path = "/api/admin/v1/reconciliation/matches/" + item.payment_match_id;
    const full = item.payment_match_id === match.payment_match_id ? match : structuredClone(await data<PaymentMatchDetail>(page, manifest, path));
    full.order.product_name = product;
    full.order.site_name = siteName;
    await page.route(manifest.origin + path, route => route.fulfill({ status: 200, json: { data: full } }));
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await layout(page, theme, "compact");
    for (const scenario of scenarios) {
      await openDetail(page, manifest, scenario.key);
      if (scenario.kind === "ledger") await readDetailSection(page, /^对应订单/);
      else await readDetailSection(page, "关联订单");
      const orderOwner = scenario.kind === "ledger"
        ? detailSection(page, "payments").locator(`article[id="match-${ledger.matches[0]!.payment_match_id}"]`)
        : detailSection(page, "order").locator("article[data-sub-record]");
      const factsOwner = scenario.kind === "ledger" ? detailSection(page, "transaction")
        : scenario.kind === "notification" ? detailSection(page, "overview")
          : detailSection(page, "ledger");
      const title = orderOwner.getByRole("heading", { level: 3 });
      await expect(title).toHaveText(product);
      const bounds = await title.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        return { textHeight: text.height, boxHeight: box.height, textRight: text.right, boxRight: box.right };
      });
      expect(bounds.textHeight).toBeLessThanOrEqual(bounds.boxHeight + 1);
      expect(bounds.textRight).toBeLessThanOrEqual(bounds.boxRight + 1);
      if (scenario.kind === "ledger") await readDetailSection(page, "交易信息");
      else if (scenario.kind === "match") await readDetailSection(page, "支付宝流水");
      await expect(factsOwner.locator("dd").filter({ hasText: "第三行：可见末尾标记" })).toHaveText(memo);
      if (scenario.kind === "notification") {
        await expect(factsOwner.getByText(targetUrl, { exact: true })).toBeVisible();
        await factsOwner.getByRole("button", { name: "复制通知地址", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(targetUrl);
      } else {
        await expect(factsOwner.getByText(identifier, { exact: true })).toBeVisible();
        if (scenario.kind === "ledger") {
          for (const [name, value] of [["支付宝流水号", externalIdentifier], ["支付宝订单号", identifier], ["支付宝商户单号", merchantIdentifier]]) {
            const credential = detailSection(page, "transaction");
            await expect(credential.getByText(value!, { exact: true })).toBeVisible();
            await credential.getByRole("button", { name: "复制" + name, exact: true }).click();
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
          }
        }
      }
      const longFacts = scenario.kind === "notification" ? [["业务网站", siteName]] : scenario.kind === "match" ? [["业务网站", siteName], ["对方", counterparty]] : [["对方", counterparty]];
      const wrappedFacts = [];
      for (const [name, value] of longFacts) {
        const fieldOwner = name === "业务网站" && scenario.kind === "match" ? orderOwner : factsOwner;
        if (fieldOwner === orderOwner) await readDetailSection(page, "关联订单");
        else if (scenario.kind === "match") await readDetailSection(page, "支付宝流水");
        const field = fieldOwner.locator("dt").filter({ hasText: new RegExp("^" + name + "$") }).locator("..");
        await expect(field).not.toHaveAttribute("data-field-wide", "true");
        await expect(field.locator("dd")).toHaveText(value!);
        const wrapped = await field.evaluate(completeFieldGeometry);
        expect(wrapped.characterText).toBe(value!.replace(/\s/gu, ""));
        if (wrapped.hangingWhitespace.length || wrapped.textRight > wrapped.boxRight + 1) await info.attach(`text-bounds-${scenario.key}-${width}-${theme}-${name}`, {
          body: JSON.stringify(wrapped, null, 2), contentType: "application/json",
        });
        expect(wrapped.fieldWidth, "long facts wrap inside their available content width").toBeLessThanOrEqual(wrapped.containerWidth + 1);
        expect(wrapped.valueHeight).toBeGreaterThan(wrapped.lineHeight * 2);
        expect(wrapped.textRight).toBeLessThanOrEqual(wrapped.boxRight + 1);
        expect(wrapped.textBottom).toBeLessThanOrEqual(wrapped.boxBottom + 1);
        wrappedFacts.push(wrapped);
      }
      const flows = await readingFlowGeometry(page, true);
      await record(page, info, { feature: "detail-long-content", evidence: "synthetic-response-variants", width, theme, scenario: scenario.key, bounds, wrappedFacts, flows, notificationUrlLength: targetUrl.length });
      await screenshot(page, info, `reading-long-${scenario.key}-${width}-${theme}`);
    }
  }
});
