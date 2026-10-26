import type { Page } from "@playwright/test";
import { test, expect, login, record, type Manifest } from "./fixtures";
import { audit, screenshot } from "./audit";
import { expectTouchTarget } from "./touch-targets";
import type { AdminLedgerDetail, AdminOrderDetail, PaymentMatchDetail, WebhookAttempt, WebhookDeliveryDetail } from "../web/src/api/generated/types.gen";

const scenarios = [
  { key: "notificationDns", kind: "notification", heading: "通知详情", tools: "通知记录操作" },
  { key: "matchSite", kind: "match", heading: "收款关联详情", tools: "收款关联记录操作" },
  { key: "ledgerAssociated", kind: "ledger", heading: "流水与对账详情", tools: "支付宝流水记录操作" },
] as const;
const layoutScenarios = [
  ...scenarios,
  { ...scenarios[0], key: "notificationSite" },
  // The former global match detail now resolves to its unified transaction;
  // the legitimate site detail above still exercises the standalone layout.
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
async function openDetail(page: Page, manifest: Manifest, key: string) {
  await page.goto(manifest.origin + "/admin" + detailPath(manifest, key));
  await expect(page.locator("[data-detail-page]")).toBeVisible();
  if (key.startsWith("notification") || key.startsWith("match")) await expect(page.locator("[data-detail-order-summary]")).toBeVisible();
  else await expect(page.locator("[data-ledger-summary]")).toBeVisible();
  await expect(page.locator('#main-content [data-slot="skeleton"]')).toHaveCount(0);
  await expect(page.locator("#main-content [data-detail-identifier]")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function fields(page: Page, names: readonly string[]) {
  const main = page.locator("#main-content");
  for (const name of names) await expect(main.locator("dt").filter({ hasText: new RegExp("^" + name + "$") }).first()).toBeVisible();
}
async function keyboardTools(page: Page, label: string) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "技术详情", exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "技术详情", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "技术详情", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
async function readingFlowGeometry(page: Page, longContent = false) {
  const layouts = await page.locator('#main-content [data-detail-fields][data-density="comfortable"]').evaluateAll(containers => containers.map(container => ({ layout: container.getAttribute("data-layout"), credentials: !!container.closest("[data-detail-credentials]"), fields: container.querySelector("dl")?.textContent })));
  for (const group of layouts) expect(group.layout === "flow" || (group.layout === "columns" && group.credentials), "comfortable facts must use flow or a credential section: " + group.fields).toBe(true);
  await readingCredentialsGeometry(page);
  const groups = await page.locator('#main-content [data-detail-fields][data-density="comfortable"][data-layout="flow"]').evaluateAll(containers => containers.map(container => {
    const dl = container.querySelector("dl")!;
    const bounds = container.getBoundingClientRect();
    const style = getComputedStyle(dl);
    const fields = Array.from(dl.children).map((field, index) => {
      const term = field.querySelector("dt")!, definition = field.querySelector("dd")!;
      const box = field.getBoundingClientRect(), label = term.getBoundingClientRect(), value = definition.getBoundingClientRect();
      return { index, name: term.textContent, wide: field.getAttribute("data-field-wide") === "true", left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
        labelTop: label.top, valueTop: value.top, actualGap: value.top - label.bottom,
        gap: Number.parseFloat(getComputedStyle(field).rowGap), labelFont: Number.parseFloat(getComputedStyle(term).fontSize), valueFont: Number.parseFloat(getComputedStyle(definition).fontSize) };
    });
    const summary = container.closest("[data-detail-order-summary]");
    const header = summary?.querySelector('[data-slot="item-header"]');
    const title = header?.querySelector('[data-slot="item-title"]')?.getBoundingClientRect();
    const badge = header?.querySelector('[data-slot="item-actions"] [data-slot="badge"]')?.getBoundingClientRect();
    return { width: bounds.width, left: bounds.left, right: bounds.right, layout: container.getAttribute("data-layout"), display: style.display, wrap: style.flexWrap, direction: style.flexDirection,
      rowGap: Number.parseFloat(style.rowGap), columnGap: Number.parseFloat(style.columnGap), fields,
      orderSummary: !!summary, orderHeader: title && badge ? { titleTop: title.top, titleRight: title.right, badgeTop: badge.top, badgeLeft: badge.left } : null };
  }));
  expect(groups.length).toBeGreaterThan(0);
  return groups.map(group => {
    expect(group.layout, "flow facts: " + group.fields.map(field => field.name).join(" / ")).toBe("flow");
    expect(group.display).toBe("flex");
    expect(group.wrap).toBe("wrap");
    expect(group.direction).toBe("row");
    expect(group.rowGap).toBe(16);
    expect(group.columnGap).toBe(24);
    const rows: Array<typeof group.fields> = [];
    for (const field of group.fields) {
      expect(field.labelTop, field.name ?? "field").toBeLessThan(field.valueTop);
      expect(field.gap, field.name ?? "field").toBe(8);
      expect(Math.abs(field.actualGap - 8), field.name ?? "field").toBeLessThanOrEqual(0.5);
      expect(field.labelFont, field.name ?? "field").toBeGreaterThanOrEqual(14);
      expect(field.valueFont, field.name ?? "field").toBeGreaterThanOrEqual(14);
      expect(field.left, field.name ?? "field").toBeGreaterThanOrEqual(group.left - 1);
      expect(field.right, field.name ?? "field").toBeLessThanOrEqual(group.right + 1);
      if (field.wide || group.width < 640) expect(Math.abs(field.width - group.width), field.name ?? "field").toBeLessThanOrEqual(1);
      else {
        expect(field.width, field.name ?? "field").toBeGreaterThanOrEqual(191);
        expect(field.width, field.name ?? "field").toBeLessThanOrEqual(257);
      }
      const previous = group.fields[field.index - 1];
      if (previous) {
        expect(field.top, "DOM reading order: " + field.name).toBeGreaterThanOrEqual(previous.top - 1);
        if (Math.abs(field.top - previous.top) <= 1) expect(field.left).toBeGreaterThan(previous.left);
      }
      const lastRow = rows.at(-1);
      if (lastRow && Math.abs(lastRow[0]!.top - field.top) <= 1) lastRow.push(field);
      else rows.push([field]);
    }
    for (const [index, row] of rows.entries()) {
      expect(row.length).toBeLessThanOrEqual(4);
      expect(Math.abs(row[0]!.left - group.left), "flow rows start at the left edge").toBeLessThanOrEqual(1);
      if (group.width < 640 || row.some(field => field.wide)) expect(row).toHaveLength(1);
      for (let item = 1; item < row.length; item++) expect(Math.abs(row[item]!.left - row[item - 1]!.right - 24)).toBeLessThanOrEqual(1);
      const previous = rows[index - 1];
      if (previous) expect(Math.abs(row[0]!.top - Math.max(...previous.map(field => field.bottom)) - 16), "flow row gap").toBeLessThanOrEqual(1);
    }
    if (group.orderSummary && !longContent) {
      if (group.width >= 640) {
        expect(group.orderHeader).not.toBeNull();
        expect(Math.abs(group.orderHeader!.titleTop - group.orderHeader!.badgeTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(group.orderHeader!.badgeLeft - group.orderHeader!.titleRight - 12)).toBeLessThanOrEqual(1);
      }
      if (group.width >= 840) {
        const facts = group.fields.filter(field => !field.wide);
        expect(facts.map(field => field.name)).toEqual(["应付金额", "实收金额", "所属网站", "创建时间"]);
        expect(facts.every(field => Math.abs(field.top - facts[0]!.top) <= 1)).toBe(true);
      }
    }
    return { ...group, rows: rows.map(row => row.map(field => field.name)) };
  });
}

async function readingCredentialsGeometry(page: Page) {
  const sections = page.locator("#main-content [data-detail-credentials]");
  for (const section of await sections.all()) {
    await expect(section).toBeVisible();
    await expect(section.getByRole("heading")).toBeVisible();
    await expect(section.locator("button[aria-expanded]")).toHaveCount(0);
  }
  const groups = await sections.evaluateAll(sections => sections.map(section => {
    const container = section.querySelector("[data-detail-fields]")!;
    const dl = container.querySelector("dl")!, bounds = container.getBoundingClientRect(), style = getComputedStyle(dl);
    return { width: bounds.width, left: bounds.left, right: bounds.right, layout: container.getAttribute("data-layout"), display: style.display,
      columns: style.gridTemplateColumns.trim().split(/\s+/).length, columnGap: Number.parseFloat(style.columnGap), rowGap: Number.parseFloat(style.rowGap),
      fields: Array.from(dl.children).map(field => {
        const box = field.getBoundingClientRect(), term = field.querySelector("dt")!, value = field.querySelector("dd")!;
        const labelBounds = term.getBoundingClientRect(), valueBounds = value.getBoundingClientRect();
        const textElement = value.querySelector("span.break-all");
        let textBounds = null;
        if (textElement) {
          const range = document.createRange(); range.selectNodeContents(textElement);
          const text = range.getBoundingClientRect(), span = textElement.getBoundingClientRect();
          textBounds = { textHeight: text.height, boxHeight: span.height, textRight: text.right, boxRight: span.right };
        }
        return { name: term.textContent, width: box.width, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          actualGap: valueBounds.top - labelBounds.bottom, scrollWidth: value.scrollWidth, valueWidth: value.clientWidth, textBounds };
      }),
    };
  }));
  for (const group of groups) {
    expect(group.layout).toBe("columns");
    expect(group.display).toBe("grid");
    expect(group.columns).toBe(group.width >= 640 ? 2 : 1);
    expect(group.columnGap).toBe(16);
    expect(group.rowGap).toBe(16);
    const expectedWidth = (group.width - (group.columns - 1) * 16) / group.columns;
    for (const [index, field] of group.fields.entries()) {
      expect(Math.abs(field.width - expectedWidth), field.name ?? "credential").toBeLessThanOrEqual(1);
      expect(Math.abs(field.left - group.left - (index % group.columns) * (expectedWidth + 16))).toBeLessThanOrEqual(1);
      expect(field.right).toBeLessThanOrEqual(group.right + 1);
      expect(Math.abs(field.actualGap - 8)).toBeLessThanOrEqual(0.5);
      expect(field.scrollWidth, field.name ?? "credential").toBeLessThanOrEqual(field.valueWidth + 1);
      if (field.textBounds) {
        expect(field.textBounds.textHeight).toBeLessThanOrEqual(field.textBounds.boxHeight + 1);
        expect(field.textBounds.textRight).toBeLessThanOrEqual(field.textBounds.boxRight + 1);
      }
      const previous = group.fields[index - 1];
      if (previous) {
        expect(field.top).toBeGreaterThanOrEqual(previous.top - 1);
        if (index % group.columns !== 0) expect(Math.abs(field.top - previous.top)).toBeLessThanOrEqual(1);
      }
    }
  }
  return groups;
}

async function readingLayout(page: Page, mode: "compact" | "full") {
  const geometry = await page.locator("#main-content").evaluate(main => {
    const container = main.querySelector<HTMLElement>("[data-content-width]")!;
    const detail = main.querySelector<HTMLElement>("[data-detail-page]")!;
    const cards = Array.from(detail.querySelectorAll<HTMLElement>('[data-slot="card"]'));
    return { width: container.getBoundingClientRect().width, maximum: Number.parseFloat(getComputedStyle(container).maxWidth),
      layout: container.dataset.contentLayout, pageGap: Number.parseFloat(getComputedStyle(detail).rowGap),
      cards: cards.map(card => ({ size: card.dataset.size, title: card.querySelector('[data-slot="card-title"]')?.textContent })),
      timeFonts: Array.from(detail.querySelectorAll(".list-time")).map(time => ({ text: time.textContent, font: Number.parseFloat(getComputedStyle(time).fontSize) })),
      overflowActions: cards.flatMap(card => {
        const box = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll<HTMLElement>('[data-slot="card-action"] a, [data-slot="card-action"] button')).flatMap(action => {
          const bounds = action.getBoundingClientRect();
          return bounds.width && bounds.height && getComputedStyle(action).visibility !== "hidden" && (bounds.left < box.left - 1 || bounds.right > box.right + 1)
            ? [{ label: action.getAttribute("aria-label") ?? action.textContent, left: bounds.left, right: bounds.right, cardLeft: box.left, cardRight: box.right }] : [];
        });
      }),
    };
  });
  const maximum = mode === "compact" ? 1024 : 1280;
  expect(geometry.layout).toBe("detail");
  expect(geometry.maximum).toBe(maximum);
  expect(geometry.width).toBeLessThanOrEqual(maximum);
  if (page.viewportSize()?.width === 2190) expect(geometry.width).toBe(maximum);
  expect(geometry.pageGap).toBe(24);
  expect(geometry.cards.length).toBeGreaterThan(0);
  expect(geometry.cards.filter(card => card.size !== "default")).toEqual([]);
  expect(geometry.timeFonts.filter(time => time.font < 14)).toEqual([]);
  expect(geometry.overflowActions).toEqual([]);
  return geometry;
}

test("detail pages separate standard cards into a readable business sequence", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, manifest);
  await layout(page, "dark", "compact");
  for (const scenario of [...scenarios, { ...scenarios[0], key: "notificationHttp" }]) {
    await openDetail(page, manifest, scenario.key);
    const headings = page.locator("#main-content").getByRole("heading", { level: 2 });
    if (scenario.kind === "notification") {
      await expect(headings).toHaveText(["关联订单", "通知信息", "投递历史"]);
      await expect(page.getByRole("group", { name: "关联订单", exact: true }).locator("[data-detail-order-summary]")).toBeVisible();
      await expect(page.getByRole("group", { name: "通知信息", exact: true }).getByRole("button", { name: "通知记录操作", exact: true })).toBeVisible();
      await expect(page.getByRole("group", { name: "投递历史", exact: true }).getByRole("heading", { name: "投递尝试（1）", exact: true })).toBeVisible();
    } else if (scenario.kind === "match") {
      await expect(headings).toHaveText(["关联摘要与订单", "支付宝交易", "匹配依据与处理记录"]);
      await expect(page.getByRole("group", { name: "收款关联记录", exact: true }).locator("[data-detail-order-summary]")).toBeVisible();
      await expect(page.getByRole("group", { name: "匹配依据与处理记录", exact: true }).getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
    } else {
      await expect(headings).toHaveText(["支付宝交易", "对应订单", /^查账记录（\d+）$/]);
      await expect(page.locator('[data-detail-page] dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
      await expect(page.locator('[data-ledger-summary] [data-layout="flow"] dt')).toHaveText(["交易金额", "收支方向", "交易时间", "对方", "支付宝备注"]);
      await expect(page.locator('[data-ledger-summary] [data-detail-credentials] dt')).toHaveText(["支付宝流水号", "支付宝订单号", "支付宝商户单号"]);
      await expect(page.locator('[data-ledger-summary] dt').filter({ hasText: /业务网站|PerPay/ })).toHaveCount(0);
      await expect(page.locator("#ledger-conflicts-heading")).toHaveCount(0);
    }
    const geometry = await readingLayout(page, "compact");
    const flows = await readingFlowGeometry(page);
    await record(page, info, { feature: "detail-reading-sections", key: scenario.key, geometry, flows, evidence: "local-synthetic-domain" });
    await screenshot(page, info, "reading-sections-" + scenario.key);
  }
});

test("flow summaries wrap at container boundaries without stretching two facts across a card", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 2190, height: 900 });
  await login(page, manifest);
  await layout(page, "dark", "full");
  await openDetail(page, manifest, "notificationDns");
  const container = page.locator('[data-detail-order-summary] [data-detail-fields]');
  const originalWidth = await container.evaluate(element => (element as HTMLElement).style.width);
  const boundaries = [];
  try {
    for (const requestedWidth of [639, 640, 840, 1024, 1280]) {
      await container.evaluate((element, width) => { (element as HTMLElement).style.width = width + "px"; }, requestedWidth);
      const summary = (await readingFlowGeometry(page)).find(group => group.orderSummary)!;
      expect(summary.width).toBe(requestedWidth);
      if (requestedWidth < 640) expect(summary.rows.every(row => row.length === 1)).toBe(true);
      else if (requestedWidth === 640) {
        expect(summary.rows[0]!.length).toBeGreaterThan(1);
        expect(summary.rows[0]!.length).toBeLessThan(4);
        const short = summary.fields.filter(field => !field.wide);
        expect(short.at(-1)!.top).toBeGreaterThan(short[0]!.top);
      } else expect(summary.rows[0]).toEqual(["应付金额", "实收金额", "所属网站", "创建时间"]);
      boundaries.push({ requestedWidth, actualWidth: summary.width, rows: summary.rows, fieldWidths: summary.fields.map(field => field.width) });
    }
  } finally {
    await container.evaluate((element, width) => { (element as HTMLElement).style.width = width; }, originalWidth);
  }
  await record(page, info, { feature: "detail-flow-container-breakpoints", boundaries, restoredInlineWidth: originalWidth });
  await screenshot(page, info, "reading-flow-boundaries-restored");

  await openDetail(page, manifest, "matchSite");
  const flows = await readingFlowGeometry(page);
  const twoFacts = flows.find(group => group.fields.length === 2 && group.fields.map(field => field.name).join("/") === "关联方式/关联时间");
  expect(twoFacts, "the genuine inferred match has two short processing facts").toBeTruthy();
  expect(twoFacts!.width).toBeGreaterThanOrEqual(840);
  expect(twoFacts!.rows).toEqual([["关联方式", "关联时间"]]);
  for (const field of twoFacts!.fields) expect(field.width).toBeLessThan(twoFacts!.width / 3);
  expect(twoFacts!.right - twoFacts!.fields.at(-1)!.right).toBeGreaterThan(200);
  await record(page, info, { feature: "detail-flow-two-facts", evidence: "local-synthetic-domain", geometry: twoFacts });
  await screenshot(page, info, "reading-flow-two-facts");

  await openDetail(page, manifest, "ledgerAssociated");
  const credentials = page.locator('[data-ledger-summary] [data-detail-credentials] [data-detail-fields]');
  const originalCredentialsWidth = await credentials.evaluate(element => (element as HTMLElement).style.width);
  const credentialBoundaries = [];
  try {
    for (const requestedWidth of [639, 640, 1024, 1280]) {
      await credentials.evaluate((element, width) => { (element as HTMLElement).style.width = width + "px"; }, requestedWidth);
      const geometry = (await readingCredentialsGeometry(page))[0]!;
      expect(geometry.width).toBe(requestedWidth);
      credentialBoundaries.push({ requestedWidth, columns: geometry.columns, fieldWidths: geometry.fields.map(field => field.width) });
    }
  } finally {
    await credentials.evaluate((element, width) => { (element as HTMLElement).style.width = width; }, originalCredentialsWidth);
  }
  await record(page, info, { feature: "detail-credential-container-breakpoints", credentialBoundaries, restoredInlineWidth: originalCredentialsWidth });
});

test("three detail types retain expanded facts across widths, themes and content modes", async ({ page, manifest }, info) => {
  test.setTimeout(600_000);
  await login(page, manifest);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [320, 390, 1440, 2190]) for (const theme of ["light", "dark"] as const) for (const mode of ["compact", "full"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await layout(page, theme, mode);
    for (const scenario of layoutScenarios) {
      await openDetail(page, manifest, scenario.key);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(scenario.heading);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", mode);
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/);
      if (scenario.kind === "notification") {
        await fields(page, scenario.key === "notificationSite" ? ["下次重试", "通知地址"] : ["所属网站", "下次重试", "通知地址"]);
        await expect(page.getByRole("heading", { name: "投递尝试（1）", exact: true })).toBeVisible();
        await expect(page.getByText(/通知域名解析失败/).first()).toBeVisible();
        await expect(page.locator("[data-detail-order-summary]")).toBeVisible();
      } else if (scenario.kind === "match") {
        await fields(page, ["支付宝交易金额", "支付宝交易时间", "支付宝交易对方", "支付宝订单号", "支付宝交易备注", "金额占用时间"]);
        await expect(page.getByRole("heading", { name: "匹配依据", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "匹配依据", exact: true })).toHaveCount(0);
      } else {
        await fields(page, ["支付宝流水号", "交易金额", "收支方向", "交易时间", "内部流水编号（PerPay）"]);
        await expect(page.locator('#main-content dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
        for (const id of ["ledger-sources-heading", "ledger-matches-heading"]) await expect(page.locator("#" + id)).toBeVisible();
        await expect(page.locator("#ledger-conflicts-heading")).toHaveCount(0);
        await expect(page.locator("[data-ledger-source]").first()).toBeVisible();
        await expect(page.locator("[data-ledger-match]").first()).toBeVisible();
        await expect(page.locator('[data-ledger-summary] [data-detail-credentials]')).toBeVisible();
      }
      const flows = await readingFlowGeometry(page);
      const geometry = await readingLayout(page, mode);
      if (width === 1440) await keyboardTools(page, scenario.tools);
      const id = `reading-${scenario.key}-${width}-${theme}-${mode}`;
      const credentials = await readingCredentialsGeometry(page);
      await record(page, info, { feature: "detail-reading-matrix", width, theme, mode, scenario: scenario.key, flows, credentials, geometry, evidence: "local-synthetic-domain" });
      await screenshot(page, info, id);
      if (width === 320 && mode === "compact") await audit(page, info, id);
    }
  }
  // Exercise the intermediate viewport as well as the explicit container
  // boundaries above; each real fact group chooses its own natural wrapping.
  await page.setViewportSize({ width: 1100, height: 900 });
  await layout(page, "dark", "full");
  await openDetail(page, manifest, "ledgerAssociated");
  await readingFlowGeometry(page);
  await page.setViewportSize({ width: 2190, height: 900 });
  await openDetail(page, manifest, "ledgerAssociated");
  await readingFlowGeometry(page);
  expect(errors).toEqual([]);
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
        const targets = [];
        for (const button of await page.locator('#main-content [class~="group/button"], #main-content [data-slot="button"]').all()) {
          if (!await button.isVisible() || !await button.isEnabled()) continue;
          // Reveal the complete generated touch slot, including its margins.
          await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await page.clock.runFor(100);
          targets.push(await expectTouchTarget(button));
        }
        expect(targets.length).toBeGreaterThan(0);
        await record(page, info, { feature: "detail-touch-targets", width, mode, scenario: scenario.key, targets });
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
    await expect(history.getByRole("heading", { name: `投递尝试（${detail.delivery.attempt_count}）`, exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: /^投递尝试（/ })).toHaveCount(0);
    if (key === "notificationPending") {
      expect(detail.delivery.attempt_count).toBe(0);
      await expect(history.getByText("暂无尝试明细", { exact: true })).toBeVisible();
    }
    if (key === "notificationDns" || key === "notificationSite") await expect(history.getByText(/通知域名解析失败/)).toBeVisible();
    if (key === "notificationHttp") await expect(history.getByText(/HTTP 503/)).toBeVisible();
    if (key === "notificationSite") await expect(page.getByRole("group", { name: "关联订单", exact: true }).locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", new RegExp("^/admin/sites/" + detail.target.api_client_id + "/orders/"));
    if (key === "notificationHistory") {
      expect(detail.is_latest).toBe(false);
      await expect(card.getByText(/历史投递/)).toBeVisible();
      await card.getByRole("button", { name: "通知记录操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "重新发送", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
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
  await expect(page.getByText("已尝试 21 次", { exact: true })).toBeVisible();
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
  const main = page.locator("#main-content");
  const history = page.getByRole("group", { name: "投递历史", exact: true });
  await expect(history.getByText("发送记录读取失败，请重试；这不代表没有发送过。", { exact: true })).toBeVisible();
  await expect(history.locator('[data-slot="card-description"]')).toHaveText("发送记录读取失败");
  await expect(main.getByText("暂无尝试明细", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("table", { name: /^投递尝试/ })).toHaveCount(0);
  await expect(history.getByRole("alert")).toContainText("合成的投递尝试读取失败");
  const beforeRetry = reads;
  unavailable = false;
  await history.getByRole("button", { name: "重试", exact: true }).click();
  await expect(main.getByRole("table", { name: "投递尝试（1）", exact: true })).toBeVisible();
  await expect(main.getByText(/HTTP 503/)).toBeVisible();
  await expect(history.getByText("发送记录读取失败，请重试；这不代表没有发送过。", { exact: true })).toHaveCount(0);
  await expect(history.locator('[data-slot="card-description"]')).toHaveText("投递尝试按时间倒序显示 · 每页 10 条");
  await expect(history.getByRole("alert")).toHaveCount(0);
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
    const card = page.getByRole("group", { name: "收款关联记录", exact: true });
    const scoped = key === "matchSite";
    const transaction = scoped ? page.getByRole("group", { name: "支付宝交易", exact: true }) : page.locator("[data-ledger-summary]");
    const evidence = scoped ? page.getByRole("group", { name: "匹配依据与处理记录", exact: true }) : card.locator("[data-match-evidence]");
    if (!scoped) {
      await expect(page).toHaveURL(manifest.origin + "/admin/reconciliation/transactions/" + match.ledger_entry_id + "#match-" + match.payment_match_id);
      await expect(card.getByText("支付宝交易金额", { exact: true })).toHaveCount(0);
      await expect(card.getByRole("link", { name: "核对这份记录", exact: true })).toHaveAttribute("href", /#source-/);
    }
    await expect(transaction.getByText(match.ledger_entry.provider_order_no!, { exact: true })).toBeVisible();
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
      await fields(page, ["撤销时间", "撤销操作人", "撤销理由"]);
      expect(match.resolution_operation?.reason).toBeTruthy();
      await expect(evidence.locator("dd").filter({ hasText: match.resolution_operation!.reason! })).toBeVisible();
      await card.getByRole("button", { name: "收款关联记录操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "撤销错误关联", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
    } else {
      const trigger = card.getByRole("button", { name: "收款关联记录操作", exact: true });
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
    const orderPrefix = scoped ? "/admin/sites/" + match.order.api_client_id : "/admin";
    await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", orderPrefix + "/orders/" + match.order_id);
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
    await expect(page.locator("[data-ledger-source]")).toHaveCount(entry.sources.length);
    await expect(page.locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
    await expect(page.locator("[data-ledger-conflict]")).toHaveCount(entry.conflicts.length);
    await expect(page.locator("[data-detail-credentials]")).toHaveCount(1 + (entry.content_consistent ? 0 : entry.sources.length) + entry.conflicts.length);
    for (const source of entry.sources) await expect(page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`).getByText(source.ledger_entry_id, { exact: true })).toBeVisible();
    if (key === "ledgerIdentical") { expect(entry.content_consistent).toBe(true); expect(entry.sources.length).toBeGreaterThan(1); }
    if (key === "ledgerDisputed") {
      expect(entry.content_consistent).toBe(false);
      await expect(page.locator("[data-ledger-warning]")).toContainText("账单记录有差异");
      await expect(page.locator("[data-ledger-summary]")).toContainText("有争议");
      for (const source of entry.sources) {
        const card = page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`);
        await expect(card.locator('[data-layout="flow"] dt')).toHaveText(["交易金额", "收支方向", "交易时间", "对方", "保存时间", "支付宝备注"]);
        if (source.memo) await expect(card.getByText(source.memo, { exact: true })).toBeVisible();
        if (source.provider_order_no) await expect(card.getByText(source.provider_order_no, { exact: true })).toBeVisible();
      }
    } else {
      for (const source of entry.sources) {
        const card = page.locator(`[data-ledger-source="${source.ledger_entry_id}"]`);
        await expect(card.locator("[data-detail-fields]").first().locator("dt")).toHaveText(["内部流水编号（PerPay）", "保存时间"]);
        await expect(card.getByRole("link", { name: "查看记录与处理", exact: true })).toHaveCount(0);
        const eligible = source.direction === "CREDIT" && ["UNALLOCATED", "CANDIDATE", "CONFLICT"].includes(source.state);
        const actions = card.locator('[data-slot="item-actions"], [data-slot="card-action"]').first();
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
  await expect(page.locator("[data-ledger-match]")).toHaveCount(entry.matches.length);
  await expect(page.getByText("当前实际关联", { exact: true })).toHaveCount(0);
  for (const match of [settled!, second]) {
    const card = page.locator(`[data-ledger-match="${match.payment_match_id}"]`);
    await expect(card.locator('[data-detail-order-summary] a[href*="/orders/"]')).toHaveAttribute("href", "/admin/orders/" + match.order_id);
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
    { key: "notificationDns", tools: "通知记录操作", values: [["投递编号", notification.delivery.delivery_id], ["事件编号", notification.event.event_id]] },
    { key: "matchInferred", tools: "收款关联记录操作", values: [["关联编号", match.payment_match_id], ["流水编号", match.ledger_entry_id]] },
    { key: "ledgerAssociated", tools: "支付宝流水记录操作", values: [["内部流水编号（PerPay）", ledger.ledger_entry_id]] },
    { key: "ledgerAssociated", tools: "查账记录 1 操作", values: [["支付宝 App ID", source.app_id], ["采集来源标识", source.provider_account_key]] },
  ];
  for (const scenario of cases) {
    await openDetail(page, manifest, scenario.key);
    await expect(page.locator('#main-content dt').filter({ hasText: /^支付宝 App ID$/ })).toHaveCount(0);
    const trigger = page.getByRole("button", { name: scenario.tools, exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "技术详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "技术详情", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "技术详情", exact: true })).toBeFocused();
    for (const [name, value] of scenario.values) {
      expect(value, name).toBeTruthy();
      await dialog.getByRole("button", { name: "复制" + name, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
    await record(page, info, { feature: "detail-technical-identifiers", scenario: scenario.key, tools: scenario.tools, copiedFields: scenario.values.map(([name]) => name), evidence: "local-synthetic-domain" });
    await screenshot(page, info, "reading-technical-" + scenario.tools);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
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
  for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await layout(page, theme, "compact");
    for (const scenario of scenarios) {
      await openDetail(page, manifest, scenario.key);
      const title = page.locator('[data-detail-order-summary] [data-slot="item-title"]').first();
      await expect(title).toHaveText(product);
      const bounds = await title.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
        return { textHeight: text.height, boxHeight: box.height, textRight: text.right, boxRight: box.right };
      });
      expect(bounds.textHeight).toBeLessThanOrEqual(bounds.boxHeight + 1);
      expect(bounds.textRight).toBeLessThanOrEqual(bounds.boxRight + 1);
      await expect(page.locator("dd").filter({ hasText: "第三行：可见末尾标记" }).first()).toHaveText(memo);
      if (scenario.kind === "notification") {
        await expect(page.getByText(targetUrl, { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "复制通知地址", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(targetUrl);
      } else {
        await expect(page.getByText(identifier, { exact: true }).first()).toBeVisible();
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
        const field = page.locator("#main-content dt").filter({ hasText: new RegExp("^" + name + "$") }).first().locator("..");
        await expect(field).not.toHaveAttribute("data-field-wide", "true");
        await expect(field.locator("dd")).toHaveText(value!);
        const wrapped = await field.evaluate(element => {
          const definition = element.querySelector("dd")!;
          const range = document.createRange(); range.selectNodeContents(definition);
          const text = range.getBoundingClientRect(), box = definition.getBoundingClientRect();
          return { name: element.querySelector("dt")!.textContent, fieldWidth: element.getBoundingClientRect().width,
            valueHeight: box.height, lineHeight: Number.parseFloat(getComputedStyle(definition).lineHeight), textRight: text.right, boxRight: box.right, textBottom: text.bottom, boxBottom: box.bottom };
        });
        if (width === 1440) {
          expect(wrapped.fieldWidth).toBeGreaterThanOrEqual(191);
          expect(wrapped.fieldWidth).toBeLessThanOrEqual(257);
        }
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
