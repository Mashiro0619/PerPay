import type { AuditEventPage } from "../src/shared/audit";
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

test("settled transaction credentials expand by keyboard without hiding source navigation", async ({ page, manifest }) => {
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
  await page.goto(manifest.origin + "/admin" + path);
  const overlay = await settleOverlay(page);
  const credentials = overlay.getByRole("region", { name: "支付宝交易编号", exact: true });
  const trigger = credentials.getByRole("button", { name: "支付宝交易编号", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(credentials.getByRole("button", { name: "复制支付宝流水号", exact: true })).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await credentials.getByRole("button", { name: "复制支付宝流水号", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(entry.external_event_id);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const sourceLink = overlay.getByRole("link", { name: "核对这份记录", exact: true });
  await sourceLink.click();
  const source = overlay.locator(`[data-ledger-source="${entry.active_match!.ledger_entry_id}"]`);
  await expect(source).toBeFocused();
  await expect(source.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true })).toBeVisible();
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
    const scenarios = [
      { name: "order", path: manifest.details.orderLong!, copy: "复制内部订单编号", technicalSelector: '[data-detail-section="history"] > .detail-section-content > [data-technical-information]', sections: ["overview", "payments", "notifications", "history"] },
      { name: "notification", path: manifest.details.notificationDns!, copy: "复制投递编号", technicalSelector: '[data-notification-information] > [data-slot="card-content"] > [data-technical-information]', sections: ["overview", "attempts", "order"] },
      { name: "exception", path: manifest.details.exceptionOpen!, copy: "复制异常编号", technicalSelector: '[data-financial-exception] > [data-slot="card-content"] > [data-technical-information]', sections: [] },
      { name: "audit", path: `/audit/${savedAudit!.source}/${savedAudit!.event_id}`, copy: "复制日志编号", technicalSelector: '[data-detail-page] > [data-technical-information]', sections: [] },
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
          await expect(detailSection(page, "overview").getByRole("heading", { level: 2 })).toHaveText(["通知信息"]);
          await expect(detailSection(page, "order").getByRole("heading", { level: 2 })).toHaveText(["关联订单"]);
          await expect(detailSection(page, "attempts").getByRole("heading", { name: /^投递尝试/ })).toHaveCount(0);
          if (layout.width === 1440 && layout.text === 100) {
            const summary = overview.fields.find(group => group.orderSummary)!;
            const shortFacts = ["应付金额", "实收金额", "所属网站"];
            expect(summary, "the notification retains the related order's business facts").toBeTruthy();
            expect(summary.fields.filter(field => shortFacts.includes(field.name!))).toHaveLength(shortFacts.length);
            expect(summary.rows.every(row => row.length <= 2), "related order facts follow stable columns instead of packing by text length").toBe(true);
          }
        }
        const id = `${scenario.name}-${layout.width}-${layout.text}-${layout.theme}`;
        if (layout.width !== 320 || layout.text === 200) await screenshot(page, info, "detail-flow-" + id);
        if (scenario.name === "order") await revealDetailSection(page, "history");
        const technical = overlay.locator('[data-overlay-detail]').locator(scenario.technicalSelector);
        await expect(technical).toBeVisible();
        const placement = await expectTechnicalPlacement(technical);
        const session = await openTechnicalDialog(page, technical);
        if (scenario.name === "order" && layout.width === 320 && layout.text === 200) {
          expect(session.opened.before.scroll.top, "the long main detail starts this preservation check at a nonzero scroll position").toBeGreaterThan(0);
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
