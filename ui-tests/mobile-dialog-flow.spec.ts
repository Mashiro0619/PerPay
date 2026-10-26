import type { Locator, Page } from "@playwright/test";
import { test, expect, login, record } from "./fixtures";
import { expectTouchTarget } from "./touch-targets";

async function reveal(target: Locator, page: Page) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.clock.runFor(100);
  expect(await target.evaluate(element => element.closest<HTMLElement>("[data-admin-dialog]")!.scrollTop), "revealing a field keeps the close-control shell stationary").toBe(0);
  return expectTouchTarget(target);
}

async function scrollRegion(dialog: Locator) {
  const scroll = dialog.locator("[data-admin-dialog-scroll]");
  await expect(scroll).toHaveAttribute("data-scrollable", "true");
  const geometry = await scroll.evaluate(element => ({
    height: element.clientHeight, scrollHeight: element.scrollHeight,
    width: element.clientWidth, scrollWidth: element.scrollWidth,
    top: element.getBoundingClientRect().top,
    parentPadding: getComputedStyle(element.parentElement!).padding,
  }));
  expect(geometry.height, "the common scroller retains usable content space").toBeGreaterThanOrEqual(64);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
  await expect(dialog.locator("[data-admin-dialog-scroll] [data-slot=dialog-close]")).toHaveCount(0);
  return geometry;
}

async function readableAction(target: Locator) {
  const text = await target.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const content = range.getBoundingClientRect(), box = element.getBoundingClientRect();
    return { top: content.top - box.top, bottom: content.bottom - box.top, left: content.left - box.left, right: content.right - box.left, width: box.width, height: box.height };
  });
  expect(text.left).toBeGreaterThanOrEqual(-1);
  expect(text.top).toBeGreaterThanOrEqual(-1);
  expect(text.right).toBeLessThanOrEqual(text.width + 1);
  expect(text.bottom).toBeLessThanOrEqual(text.height + 1);
}

test.describe("enlarged admin dialogs keep fields and decisions reachable", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 560 }, reducedMotion: "reduce" });

  for (const [width, height, font] of [[320, 560, 200], [360, 560, 200], [640, 280, 150], [640, 280, 200]] as const) {
    test(`${width}x${height}, ${font}% root text: reveal, form and reason dialogs`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await page.route("**/api/admin/v1/settings/secrets/provider_public_key/actions/reveal", route => route.fulfill({
        json: { data: { value: "synthetic-public-key-for-enlarged-dialog-regression" } },
        headers: { "Cache-Control": "no-store" },
      }));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
      });
      await login(page, manifest);
      await page.goto(manifest.origin + "/admin/settings/security");
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
      await page.evaluate(font => {
        document.documentElement.style.fontSize = font + "%";
        delete document.documentElement.dataset.perpayDemo;
      }, font);
      const trigger = page.getByRole("button", { name: "查看支付宝公钥", exact: true });
      await trigger.click();
      const secret = page.getByRole("dialog", { name: "支付宝公钥", exact: true });
      await expect(secret.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue("synthetic-public-key-for-enlarged-dialog-regression");
      const secretScroll = await scrollRegion(secret);
      const copy = secret.getByRole("button", { name: "复制支付宝公钥", exact: true });
      const copyTarget = await reveal(copy, page);
      await expectTouchTarget(secret.getByRole("button", { name: "关闭对话框", exact: true }));
      await copy.tap();
      await expect(secret.getByRole("status")).toHaveText("已复制");
      const closeSecret = secret.getByRole("button", { name: "关闭", exact: true });
      await reveal(closeSecret, page);
      await closeSecret.tap();
      await expect(secret).toHaveCount(0);
      await expect(trigger).toBeFocused();

      await page.goto(manifest.origin + "/admin/");
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      const actions = page.getByRole("button", { name: "页面操作", exact: true });
      await actions.click();
      const paymentTrigger = page.getByRole("menuitem", { name: "测试收款", exact: true });
      await paymentTrigger.click();
      await expect(page.getByRole("menu", { name: "页面操作", exact: true })).toHaveCount(0);
      const payment = page.getByRole("dialog", { name: "测试收款", exact: true });
      const amount = payment.getByRole("textbox", { name: "测试金额（元）", exact: true });
      await expect(amount).toBeVisible();
      const paymentScroll = await scrollRegion(payment);
      await reveal(amount, page);
      await amount.fill("1.23");
      const create = payment.getByRole("button", { name: "创建测试订单", exact: true });
      await reveal(create, page);
      await readableAction(create);
      // Exercise reachability without creating an order.
      const cancelPayment = payment.getByRole("button", { name: "取消", exact: true });
      await reveal(cancelPayment, page);
      await expectTouchTarget(payment.getByRole("button", { name: "关闭对话框", exact: true }));
      await cancelPayment.tap();
      await expect(payment).toHaveCount(0);
      await expect(actions).toBeFocused();

      await page.goto(manifest.origin + "/admin" + manifest.details.matchManual);
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      const operations = page.getByRole("button", { name: "收款关联记录操作", exact: true });
      await operations.click();
      await page.getByRole("menuitem", { name: "撤销错误关联", exact: true }).click();
      const reasonDialog = page.getByRole("dialog", { name: "撤销收款关联？", exact: true });
      const reason = reasonDialog.getByRole("textbox", { name: "操作理由", exact: true });
      await expect(reason).toBeVisible();
      const reasonScroll = await scrollRegion(reasonDialog);
      await reveal(reason, page);
      await reason.fill("只验证本地弹窗滚动与取消，不提交撤销。");
      const reasonSubmit = reasonDialog.locator('button[type="submit"]');
      await expect(reasonSubmit).toBeEnabled();
      await reveal(reasonSubmit, page);
      await readableAction(reasonSubmit);
      const cancel = reasonDialog.getByRole("button", { name: "取消", exact: true });
      await reveal(cancel, page);
      await expectTouchTarget(reasonDialog.getByRole("button", { name: "关闭对话框", exact: true }));
      await record(page, info, { evidence: "browser touch viewport with enlarged root text; no order/revoke submission", width, height, font, secretScroll, paymentScroll, reasonScroll, copyTarget });
      await cancel.tap();
      await expect(reasonDialog).toHaveCount(0);
      await expect(operations).toBeFocused();
    });
  }
});
