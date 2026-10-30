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
  // Footer Close actions may use DialogClose too; the fixed corner control
  // must remain outside the scroller and independently reachable.
  await expect(dialog.getByRole("button", { name: "关闭对话框", exact: true })).toHaveCount(1);
  await expect(scroll.getByRole("button", { name: "关闭对话框", exact: true })).toHaveCount(0);
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
    test(`${width}x${height}, ${font}% root text: account keys, technical details, form and reason dialogs`, async ({ page, manifest }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = value;
        } } });
      });
      await login(page, manifest);
      const writes: string[] = [];
      page.on("request", request => {
        if (request.url().startsWith(manifest.origin + "/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname);
      });
      const accountsResponse = await page.request.get(manifest.origin + "/api/admin/v1/alipay-accounts");
      expect(accountsResponse.ok()).toBe(true);
      const accounts = await accountsResponse.json() as { data: { id: string; application_public_key: string | null }[] };
      const account = accounts.data.find(item => item.application_public_key);
      expect(account, "the synthetic fixture has a configured account").toBeTruthy();
      const syntheticPublicKey = ["-----BEGIN PUBLIC KEY-----", ...Array.from({ length: 12 }, (_, index) => "SYNTHETIC" + index + "ABCD".repeat(14)), "-----END PUBLIC KEY-----"].join("\n");
      // Preserve the real account read and controls; replace only its public
      // display value with explicitly synthetic long text. No key is changed.
      await page.route(manifest.origin + "/api/admin/v1/alipay-accounts/" + account!.id, async route => {
        const response = await route.fetch();
        const payload = await response.json() as { data: Record<string, unknown> };
        await route.fulfill({ response, json: { ...payload, data: { ...payload.data, application_public_key: syntheticPublicKey } } });
      });
      await page.goto(manifest.origin + "/admin/settings/accounts/" + account!.id);
      await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
      await page.evaluate(font => {
        document.documentElement.style.fontSize = font + "%";
        delete document.documentElement.dataset.perpayDemo;
      }, font);
      const publicText = page.locator("[data-account-key-card]").getByRole("textbox", { name: "可复制内容", exact: true });
      await expect(publicText).toHaveValue(syntheticPublicKey);
      await publicText.scrollIntoViewIfNeeded();
      const publicTextGeometry = await publicText.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        return { height: element.clientHeight, scrollHeight: element.scrollHeight, bottom: element.scrollTop + element.clientHeight, width: element.clientWidth, scrollWidth: element.scrollWidth };
      });
      expect(publicTextGeometry.scrollHeight).toBeGreaterThan(publicTextGeometry.height);
      expect(publicTextGeometry.bottom).toBeGreaterThanOrEqual(publicTextGeometry.scrollHeight - 1);
      expect(publicTextGeometry.scrollWidth).toBeLessThanOrEqual(publicTextGeometry.width + 1);
      const publicCopy = page.getByRole("button", { name: "复制应用公钥", exact: true });
      await publicCopy.scrollIntoViewIfNeeded();
      const publicCopyTarget = await expectTouchTarget(publicCopy);
      await publicCopy.focus();
      await publicCopy.tap();
      await expect(publicCopy).toBeFocused();
      expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(syntheticPublicKey);
      const regenerate = page.getByRole("button", { name: "更换应用密钥", exact: true });
      await regenerate.click();
      const confirmation = page.getByRole("alertdialog", { name: "生成新的应用密钥？", exact: true });
      const confirmKey = confirmation.getByRole("button", { name: "确认", exact: true });
      await reveal(confirmKey, page);
      await readableAction(confirmKey);
      const cancelKey = confirmation.getByRole("button", { name: "取消", exact: true });
      await reveal(cancelKey, page);
      await readableAction(cancelKey);
      await cancelKey.tap();
      await expect(confirmation).toHaveCount(0);
      await expect(regenerate).toBeFocused();
      await expect(publicText).toHaveValue(syntheticPublicKey);

      // The old global secret dialog is retired. The real technical dialog
      // still exercises its shared scroller, copy control and focus return.
      const ledgerPath = manifest.details.ledgerAssociated!;
      await page.route(manifest.origin + "/api/admin/v1" + ledgerPath.replace("/ledger/", "/ledger/entries/"), async route => {
        const response = await route.fetch();
        const payload = await response.json() as { data: Record<string, unknown> };
        await route.fulfill({ response, json: { ...payload, data: { ...payload.data,
          synthetic_layout_evidence: Array.from({ length: 20 }, (_, index) => `Synthetic long JSON row ${index}: ` + "Only local display evidence. ".repeat(8)),
        } } });
      });
      await page.goto(manifest.origin + "/admin" + ledgerPath);
      await page.evaluate(font => document.documentElement.style.fontSize = font + "%", font);
      const trigger = page.getByRole("button", { name: "更多操作，支付宝流水记录操作", exact: true });
      await trigger.click();
      await page.getByRole("menuitem", { name: "技术详情", exact: true }).click();
      const technical = page.getByRole("dialog", { name: "技术详情", exact: true });
      await expect(technical.getByRole("group", { name: "技术详情", exact: true })).toContainText("synthetic_layout_evidence");
      const technicalScroll = await scrollRegion(technical);
      const copy = technical.getByRole("button", { name: "复制内部流水编号（PerPay）", exact: true });
      const copyTarget = await reveal(copy, page);
      await expectTouchTarget(technical.getByRole("button", { name: "关闭对话框", exact: true }));
      await copy.tap();
      await expect(technical.getByRole("status").filter({ hasText: "已复制" })).toHaveText("已复制");
      expect(await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText)).toBe(ledgerPath.split("/").at(-1));
      const closeTechnical = technical.getByRole("button", { name: "关闭", exact: true });
      await reveal(closeTechnical, page);
      await closeTechnical.tap();
      await expect(technical).toHaveCount(0);
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
      const operations = page.getByRole("button", { name: "更多操作，收款关联记录操作", exact: true });
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
      await record(page, info, { evidence: "real account public-key and technical-detail controls; synthetic public-key/long JSON display values; no key/order/revoke submission", width, height, font, publicTextGeometry, publicCopyTarget, technicalScroll, paymentScroll, reasonScroll, copyTarget });
      await cancel.tap();
      await expect(reasonDialog).toHaveCount(0);
      await expect(operations).toBeFocused();
      expect(writes).toEqual([]);
    });
  }
});
