import type { RuntimeSettings } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";

for (const width of [390, 1440]) test(`${width}: success notifications remain accessible alongside key dialogs`, async ({ page, manifest }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let settings: RuntimeSettings | undefined;
  await page.route("**/api/admin/v1/settings", async route => {
    if (!settings) {
      const initial: RuntimeSettings = (await (await route.fetch()).json()).data;
      settings = {
        ...initial, site_mode: false,
        completion: { ...initial.completion, api: true },
        secrets: { ...initial.secrets, api_secret: { configured: true, version: 1, fingerprint: null, masked: "synthetic", updatedAt: null } },
      };
    }
    await route.fulfill({ json: { data: settings } });
  });
  await page.route("**/api/admin/v1/settings/display", async route => {
    const { revision: _revision, ...display } = route.request().postDataJSON();
    settings = { ...settings!, display: { ...settings!.display, ...display }, revision: settings!.revision + 1 };
    await route.fulfill({ json: { data: settings } });
  });
  const secret = "synthetic-toast-dialog-secret";
  await page.route("**/api/admin/v1/settings/api-key/actions/rotate", async route => {
    settings = { ...settings!, revision: settings!.revision + 1 };
    await route.fulfill({ json: { data: { settings, secret, client_id: "default" } } });
  });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/settings/display");
  // Only this browser page permits the intercepted synthetic writes; the server stays read-only.
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  const name = page.getByRole("textbox", { name: "支付系统名称", exact: true });
  const save = page.getByRole("button", { name: "保存", exact: true });
  await name.fill("通知验证一");
  await save.click();
  const success = page.getByRole("dialog", { name: "已保存", exact: true });
  await expect(success).toBeVisible();
  await expect(page.getByRole("region", { name: "通知", exact: true })).toHaveCount(1);
  await page.clock.runFor(3000);
  await name.fill("通知验证二");
  await save.click();
  await expect(success).toHaveCount(1);
  await page.clock.runFor(1500);
  await expect(success).toBeVisible();
  await success.hover();
  await page.clock.runFor(5000);
  await expect(success).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5000);
  await expect(success).toBeHidden();

  await page.goto(manifest.origin + "/admin/settings/security");
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  const trigger = page.getByRole("button", { name: "API 密钥操作", exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "轮换 API 密钥", exact: true }).click();
  await page.getByRole("button", { name: "确认轮换", exact: true }).click();
  const keyDialog = page.getByRole("dialog", { name: "新的API 密钥", exact: true });
  await expect(keyDialog.getByText(secret, { exact: true })).toBeVisible();
  const notification = page.getByRole("dialog", { name: "API 密钥已更新，请同步业务服务端。", exact: true });
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute("aria-modal", "false");
  const topmost = await notification.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  });
  expect(topmost).toBe(true);
  await page.keyboard.press("F6");
  await expect(page.getByRole("region", { name: "通知", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notification).toBeFocused();
  await page.clock.runFor(5000);
  await expect(notification).toBeVisible();
  await record(page, info, { width, syntheticSettingsWrites: true, toastAlongsideKey: true });
  await screenshot(page, info, "toast-with-key-dialog");
  await audit(page, info, "toast-with-key-dialog");
  await page.keyboard.press("Tab");
  await expect(notification.getByRole("button", { name: "关闭通知", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notification).toBeHidden();
  await expect(keyDialog.getByText(secret, { exact: true })).toBeVisible();
  await expect.poll(() => keyDialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await keyDialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(keyDialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
