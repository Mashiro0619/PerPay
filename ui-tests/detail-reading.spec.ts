import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectOverlayTarget, settleOverlay } from "./overlay-fixtures";
import { expectTouchTarget, measureTouchTarget, waitForControlAnimations } from "./touch-targets";
import { closeTechnicalDialog, detailSection, expectDetailFields, expectDetailRecordLayout, expectTechnicalDialogLayout, openTechnicalDialog } from "./detail-layout";
import type { AdminLedgerDetail, AdminOrderDetail, PaymentMatchDetail, WebhookAttempt, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

const scenarios = [
  { key: "notificationDns", kind: "notification", heading: "通知详情", tools: "更多操作，通知记录操作" },
  { key: "matchSite", kind: "match", heading: "收款关联详情", tools: "更多操作，收款关联记录操作" },
  { key: "ledgerAssociated", kind: "ledger", heading: "流水与对账详情", tools: "更多操作，支付宝流水记录操作" },
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
  if (key.startsWith("notification")) await expect(detailSection(page, "overview").locator("[data-detail-order-summary]")).toBeVisible();
  else if (key.startsWith("match")) {
    const target = targetUrl(page);
    const matchId = detailPath(manifest, key).split("/").at(-1)!;
    const owner = target.pathname.startsWith("/sites/") ? detailBody(page).locator("[data-match-summary]") : detailBody(page).locator(`[data-ledger-match="${matchId}"]`);
    await expect(owner.locator("[data-detail-order-summary]")).toBeVisible();
  }
  else await expect(detailBody(page).locator("[data-ledger-summary]")).toBeVisible();
  await expect(detailBody(page).locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(detailBody(page).locator("[data-detail-identifier]")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function fields(owner: Locator, names: readonly string[]) {
  for (const name of names) await expect(owner.locator("dt").filter({ hasText: new RegExp("^" + name + "$") })).toBeVisible();
}

async function expectAttemptHistory(owner: Locator, count: number) {
  const name = `投递尝试（${count}）`;
  const contents = owner.getByRole("table", { name, exact: true }).or(owner.getByRole("list", { name, exact: true }));
  await expect(contents, "the visible history retains its accessible count without a repeated heading").toBeVisible();
  await expect(owner.getByRole("heading", { name, exact: true })).toHaveCount(0);
  return contents;
}
async function technicalSection(page: Page, label: string, sourceId?: string) {
  if (label.includes("支付宝流水记录")) {
    await readDetailSection(page, "交易");
    return detailSection(page, "transaction").locator('[data-ledger-summary] [data-technical-information]');
  }
  if (label.includes("查账记录")) {
    await readDetailSection(page, /^采集记录/);
    expect(sourceId, "technical source tools retain the owning source identity").toBeTruthy();
    return detailSection(page, "sources").locator(`[data-ledger-source="${sourceId}"]`)
      .locator(':scope > [data-slot="item-content"] > [data-technical-information], :scope > [data-slot="card-content"] > [data-technical-information]');
  }
  if (label.includes("通知")) return detailSection(page, "overview").locator('[data-notification-information] [data-technical-information]');
  const matchId = /^#match-(.+)$/.exec(targetUrl(page).hash)?.[1];
  return matchId
    ? detailSection(page, "payments").locator(`[data-ledger-match="${matchId}"] [data-match-summary] > [data-slot="card-content"] > [data-technical-information]`)
    : detailBody(page).locator('[data-match-evidence] > [data-slot="card-content"] > [data-technical-information]');
}
async function keyboardTools(page: Page, label: string) {
  const technical = await technicalSection(page, label);
  const session = await openTechnicalDialog(page, technical);
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
    containerWidth: field.parentElement!.parentElement!.getBoundingClientRect().width,
    height: box.height, valueHeight: box.height, lineHeight: Number.parseFloat(getComputedStyle(value).lineHeight),
    textHeight: bottom - top, boxHeight: textBox.height, textRight: Math.max(...characters.map(character => character.right)), boxRight: textBox.right,
    textBottom: bottom, boxBottom: textBox.bottom, characterCount: characters.length, characterText: characters.map(character => character.text).join(""),
    rawTextRight: raw.right, rawTextHeight: raw.height, hangingWhitespace };
}

async function readingFlowGeometry(page: Page, _longContent = false) {
  const groups = await expectDetailFields(detailBody(page).locator('[data-detail-fields][data-density="comfortable"][data-layout="flow"]:visible'));
  expect(groups.length).toBeGreaterThan(0);
  return groups;
}
async function readingCredentialsGeometry(page: Page) {
  const sections = detailBody(page).locator("[data-detail-credentials]:visible");
  for (const section of await sections.all()) {
    await expect(section).toHaveAccessibleName(/.+/);
    await expect(section.getByRole("heading")).toHaveCount(1);
    await expect(section.locator("button[aria-expanded]")).toHaveCount(0);
  }
  return expectDetailFields(sections.locator("[data-detail-fields]"));
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
async function notificationSectionAlignment(page: Page) {
  const information = detailBody(page).locator('[data-notification-information]:visible');
  if (!await information.count()) return null;
  const summary = detailBody(page).locator('[data-detail-order-summary]');
  await expect(summary).toBeVisible();
  const boxes = await detailBody(page).evaluate(body => {
    const summary = body.querySelector('[data-detail-order-summary]')!;
    const notification = body.querySelector('[data-notification-information]')!;
    return { summaryLeft: summary.getBoundingClientRect().left, summaryFieldsLeft: summary.querySelector('[data-detail-fields]')!.getBoundingClientRect().left,
      notificationLeft: notification.getBoundingClientRect().left, notificationFieldsLeft: notification.querySelector('[data-detail-fields]')!.getBoundingClientRect().left };
  });
  for (const left of [boxes.summaryLeft, boxes.summaryFieldsLeft, boxes.notificationFieldsLeft]) {
    expect(Math.abs(left - boxes.notificationLeft), "related order and notification facts share the same left edge").toBeLessThanOrEqual(1);
  }
  return boxes;
}
async function readingLayout(page: Page, mode: "compact" | "full", alternativeTable?: string) {
  await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
  const geometry = await expectDetailRecordLayout(page, alternativeTable);
  const header = await headerControlsGeometry(page);
  const notificationAlignment = await notificationSectionAlignment(page);
  expect(geometry.cards.length).toBeGreaterThan(0);
  return { ...geometry, header, notificationAlignment };
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
      await expect(detailSection(page, "overview").getByRole("heading", { level: 2 })).toHaveText(["通知信息", "关联订单"]);
      await expect(detailBody(page).getByRole("group", { name: "关联订单", exact: true }).locator("[data-detail-order-summary]")).toBeVisible();
      await expect(detailBody(page).getByRole("group", { name: "通知信息", exact: true }).getByRole("button", { name: "技术信息", exact: true })).toBeVisible();
      await readDetailSection(page, "投递记录");
      await expect(detailSection(page, "attempts").getByRole("heading", { level: 2 })).toHaveText(["投递历史"]);
      await expectAttemptHistory(detailBody(page).getByRole("group", { name: "投递历史", exact: true }), 1);
      await readDetailSection(page, "概况");
    } else if (scenario.kind === "match") {
      await expect(detailBody(page).getByRole("heading", { level: 2 })).toHaveText(["关联摘要与订单", "支付宝交易", "匹配依据与处理记录"]);
      await expect(detailBody(page).getByRole("group", { name: "收款关联记录", exact: true }).locator("[data-detail-order-summary]")).toBeVisible();
      await expect(detailBody(page).getByRole("group", { name: "匹配依据与处理记录", exact: true }).getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
    } else {
      await expect(detailSection(page, "transaction").getByRole("heading", { level: 2 })).toHaveText(["支付宝交易"]);
      await expect(detailBody(page).locator('dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
      await expect(detailBody(page).locator('[data-ledger-summary] > [data-slot="card-content"] > [data-detail-fields] dt')).toHaveText(["交易金额", "收款账号", "收支方向", "交易时间", "对方", "支付宝备注"]);
      await expect(detailBody(page).locator('[data-ledger-summary] [data-detail-credentials] dt')).toHaveText(["支付宝流水号", "支付宝订单号", "支付宝商户单号"]);
      await expect(detailBody(page).locator('[data-ledger-summary] dt').filter({ hasText: /业务网站|PerPay/ })).toHaveCount(0);
      await readDetailSection(page, "收款关联");
      await expect(detailSection(page, "payments").getByRole("heading", { level: 2 })).toHaveText(["对应订单"]);
      await expect(detailBody(page).locator("[data-ledger-match]").first()).toBeVisible();
      await readDetailSection(page, /^采集记录/);
      await expect(detailSection(page, "sources").getByRole("heading", { level: 2 })).toHaveText([/^查账记录（\d+）$/]);
      await expect(detailBody(page).locator("[data-ledger-source]").first()).toBeVisible();
      await expect(detailSection(page, "conflicts")).toHaveCount(0);
      await readDetailSection(page, "交易");
    }
    const geometry = await readingLayout(page, "compact");
    const flows = await readingFlowGeometry(page);
    await record(page, info, { feature: "detail-reading-sections", key: scenario.key, geometry, flows, evidence: "local-synthetic-domain" });
    await screenshot(page, info, "reading-sections-" + scenario.key);
  }
});

test("summaries and credentials wrap at their content widths without stretching short facts", async ({ page, manifest }, info) => {
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
        const samples: Awaited<ReturnType<typeof expectDetailFields>> = [];
        for (const requestedWidth of [320, 480, 720, 960]) {
          await container.evaluate((element, width) => { (element as HTMLElement).style.width = width + "px"; }, requestedWidth);
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
          expect(roomy.rows.some(row => shortFacts.every(name => row.includes(name))), "at least three short facts fit together when their natural widths fit").toBe(true);
          expect(roomy.rows.length, "narrow layouts wrap the same complete facts into more rows").toBeLessThan(narrow.rows.length);
          expect(roomy.height, "content wrapping produces a shorter summary when space is available").toBeLessThan(narrow.height);
          for (const name of shortFacts.slice(0, 2)) {
            const first = narrow.fields.find(field => field.name === name)!, last = roomy.fields.find(field => field.name === name)!;
            expect(first.inline, name + " remains beside its label even in the narrow sample").toBe(true);
            expect(last.inline).toBe(true);
            expect(Math.abs(first.width - last.width), name + " does not grow to fill a fraction of the wider container").toBeLessThanOrEqual(1);
          }
          expect(roomy.fields.find(field => field.name === "商户订单号（业务网站）")?.wide, "the merchant reference uses natural wrapping, not a forced whole row").toBe(false);
        }
      }
    } finally {
      await container.evaluate((element, width) => { (element as HTMLElement).style.width = width; }, originalWidth);
      await page.evaluate(font => document.documentElement.style.fontSize = font, originalFont);
    }
    return wrapping;
  };
  await openDetail(page, manifest, "notificationDns");
  const wrapping = await checkWrapping(page.locator('[data-detail-order-summary] [data-detail-fields]'));
  await record(page, info, { feature: "detail-flow-content-wrapping", wrapping });
  await screenshot(page, info, "reading-flow-wrapping-restored");

  await openDetail(page, manifest, "matchSite");
  const flows = await readingFlowGeometry(page);
  const twoFacts = flows.find(group => group.fields.length === 2 && group.fields.map(field => field.name).join("/") === "关联方式/关联时间");
  expect(twoFacts, "the genuine inferred match has two short processing facts").toBeTruthy();
  expect(twoFacts!.rows).toEqual([["关联方式", "关联时间"]]);
  expect(twoFacts!.fields.every(field => field.inline), "both short facts keep their labels and values on one line").toBe(true);
  const occupiedWidth = twoFacts!.fields.at(-1)!.right - twoFacts!.fields[0]!.left;
  expect(twoFacts!.width - occupiedWidth, "two short facts leave unused space at the row end instead of stretching into halves").toBeGreaterThan(twoFacts!.rootFont);
  await record(page, info, { feature: "detail-flow-two-facts", evidence: "local-synthetic-domain", geometry: twoFacts });
  await screenshot(page, info, "reading-flow-two-facts");

  await openDetail(page, manifest, "ledgerAssociated");
  const credentialWrapping = await checkWrapping(page.locator('[data-ledger-summary] [data-detail-credentials] [data-detail-fields]'));
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
            await fields(detailSection(page, "overview").locator("[data-notification-information]"), scenario.key === "notificationSite" ? ["下次重试", "通知地址"] : ["所属网站", "下次重试", "通知地址"]);
            await expect(detailSection(page, "overview").locator("[data-detail-order-summary]")).toBeVisible();
            await readDetailSection(page, "投递记录");
            await expectAttemptHistory(detailSection(page, "attempts"), 1);
            await expect(detailSection(page, "attempts").getByText(/通知域名解析失败/)).toBeVisible();
            await readingLayout(page, mode, "投递尝试（1）");
            await readDetailSection(page, "概况");
          } else if (scenario.kind === "match") {
            await fields(detailBody(page), ["支付宝交易金额", "支付宝交易时间", "支付宝交易对方", "支付宝订单号", "支付宝交易备注", "金额占用时间"]);
            await expect(page.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
            await expect(page.getByRole("button", { name: "匹配依据", exact: true })).toHaveCount(0);
          } else {
            await readDetailSection(page, "交易");
            await fields(detailSection(page, "transaction"), ["支付宝流水号", "交易金额", "收支方向", "交易时间"]);
            await expect(detailBody(page).locator('dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
            await expect(detailBody(page).locator('[data-ledger-summary] [data-detail-credentials]')).toBeVisible();
            await readingCredentialsGeometry(page);
            await readDetailSection(page, /^采集记录/);
            await expect(detailBody(page).locator("#ledger-sources-heading")).toBeVisible();
            await expect(detailBody(page).locator("[data-ledger-source]").first()).toBeVisible();
            const sourceFacts = detailSection(page, "sources").locator("[data-ledger-source]").first()
              .locator(':scope > [data-slot="item-content"] > [data-detail-fields], :scope > [data-slot="card-content"] > [data-detail-credentials]');
            await fields(sourceFacts, ["内部流水编号（PerPay）"]);
            await readingFlowGeometry(page);
            await readDetailSection(page, "收款关联");
            await expect(detailBody(page).locator("#ledger-matches-heading")).toBeVisible();
            await expect(detailBody(page).locator("[data-ledger-match]").first()).toBeVisible();
            await readingFlowGeometry(page);
            await expect(detailSection(page, "conflicts")).toHaveCount(0);
            await readDetailSection(page, "交易");
          }
          const flows = await readingFlowGeometry(page);
          const geometry = await readingLayout(page, mode);
          const technicalDialog = await keyboardTools(page, scenario.tools);
          const id = `reading-${scenario.key}-${width}-${theme}-${mode}`;
          const credentials = await readingCredentialsGeometry(page);
          await record(page, info, { feature: "detail-reading-matrix", width, theme, mode, scenario: scenario.key, flows, credentials, geometry, technicalDialog, evidence: "local-synthetic-domain" });
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
      for (const scenario of scenarios) {
        await openDetail(page, manifest, scenario.key);
        const headerGeometry = await headerControlsGeometry(page);
        const header = foreground(page).locator('[data-overlay-primary] > [data-slot="dialog-header"]');
        const refreshTouch = await expectTouchTarget(header.getByRole("button", { name: "刷新", exact: true }));
        const closeTouch = await expectTouchTarget(header.getByRole("button", { name: "关闭对话框", exact: true }));
        expect(Math.abs(refreshTouch.width - closeTouch.width)).toBeLessThanOrEqual(1);
        expect(Math.abs(refreshTouch.height - closeTouch.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(refreshTouch.y + refreshTouch.height / 2 - closeTouch.y - closeTouch.height / 2)).toBeLessThanOrEqual(1);
        const targets = [];
        for (const button of await page.locator('[data-overlay-detail] [class~="group/button"], [data-overlay-detail] [data-slot="button"]').all()) {
          if (!await button.isVisible() || !await button.isEnabled()) continue;
          // Reveal the complete generated touch slot, including its margins.
          await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await page.clock.runFor(100);
          targets.push(await expectTouchTarget(button));
        }
        expect(targets.length).toBeGreaterThan(0);
        await record(page, info, { feature: "detail-touch-targets", width, mode, scenario: scenario.key, targets, headerGeometry, headerTargets: [refreshTouch, closeTouch] });
        await screenshot(page, info, `reading-touch-${scenario.key}-${width}-${mode}`);
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
    const card = page.getByRole("group", { name: "通知信息", exact: true });
    const history = page.getByRole("group", { name: "投递历史", exact: true });
    await expect(card.getByText(detail.target.target_url, { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="card-header"]').getByText(`已尝试 ${detail.delivery.attempt_count} 次`, { exact: true })).toBeVisible();
    await expect(card.locator("dt").filter({ hasText: /^尝试次数$/ })).toHaveCount(0);
    if (key === "notificationSite") {
      const order = detailBody(page).locator('[data-detail-order-summary] [data-slot="item-title"] a');
      expect(targetUrl(page, (await order.getAttribute("href"))!).pathname).toBe("/sites/" + detail.target.api_client_id + "/orders/" + detail.event.order_id);
    }
    await readDetailSection(page, "投递记录");
    await expectAttemptHistory(history, detail.delivery.attempt_count);
    await expect(history.getByRole("button", { name: /^投递尝试（/ })).toHaveCount(0);
    if (key === "notificationPending") {
      expect(detail.delivery.attempt_count).toBe(0);
      await expect(history.getByText("暂无尝试明细", { exact: true })).toBeVisible();
    }
    if (key === "notificationDns" || key === "notificationSite") await expect(history.getByText(/通知域名解析失败/)).toBeVisible();
    if (key === "notificationHttp") await expect(history.getByText(/HTTP 503/)).toBeVisible();
    await readDetailSection(page, "概况");
    if (key === "notificationHistory") {
      expect(detail.is_latest).toBe(false);
      await expect(card.getByText(/历史投递/)).toBeVisible();
      await expect(card.getByRole("button", { name: "重新发送", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "更多操作，通知记录操作", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "技术信息", exact: true })).toBeVisible();
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
    await expect(foreground(page).getByRole("heading", { level: 1 })).toHaveText("通知详情");
    await page.clock.runFor(100);
    expect(attemptReads, "history cannot start before the delivery read succeeds").toBe(0);
    release();
    await expect.poll(() => attemptReads).toBe(1);
    await expectAttemptHistory(detailSection(page, "attempts"), detail.delivery.attempt_count);
    await expect(detailSection(page, "overview").locator("[data-notification-information]")).toBeVisible();
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
    await readDetailSection(page, "投递记录");
    await expect(foreground(page).getByRole("tab")).toHaveCount(0);
    await page.clock.runFor(100);
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
  await expect(detailBody(page).getByText("已尝试 21 次", { exact: true })).toBeVisible();
  await readDetailSection(page, "投递记录");
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
  await readDetailSection(page, "投递记录");
  const main = detailBody(page);
  const history = page.getByRole("group", { name: "投递历史", exact: true });
  await expect(history.getByText("发送记录读取失败，请重试；这不代表没有发送过。", { exact: true })).toBeVisible();
  await expect(history.locator('[data-slot="card-description"]')).toHaveText("发送记录读取失败");
  await expect(main.getByText("暂无尝试明细", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("table", { name: /^投递尝试/ })).toHaveCount(0);
  const alert = main.getByRole("alert", { name: "服务连接提示", exact: true });
  await expect(alert).toContainText("合成的投递尝试读取失败");
  const beforeRetry = reads;
  unavailable = false;
  await alert.getByRole("button", { name: "重试", exact: true }).click();
  await expect(main.getByRole("table", { name: "投递尝试（1）", exact: true })).toBeVisible();
  await expect(history.getByText(/HTTP 503/)).toBeVisible();
  await expect(history.getByText("发送记录读取失败，请重试；这不代表没有发送过。", { exact: true })).toHaveCount(0);
  await expect(history.locator('[data-slot="card-description"]')).toHaveText("投递尝试按时间倒序显示 · 每页 10 条");
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
    const card = scoped ? detailBody(page).getByRole("group", { name: "收款关联记录", exact: true })
      : detailSection(page, "payments").locator(`[data-ledger-match="${match.payment_match_id}"]`).getByRole("group", { name: "收款关联记录", exact: true });
    const transaction = scoped ? page.getByRole("group", { name: "支付宝交易", exact: true }) : page.locator("[data-ledger-summary]");
    const evidence = scoped ? page.getByRole("group", { name: "匹配依据与处理记录", exact: true }) : card.locator("[data-match-evidence]");
    if (!scoped) {
      await expectOverlayTarget(page, "/reconciliation/transactions/" + match.ledger_entry_id + "#match-" + match.payment_match_id);
      await expect(card.getByText("支付宝交易金额", { exact: true })).toHaveCount(0);
      const sourceLink = card.getByRole("link", { name: "核对这份记录", exact: true });
      expect(targetUrl(page, (await sourceLink.getAttribute("href"))!).hash).toBe("#source-" + match.ledger_entry_id);
    }
    if (!scoped) await readDetailSection(page, "交易");
    await expect(transaction.getByText(match.ledger_entry.provider_order_no!, { exact: true })).toBeVisible();
    if (!scoped) await readDetailSection(page, "收款关联");
    await expect(card.locator("[data-detail-order-summary]")).toContainText(match.order.merchant_order_no);
    if (match.candidate) {
      await expect(evidence.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
      await expect(evidence.getByText("金额占用时间", { exact: true })).toBeVisible();
    }
    if (match.evidence_type === "MANUAL") {
      await expect(evidence.getByText("管理员人工关联", { exact: true })).toBeVisible();
      expect(match.creation_operation.reason).toBeTruthy();
      await expect(evidence.locator("dd").filter({ hasText: match.creation_operation.reason! })).toBeVisible();
    }
    if (match.status === "REVERSED") {
      await fields(evidence, ["撤销时间", "撤销操作人", "撤销理由"]);
      expect(match.resolution_operation?.reason).toBeTruthy();
      await expect(evidence.locator("dd").filter({ hasText: match.resolution_operation!.reason! })).toBeVisible();
      await expect(card.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "撤销错误关联", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "技术信息", exact: true })).toBeVisible();
    } else {
      const trigger = card.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true });
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
    const orderPrefix = scoped ? "/sites/" + match.order.api_client_id : "";
    const orderLink = card.locator('[data-detail-order-summary] [data-slot="item-title"] a');
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
    await expect(detailSection(page, "transaction").locator("[data-detail-credentials]")).toHaveCount(1);
    if (key === "ledgerDisputed") await expect(detailBody(page).locator("[data-ledger-summary]")).toContainText("有争议");
    await readDetailSection(page, "收款关联");
    await expect(detailBody(page).locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
    if (entry.conflicts.length) {
      await readDetailSection(page, /^冲突/);
      await expect(detailBody(page).locator("[data-ledger-conflict]")).toHaveCount(entry.conflicts.length);
      await expect(detailSection(page, "conflicts").locator("[data-detail-credentials]")).toHaveCount(entry.conflicts.length);
    } else await expect(detailSection(page, "conflicts")).toHaveCount(0);
    await readDetailSection(page, /^采集记录/);
    await expect(detailBody(page).locator("[data-ledger-source]")).toHaveCount(entry.sources.length);
    await expect(detailSection(page, "sources").locator('[data-ledger-source] > [data-slot="card-content"] > [data-detail-credentials]')).toHaveCount(entry.content_consistent ? 0 : entry.sources.length);
    for (const source of entry.sources) {
      const facts = page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`)
        .locator(':scope > [data-slot="item-content"] > [data-detail-fields], :scope > [data-slot="card-content"] > [data-detail-credentials]');
      await expect(facts.getByText(source.ledger_entry_id, { exact: true })).toBeVisible();
    }
    if (key === "ledgerIdentical") { expect(entry.content_consistent).toBe(true); expect(entry.sources.length).toBeGreaterThan(1); }
    if (key === "ledgerDisputed") {
      expect(entry.content_consistent).toBe(false);
      await expect(page.locator("[data-ledger-warning]")).toContainText("账单记录有差异");
      for (const source of entry.sources) {
        const card = page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`);
        const facts = card.locator(':scope > [data-slot="card-content"] > [data-detail-fields]');
        await expect(facts.locator("dt")).toHaveText([...(entry.sources.length === 1 ? ["PerPay 记录状态"] : []), "交易金额", "收支方向", "交易时间", "对方", "保存时间", "支付宝备注"]);
        if (source.memo) await expect(facts.getByText(source.memo, { exact: true })).toBeVisible();
        if (source.provider_order_no) await expect(card.locator(':scope > [data-slot="card-content"] > [data-detail-credentials]').getByText(source.provider_order_no, { exact: true })).toBeVisible();
      }
    } else {
      for (const source of entry.sources) {
        const card = page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`);
        await expect(card.locator(':scope > [data-slot="item-content"] > [data-detail-fields] dt')).toHaveText([...(entry.sources.length === 1 ? ["PerPay 记录状态"] : []), "内部流水编号（PerPay）", "保存时间"]);
        await expect(card.getByRole("link", { name: "查看记录与处理", exact: true })).toHaveCount(0);
        const eligible = source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state);
        const actions = entry.sources.length === 1 ? card.locator(':scope > [data-slot="item-content"] > div.flex.max-w-full') : card.locator(':scope > [data-slot="item-content"] > [data-slot="item-header"] > [data-slot="item-actions"], :scope > [data-slot="card-header"] > [data-slot="card-action"]');
        await expect(actions.getByRole("button", { name: "人工关联收款", exact: true })).toHaveCount(eligible ? 1 : 0);
      }
    }
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
  await expect(page.locator("[data-ledger-warning]")).toContainText(`有 ${entry.active_match_count} 条有效关联`);
  await expect(page.locator("[data-ledger-warning]")).toContainText("无法确定唯一订单");
  await readDetailSection(page, "收款关联");
  await expect(detailBody(page).locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
  await expect(detailBody(page).getByText("当前实际关联", { exact: true })).toHaveCount(0);
  for (const match of [settled!, second]) {
    const card = page.locator(`[data-ledger-match="${match.payment_match_id}"]`);
    const orderLink = card.locator('[data-detail-order-summary] [data-slot="item-title"] a');
    expect(targetUrl(page, (await orderLink.getAttribute("href"))!).pathname).toBe("/orders/" + match.order_id);
    await expect(card.getByText("仍生效 · 存在多条关联", { exact: true })).toBeVisible();
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
  expect(ledger.sources.length).toBeGreaterThan(0);
  const source = ledger.sources[0]!;
  const cases = [
    { key: "notificationDns", tools: "更多操作，通知记录操作", values: [["投递编号", notification.delivery.delivery_id], ["事件编号", notification.event.event_id]] },
    { key: "matchInferred", tools: "更多操作，收款关联记录操作", values: [["关联编号", match.payment_match_id], ["流水编号", match.ledger_entry_id]] },
    { key: "ledgerAssociated", tools: "更多操作，支付宝流水记录操作", values: [["内部流水编号（PerPay）", ledger.ledger_entry_id]] },
    { key: "ledgerAssociated", tools: "更多操作，查账记录 1 操作", sourceId: source.ledger_entry_id, values: [["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key]] },
  ];
  for (const scenario of cases) {
    await openDetail(page, manifest, scenario.key);
    await expect(detailBody(page).locator('dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
    const technical = await technicalSection(page, scenario.tools, "sourceId" in scenario ? scenario.sourceId : undefined);
    const session = await openTechnicalDialog(page, technical);
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
    await screenshot(page, info, "reading-technical-" + scenario.tools);
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
      if (scenario.kind === "ledger") await readDetailSection(page, "收款关联");
      const orderOwner = scenario.kind === "ledger"
        ? detailSection(page, "payments").locator(`[data-ledger-match="${ledger.matches[0]!.payment_match_id}"]`)
        : scenario.kind === "notification" ? detailSection(page, "overview").getByRole("group", { name: "关联订单", exact: true })
          : detailBody(page).getByRole("group", { name: "收款关联记录", exact: true });
      const factsOwner = scenario.kind === "ledger" ? detailSection(page, "transaction").locator("[data-ledger-summary]")
        : scenario.kind === "notification" ? detailSection(page, "overview").locator("[data-notification-information]")
          : detailBody(page).getByRole("group", { name: "支付宝交易", exact: true });
      const title = orderOwner.locator('[data-detail-order-summary] [data-slot="item-title"]');
      await expect(title).toHaveText(product);
      const bounds = await title.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        return { textHeight: text.height, boxHeight: box.height, textRight: text.right, boxRight: box.right };
      });
      expect(bounds.textHeight).toBeLessThanOrEqual(bounds.boxHeight + 1);
      expect(bounds.textRight).toBeLessThanOrEqual(bounds.boxRight + 1);
      if (scenario.kind === "ledger") await readDetailSection(page, "交易");
      await expect(factsOwner.locator("dd").filter({ hasText: "第三行：可见末尾标记" })).toHaveText(memo);
      if (scenario.kind === "notification") {
        await expect(factsOwner.getByText(targetUrl, { exact: true })).toBeVisible();
        await factsOwner.getByRole("button", { name: "复制通知地址", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(targetUrl);
      } else {
        await expect(factsOwner.getByText(identifier, { exact: true })).toBeVisible();
        if (scenario.kind === "ledger") {
          for (const [name, value] of [["支付宝流水号", externalIdentifier], ["支付宝订单号", identifier], ["支付宝商户单号", merchantIdentifier]]) {
            const credential = page.locator('[data-ledger-summary] [data-detail-credentials]');
            await expect(credential.getByText(value!, { exact: true })).toBeVisible();
            await credential.getByRole("button", { name: "复制" + name, exact: true }).click();
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
          }
        }
      }
      const longFacts = scenario.kind === "notification" ? [["所属网站", siteName]] : scenario.kind === "match" ? [["所属网站", siteName], ["支付宝交易对方", counterparty]] : [["对方", counterparty]];
      const wrappedFacts = [];
      for (const [name, value] of longFacts) {
        const fieldOwner = name === "所属网站" && scenario.kind === "match" ? orderOwner : factsOwner;
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
      const credentials = await readingCredentialsGeometry(page);
      await record(page, info, { feature: "detail-long-content", evidence: "synthetic-response-variants", width, theme, scenario: scenario.key, bounds, wrappedFacts, flows, credentials, notificationUrlLength: targetUrl.length });
      await screenshot(page, info, `reading-long-${scenario.key}-${width}-${theme}`);
    }
  }
});
