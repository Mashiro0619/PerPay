import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";
import type { AdminLedgerPageEnvelope } from "../web/src/api/generated/types.gen";
import { money } from "../web/src/lib/format";

async function readableText(target: Locator) {
  await expect(target).toBeVisible();
  const text = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim() || node.parentElement?.closest('.sr-only, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...[...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
        left: rect.left - bounds.left, top: rect.top - bounds.top,
        right: rect.right - bounds.left, bottom: rect.bottom - bounds.top,
      })));
    }
    return { width: bounds.width, height: bounds.height, lines };
  });
  // scrollHeight includes the enlarged touch pseudo-element; measure only rendered label text.
  expect(text.lines.length).toBeGreaterThan(0);
  expect(text.lines.every(line => line.left >= -1 && line.right <= text.width + 1), "complete control label fits horizontally").toBe(true);
  expect(text.lines.every(line => line.top >= -1 && line.bottom <= text.height + 1), "complete control label fits vertically").toBe(true);
  return { ...text, lineCount: new Set(text.lines.map(line => Math.round(line.top))).size };
}

async function readableControl(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  const geometry = await expectTouchTarget(target);
  return { ...geometry, text: await readableText(target) };
}

test("site periods keep complete single-line labels at desktop widths and enlarged text", async ({ page, manifest }, info) => {
  for (const width of [1280, 1920]) for (const font of [100, 200]) {
    await page.setViewportSize({ width, height: 1000 });
    await login(page, manifest);
    await page.goto(manifest.origin + "/admin/sites");
    await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
    await page.evaluate(() => document.fonts.ready);
    const periods = page.getByRole("group", { name: "经营统计周期", exact: true });
    const labels = [];
    for (const days of [7, 30, 90]) {
      const label = await readableText(periods.getByRole("button", { name: `近 ${days} 天`, exact: true }));
      expect(label.lineCount, `the complete ${days}-day label stays on one line at ${width}px/${font}%`).toBe(1);
      labels.push({ days, ...label });
    }
    const help = page.getByRole("button", { name: "网站经营指标说明", exact: true });
    const periodBox = (await periods.boundingBox())!, helpBox = (await help.boundingBox())!;
    expect(helpBox.x, "the independent information button stays outside the period scroller").toBeGreaterThanOrEqual(periodBox.x + periodBox.width - 1);
    await record(page, info, { width, font, sitePeriodLabels: labels, periodBox, helpBox });
    await info.attach(`site-periods-${width}-${font}`, { body: await periods.screenshot(), contentType: "image/png" });
    await help.click();
    await expect(page.getByText("实收按北京时间的确认时间统计，未扣退款和费用；今天尚未结束。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeFocused();
  }
});

test.describe("mobile list reflow retains complete choices", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  test("320px and 200% text: ledger amounts never overlap their record identity", async ({ page, manifest }, info) => {
    await login(page, manifest);
    const endpoint = "/api/admin/v1/ledger/entries";
    const response = await page.request.get(manifest.origin + endpoint + "?direction=CREDIT&limit=1");
    expect(response.ok()).toBe(true);
    const source = await response.json() as AdminLedgerPageEnvelope;
    expect(source.data.length).toBeGreaterThan(0);
    let amountCents = 99_999_999;
    // Retain a real local record identity; vary only the displayed amount.
    await page.route(manifest.origin + endpoint + "?**", route => route.fulfill({
      status: 200,
      json: { ...source, data: [{ ...source.data[0]!, amount_cents: amountCents }], page: { next_cursor: null } },
    }));
    for (const amount of [99_999_999, 999_999_999_999]) {
      amountCents = amount;
      await page.goto(manifest.origin + "/admin/reconciliation?direction=CREDIT");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const row = page.getByRole("list", { name: "支付宝流水", exact: true }).getByRole("listitem");
      await expect(row).toHaveCount(1);
      const heading = row.locator(".list-summary-heading");
      const amountValue = heading.locator(".list-money");
      await expect(amountValue).toHaveText(money(amount));
      await expect(row.locator("a[data-row-link]")).toHaveText(source.data[0]!.external_event_id);
      await page.evaluate(() => document.fonts.ready);
      await page.clock.runFor(100);
      const geometry = await heading.evaluate(element => {
        const identity = element.querySelector<HTMLElement>(".list-summary-identity")!.getBoundingClientRect();
        const amount = element.querySelector<HTMLElement>(".list-money")!.getBoundingClientRect();
        const frame = element.getBoundingClientRect();
        return { identity: identity.toJSON(), amount: amount.toJSON(), frame: frame.toJSON(),
          overlapWidth: Math.min(identity.right, amount.right) - Math.max(identity.left, amount.left),
          overlapHeight: Math.min(identity.bottom, amount.bottom) - Math.max(identity.top, amount.top) };
      });
      expect(geometry.overlapWidth <= 1 || geometry.overlapHeight <= 1, "the complete money box must not intrude into the record identity even when the page has no horizontal overflow").toBe(true);
      expect(geometry.amount.left).toBeGreaterThanOrEqual(geometry.frame.left - 1);
      expect(geometry.amount.right).toBeLessThanOrEqual(geometry.frame.right + 1);
      await readableText(amountValue);
      const dateField = row.locator(".business-summary-field dd").filter({ has: page.locator("time") }).first();
      const dateGeometry = await dateField.evaluate(element => ({
        height: element.getBoundingClientRect().height,
        contentHeight: element.querySelector("time")!.getBoundingClientRect().height,
        rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      }));
      expect(dateGeometry.height - dateGeometry.contentHeight, "vertical fields must not inherit the old horizontal 8rem flex basis").toBeLessThanOrEqual(dateGeometry.rootFont / 2);
      await record(page, info, { feature: "mobile-ledger-amount-identity-separation", width: 320, rootText: 200, amountCents: amount, geometry, dateGeometry });
    }
  });

  for (const width of [320, 360]) {
    test(`${width}px and 200% text: list pagination, notification statuses and site periods remain operable`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height: 560 });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/orders");
      await expect(page.locator("[data-business-row]").first()).toBeVisible();
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const pager = page.getByRole("navigation", { name: "列表分页", exact: true });
      const next = pager.getByRole("button", { name: "下一页", exact: true });
      const nextGeometry = await readableControl(next, page);
      await next.tap();
      await expect(pager).toContainText("第 2 页");
      const previous = pager.getByRole("button", { name: "上一页", exact: true });
      await expect(previous).toBeEnabled();
      const previousGeometry = await readableControl(previous, page);
      await record(page, info, { evidence: "browser touch viewport with 200% root text", width, pagination: { nextGeometry, previousGeometry } });
      await previous.tap();
      await expect(pager).toContainText("第 1 页");
      await expect.poll(() => new URL(page.url()).searchParams.get("cursor")).toBe(null);

      await page.goto(manifest.origin + "/admin/notifications");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const shortcuts = page.getByRole("group", { name: "通知快捷筛选", exact: true });
      for (const [name, value] of [["等待重试", "RETRY_WAIT"], ["已停止重试", "DEAD_LETTER"], ["全部", null]] as const) {
        const choice = shortcuts.getByRole("button", { name, exact: true });
        const geometry = await readableControl(choice, page);
        await choice.tap();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe(value);
        await record(page, info, { evidence: "browser touch viewport with 200% root text", width, notificationChoice: { name, value, geometry } });
      }

      await page.goto(manifest.origin + "/admin/sites");
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      const periods = page.getByRole("group", { name: "经营统计周期", exact: true });
      for (const days of [7, 30, 90]) {
        const choice = periods.getByRole("button", { name: `近 ${days} 天`, exact: true });
        const geometry = await readableControl(choice, page);
        expect(geometry.text.lineCount, "site period labels stay on one line while the group scrolls").toBe(1);
        const help = page.getByRole("button", { name: "网站经营指标说明", exact: true });
        const periodBox = (await periods.boundingBox())!, helpBox = (await help.boundingBox())!;
        expect(helpBox.x, "scrolling a period does not move it over the information button").toBeGreaterThanOrEqual(periodBox.x + periodBox.width - 1);
        await choice.tap();
        await expect(choice).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe(String(days));
        await record(page, info, { evidence: "browser touch viewport with 200% root text", width, sitePeriod: { days, geometry } });
      }
      const first = periods.getByRole("button", { name: "近 7 天", exact: true });
      await first.tap();
      await first.focus();
      await page.keyboard.press("ArrowRight");
      const middle = periods.getByRole("button", { name: "近 30 天", exact: true });
      await expect(middle).toBeFocused();
      await page.keyboard.press("Space");
      await expect(middle).toHaveAttribute("aria-pressed", "true");
      await expect.poll(() => new URL(page.url()).searchParams.get("range")).toBe("30");
    });
  }
});
