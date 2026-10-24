import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function reveal(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  return expectTouchTarget(target);
}

async function focusedInputIsReachable(target: Locator) {
  await expect(target).toBeFocused();
  const geometry = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const viewport = visualViewport!;
    const scroll = element.closest<HTMLElement>("[data-list-filter-scroll]")!;
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      viewport: { x: viewport.offsetLeft, y: viewport.offsetTop, width: viewport.width, height: viewport.height },
      scrollTop: scroll.scrollTop,
      hit: hit === element || element.contains(hit),
    };
  });
  expect(geometry.hit, "focused invalid input receives a hit in its centre").toBe(true);
  expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.viewport.y - 1);
  expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(geometry.viewport.y + geometry.viewport.height + 1);
  expect(geometry.scrollTop, "the single form scroller reveals the invalid field").toBeGreaterThan(0);
  expect(await target.evaluate(element => element.closest<HTMLElement>('[role="dialog"]')!.scrollTop), "validation does not scroll the close-control shell").toBe(0);
  return geometry;
}

test.describe("mobile list filters edit one staged form", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 560 }, reducedMotion: "reduce" });

  for (const [width, height, font] of [[320, 560, 100], [360, 560, 200], [640, 280, 150]] as const) {
    test(`${width}x${height} at ${font}% text: validates inline fields, cancels drafts and applies once`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/reconciliation?direction=CREDIT&source=overview");
      await expect(page.locator("[data-business-row]").first()).toBeVisible();
      await page.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(page).toHaveURL(/cursor=/);
      const originalUrl = page.url();
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      await page.clock.runFor(100);
      const requests: string[] = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/admin/v1/ledger/entries") requests.push(request.url());
      });

      const trigger = page.getByRole("button", { name: /^筛选与排序/ });
      await trigger.click();
      const panel = page.getByRole("dialog", { name: "筛选与排序", exact: true });
      await expect(panel).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(panel.locator("form form")).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "金额范围", exact: true })).toHaveCount(0);
      const minimum = panel.getByRole("textbox", { name: "最低金额（元）", exact: true });
      const maximum = panel.getByRole("textbox", { name: "最高金额（元）", exact: true });
      const apply = panel.getByRole("button", { name: "应用", exact: true });
      const cancel = panel.getByRole("button", { name: "取消", exact: true });
      await minimum.fill("12.345");
      await expect(minimum).toHaveAttribute("aria-invalid", "true");
      await expect(panel).toContainText("最多保留两位小数");
      await reveal(apply, page);
      await apply.tap();
      await expect(panel).toBeVisible();
      await expect(page).toHaveURL(originalUrl);
      expect(requests).toEqual([]);
      const amountInvalidFocus = await focusedInputIsReachable(minimum);
      await minimum.fill("12.34");
      await maximum.fill("99");

      const date = panel.getByRole("combobox", { name: "交易日期范围", exact: true });
      await reveal(date, page);
      await date.tap();
      await page.getByRole("option", { name: "自定义日期", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      const dates = panel.getByRole("group", { name: "交易日期", exact: true });
      const from = dates.getByLabel("开始日期", { exact: true });
      const to = dates.getByLabel("结束日期", { exact: true });
      await from.fill("2026-10-05");
      await to.fill("2026-10-01");
      await expect(panel).toContainText("开始日期不能晚于结束日期");
      await reveal(apply, page);
      await apply.tap();
      await expect(panel).toBeVisible();
      const rangeInvalidFocus = await focusedInputIsReachable(from);
      await to.fill("");
      await expect(to).toHaveAttribute("aria-invalid", "true");
      await reveal(apply, page);
      await apply.tap();
      const requiredDateFocus = await focusedInputIsReachable(to);
      await expect(page).toHaveURL(originalUrl);
      expect(requests).toEqual([]);
      await record(page, info, { evidence: "browser touch viewport, inline validation and native focus scrolling", width, height, font, amountInvalidFocus, rangeInvalidFocus, requiredDateFocus });
      await reveal(cancel, page);
      await cancel.tap();
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await trigger.click();
      await expect(minimum).toHaveValue("");
      await expect(maximum).toHaveValue("");
      await expect(date.locator('[data-slot="select-value"]')).toHaveText("全部");
      await expect(panel.getByLabel("开始日期", { exact: true })).toHaveCount(0);
      await minimum.fill("12.34");
      await maximum.fill("99");
      await reveal(date, page);
      await date.tap();
      await page.getByRole("option", { name: "自定义日期", exact: true }).click();
      await from.fill("2026-10-01");
      await to.fill("2026-10-15");
      await reveal(panel.getByRole("combobox", { name: "排序字段", exact: true }), page);
      await panel.getByRole("combobox", { name: "排序字段", exact: true }).tap();
      await page.getByRole("option", { name: "交易金额", exact: true }).click();
      await reveal(apply, page);
      const applyGeometry = await expectTouchTarget(apply);
      await apply.tap();
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect.poll(() => requests.length).toBe(1);
      const search = new URL(page.url()).searchParams;
      expect(search.get("min_amount_cents")).toBe("1234");
      expect(search.get("max_amount_cents")).toBe("9900");
      expect(search.get("occurred_from")).toBe("2026-10-01");
      expect(search.get("occurred_to")).toBe("2026-10-15");
      expect(search.get("sort_by")).toBe("amount_cents");
      expect(search.get("source")).toBe("overview");
      expect(search.has("cursor")).toBe(false);
      expect(search.has("page")).toBe(false);
      const requested = new URL(requests[0]!).searchParams;
      expect(requested.get("min_amount_cents")).toBe("1234");
      expect(requested.get("occurred_from")).toBe("2026-10-01");
      await record(page, info, { evidence: "browser touch viewport, one Apply commits all inline filters", width, height, font, requests, applyGeometry });
    });
  }
});
