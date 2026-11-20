import type { AuditEventDetail, AuditEventPage } from "../src/shared/audit";
import type { AdminLedgerDetail } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";
import { settleOverlay } from "./overlay-fixtures";
import { closeTechnicalDialog, detailSection, expectDetailRecordLayout, expectTechnicalDialogLayout, expectTechnicalPlacement, openTechnicalDialog, revealDetailSection } from "./detail-layout";

// Cover each responsive transition and both themes without multiplying every
// viewport by every font size, content-width mode and record state.
const layouts = [
  { width: 1440, height: 900, text: 100, theme: "light", mode: "compact" },
  { width: 1440, height: 900, text: 100, theme: "dark", mode: "full" },
  { width: 768, height: 900, text: 100, theme: "light", mode: "compact" },
  { width: 390, height: 844, text: 100, theme: "dark", mode: "compact" },
  { width: 320, height: 560, text: 100, theme: "light", mode: "compact" },
  { width: 1440, height: 480, text: 200, theme: "dark", mode: "compact" },
  { width: 768, height: 480, text: 200, theme: "dark", mode: "compact" },
  { width: 320, height: 560, text: 200, theme: "light", mode: "compact" },
] as const;

test("a settled transaction states Alipay's numbers without unfolding and leads to its stored copy by keyboard", async ({ page, manifest }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, manifest);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
  const path = manifest.details.ledgerAssociated!;
  const response = await page.request.get(manifest.origin + "/api/admin/v1" + path.replace("/ledger/", "/ledger/entries/"));
  expect(response.ok()).toBe(true);
  const entry = (await response.json() as { data: AdminLedgerDetail }).data;
  expect(entry.content_consistent).toBe(true);
  expect(entry.active_match_count).toBe(1);
  expect(entry.has_conflicts).toBe(false);
  expect(entry.sources).toHaveLength(1);
  await page.goto(manifest.origin + "/admin" + path);
  const overlay = await settleOverlay(page);
  // Alipay's numbers stand with the transaction: nothing has to be unfolded to read or to copy them.
  const transaction = detailSection(page, "transaction");
  await expect(overlay.getByRole("button", { name: "支付宝交易编号", exact: true })).toHaveCount(0);
  await expect(transaction.getByText(entry.external_event_id, { exact: true })).toBeVisible();
  const copy = transaction.getByRole("button", { name: "复制支付宝流水号", exact: true });
  await copy.focus();
  await expect(copy.locator("xpath=ancestor::*[@data-field-copy]")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(entry.external_event_id);
  // The stored copy is one section away, reached from the navigation that stays above the content.
  const sourcesLink = overlay.getByRole("navigation", { name: "分区导航", exact: true }).getByRole("button", { name: /^采集记录\s*，共\s*1\s*项$/ });
  await sourcesLink.focus();
  await page.keyboard.press("Enter");
  const sources = detailSection(page, "sources");
  await expect(sources).toBeFocused();
  await expect(sources).toBeInViewport();
  await expect(sourcesLink).toHaveAttribute("aria-current", "true");
  // A single stored copy is the record itself, so there is no separate record of it to look for.
  await expect(sources.locator('article[id^="source-"]')).toHaveCount(0);
  await expect(sources.getByText(entry.active_match!.ledger_entry_id, { exact: true })).toBeVisible();
  await expect(sources.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true })).toBeVisible();
});

for (const layout of layouts) {
  test(`${layout.width}x${layout.height}, ${layout.text}% ${layout.theme}: four record details keep their layout while a secondary dialog shows technical evidence`, async ({ page, manifest }, info) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
    await page.addInitScript(({ theme, mode }) => {
      localStorage.setItem("perpay:theme", theme);
      localStorage.setItem("perpay:content-width", mode);
    }, layout);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: manifest.origin });
    await login(page, manifest);
    const auditResponse = await page.request.get(manifest.origin + "/api/admin/v1/audit-events?source=core&limit=1");
    expect(auditResponse.status()).toBe(200);
    const savedAudit = (await auditResponse.json() as AuditEventPage).data[0];
    expect(savedAudit, "a saved local audit event supplies the real detail identity").toBeTruthy();
    const auditPath = `/audit/${savedAudit!.source}/${savedAudit!.event_id}`;
    const auditDetailResponse = await page.request.get(manifest.origin + "/api/admin/v1" + auditPath.replace("/audit/", "/audit-events/"));
    expect(auditDetailResponse.status()).toBe(200);
    const auditDetail = (await auditDetailResponse.json() as { data: AuditEventDetail }).data;
    // An audit record always states the operation; the other sections follow what was recorded.
    const auditSections = ["overview", ...(auditDetail.is_aggregate ? ["aggregate"] : []), ...(auditDetail.changes.length ? ["changes"] : []),
      ...(auditDetail.related_events.length || auditDetail.related_activity_available === false ? ["related"] : [])];
    // A record with a footer keeps its technical entries in the footer's menu; the others end their content with one entry.
    const scenarios: Array<{ name: string; path: string; copy: string; sections: string[]; technicalSelector?: string; technicalMenu?: { trigger: string; item: string } }> = [
      { name: "order", path: manifest.details.orderLong!, copy: "复制内部订单编号", technicalMenu: { trigger: "更多操作，订单操作", item: "订单技术信息" }, sections: ["overview", "payments", "notifications", "history"] },
      { name: "notification", path: manifest.details.notificationDns!, copy: "复制投递编号", technicalMenu: { trigger: "更多操作，通知记录操作", item: "通知技术信息" }, sections: ["overview", "attempts", "order"] },
      { name: "exception", path: manifest.details.exceptionOpen!, copy: "复制异常编号", technicalMenu: { trigger: "更多操作，异常记录操作", item: "账务异常技术信息" }, sections: ["order", "ledger", "history"] },
      { name: "audit", path: auditPath, copy: "复制日志编号", technicalSelector: '[data-detail-page] > [data-technical-information]', sections: auditSections },
    ];
    const writes: string[] = [], errors: string[] = [];
    page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    for (const scenario of scenarios) {
      await test.step(scenario.name, async () => {
        await page.goto(manifest.origin + "/admin" + scenario.path);
        const overlay = await settleOverlay(page);
        await page.evaluate(percent => document.documentElement.style.fontSize = percent + "%", layout.text);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(100);
        await expect(page.locator("[data-content-width]")).toHaveAttribute("data-content-width", layout.mode);
        const overview = await expectDetailRecordLayout(page);
        await expect(overlay.getByRole("tab")).toHaveCount(0);
        expect(await overlay.locator("[data-detail-section]").evaluateAll(sections => sections.map(section => section.getAttribute("data-detail-section")))).toEqual(scenario.sections);
        if (scenario.name === "notification") {
          await expect(overlay.locator("[data-overlay-detail]").getByRole("heading", { level: 2 })).toHaveText(["投递信息", /^投递尝试/, "关联订单"]);
          // The related order is one sub-record that keeps its business facts, one per row.
          const related = detailSection(page, "order").locator("article[data-sub-record]");
          await expect(related).toHaveCount(1);
          await expect(related.locator("dt")).toHaveText(["商户订单号", "应付金额", "实收金额", "创建时间"]);
          const facts = overview.fields.find(group => group.fields[0]?.name === "商户订单号");
          expect(facts, "the notification retains the related order's business facts").toBeTruthy();
          expect(facts!.rows.every(row => row.length === 1), "related order facts keep one fact per row").toBe(true);
        }
        const id = `${scenario.name}-${layout.width}-${layout.text}-${layout.theme}`;
        if (layout.width !== 320 || layout.text === 200) await screenshot(page, info, "detail-flow-" + id);
        if (scenario.name === "order") await revealDetailSection(page, "history");
        const menu = scenario.technicalMenu;
        // Found by attribute: the page behind an open dialog is hidden from role queries.
        const technical = menu
          ? overlay.locator("[data-overlay-footer]").locator(`button[aria-label="${menu.trigger}"]`)
          : overlay.locator('[data-overlay-detail]').locator(scenario.technicalSelector!);
        await expect(technical).toBeVisible();
        if (menu) await expect(overlay.locator("[data-overlay-detail] [data-technical-information]"), "a record with a footer has no technical entry in its content").toHaveCount(0);
        const placement = menu ? [] : await expectTechnicalPlacement(technical);
        const session = await openTechnicalDialog(page, technical, menu?.item);
        if (scenario.name === "order" && layout.width === 320 && layout.text === 200) {
          // Whichever box scrolls at this size, the record is not at its top.
          const { scroll, contentScroll, primaryScroll } = session.opened.before;
          expect(scroll.top + contentScroll.top + primaryScroll.top, "the long main detail starts this preservation check at a nonzero scroll position").toBeGreaterThan(0);
        }
        await page.keyboard.press("Tab");
        await expect(session.close).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(session.body.getByRole("button", { name: /^复制/ }).first()).toBeFocused();
        await session.body.getByRole("button", { name: scenario.copy, exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(scenario.path.split("/").at(-1));
        const secondary = await expectTechnicalDialogLayout(session, { requireScroll: scenario.name === "order" });
        if (layout.text === 200 || layout.width === 1440) await screenshot(page, info, "detail-technical-dialog-" + id);
        if (layout.width === 320 && layout.text === 200) await audit(page, info, "detail-technical-dialog-" + id);
        const restored = await closeTechnicalDialog(session, layout.theme === "dark" ? "escape" : scenario.name === "audit" ? "footer" : "header");
        const after = await expectDetailRecordLayout(page);
        await record(page, info, { feature: "shared-detail-record-layout", scenario: scenario.name, layout,
          evidence: "named local domain records and saved local audit event; browser font and viewport simulation",
          overview, after, placement, secondary, parentOpened: session.opened, restored });
        if (layout.width === 320 && layout.text === 200) await audit(page, info, "detail-flow-" + id);
      });
    }
    expect(writes, "reading, resizing and copying never submit a business action").toEqual([]);
    expect(errors).toEqual([]);
  });
}

// Only the record's content scrolls. The drawer around it is not a scrolling box, so bringing a section into view cannot carry the title or the actions away.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1440, height: 640 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}x${viewport.height}: section links move the record's content and leave the drawer's title, summary and actions in place`, async ({ page, manifest }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin" + manifest.details.orderPaid!);
    const overlay = await settleOverlay(page);
    const links = overlay.getByRole("navigation", { name: "分区导航", exact: true }).getByRole("button");
    await expect(links).toHaveText([/^订单信息/, /^收款关联/, /^通知/, /^动态/]);
    const ids = ["overview", "payments", "notifications", "history"];
    const frame = (id = "overview") => overlay.evaluate((element, id) => {
      const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().toJSON();
      const detail = element.querySelector<HTMLElement>("[data-overlay-detail]")!;
      return {
        drawer: { scrollTop: element.scrollTop, hiddenHeight: element.scrollHeight - element.clientHeight },
        column: element.querySelector("[data-overlay-primary]")!.scrollTop,
        header: box('[data-overlay-primary] > [data-slot="dialog-header"]'), summary: box("[data-overlay-summary]"), footer: box("[data-overlay-footer]"),
        content: { top: detail.getBoundingClientRect().top, scrollTop: detail.scrollTop, scrollable: detail.scrollHeight - detail.clientHeight,
          atEnd: detail.scrollTop + detail.clientHeight >= detail.scrollHeight - 1 },
        section: element.querySelector(`[data-detail-section="${id}"]`)!.getBoundingClientRect().top,
      };
    }, id);
    const marked = () => links.evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-current") === "true"));
    const initial = await frame();
    expect(initial.content.scrollable, "the record is longer than its drawer").toBeGreaterThan(0);
    // Text for screen readers sits out of flow in the counted headings; it stays inside the content's own scrolling box.
    await expect(detailSection(page, "notifications").locator("h2 .sr-only")).toHaveCount(2);
    expect(initial.drawer.hiddenHeight, "nothing in the content reaches outside the drawer").toBe(0);
    expect(await marked()).toEqual([true, false, false, false]);
    const visited = [];
    for (const index of [2, 3, 1, 0]) {
      await links.nth(index).click();
      await expect(detailSection(page, ids[index]!)).toBeFocused();
      // The chosen section is the marked one, also where the record ends before the section can reach the top.
      await page.clock.runFor(100);
      expect(await marked()).toEqual(ids.map((_, position) => position === index));
      const after = await frame(ids[index]!);
      expect(after.drawer.scrollTop).toBe(0);
      expect(after.column).toBe(0);
      expect(after.header).toEqual(initial.header);
      expect(after.summary).toEqual(initial.summary);
      expect(after.footer).toEqual(initial.footer);
      await expect(detailSection(page, ids[index]!)).toBeInViewport();
      // A later section hides its rule under the top edge, so its title rests where the first section's does. Nothing of the section before it shows.
      const offset = after.section - after.content.top;
      if (index > 0 && !after.content.atEnd) expect(Math.abs(offset)).toBeLessThanOrEqual(1);
      else expect(offset).toBeGreaterThanOrEqual(-1);
      visited.push({ id: ids[index], offset, scrollTop: after.content.scrollTop, atEnd: after.content.atEnd });
    }
    expect(visited.at(-1)!.scrollTop, "the first section returns the content to its start").toBe(0);
    expect(visited.some(visit => !visit.atEnd && visit.id !== "overview"), "at least one later section reaches the top").toBe(true);
    // Once the reader scrolls on their own, the mark follows the position again.
    await overlay.locator("[data-overlay-detail]").hover();
    await page.mouse.wheel(0, 10_000);
    await expect.poll(async () => { await page.clock.runFor(100); return marked(); }).toEqual([false, false, false, true]);
    await page.mouse.wheel(0, -10_000);
    await expect.poll(async () => { await page.clock.runFor(100); return marked(); }).toEqual([true, false, false, false]);
    await record(page, info, { feature: "record-section-links", viewport, visited, evidence: "named local order with a confirmed payment and a notification" });
  });
}
