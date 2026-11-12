import type { RuntimeSettings, Site } from "../web/src/api/generated/types.gen";
import { test, expect, login, record } from "./fixtures";
import { audit, screenshot } from "./audit";

for (const width of [390, 1440]) test(`${width}: success notifications remain accessible alongside key dialogs`, async ({ page, manifest }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  let settings: RuntimeSettings | undefined;
  let site: Site | undefined;
  const sitePath = manifest.routes.find(path => /^\/sites\/[^/]+$/.test(path) && !["/sites/new", "/sites/defaults"].includes(path))!;
  const savedRevisions: number[] = [];
  await page.route("**/api/admin/v1/settings", async route => {
    if (!settings) {
      settings = (await (await route.fetch()).json()).data;
    }
    await route.fulfill({ json: { data: settings } });
  });
  await page.route("**/api/admin/v1/settings/display", async route => {
    const { revision, ...display } = route.request().postDataJSON();
    expect(revision).toBe(settings!.revision);
    settings = { ...settings!, display: { ...settings!.display, ...display }, revision: revision + 1 };
    savedRevisions.push(settings.revision);
    await route.fulfill({ json: { data: settings } });
  });
  const secret = "synthetic-toast-dialog-secret";
  await page.route("**/api/admin/v1" + sitePath, async route => {
    if (!site) {
      const initial: Site = (await (await route.fetch()).json()).data;
      site = { ...initial, secrets: { ...initial.secrets, api_secret: true, webhook_secret: initial.secrets?.webhook_secret ?? false } };
    }
    await route.fulfill({ json: { data: site } });
  });
  await page.route("**/api/admin/v1" + sitePath + "/secrets/api_secret/actions/rotate", async route => {
    site = { ...site!, revision: site!.revision + 1 };
    await route.fulfill({ json: { data: { site, secret } } });
  });
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/settings/display");
  await page.getByRole("link", { name: "编辑界面显示", exact: true }).click();
  // Only this browser page permits the intercepted synthetic writes; the server stays read-only.
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  const name = page.getByRole("textbox", { name: "支付系统名称", exact: true });
  const save = page.getByRole("button", { name: "保存", exact: true });
  const initialRevision = settings!.revision;
  await name.fill("通知验证一");
  await page.clock.pauseAt(new Date(manifest.epoch + 60_000));
  const firstSaveTick = await page.evaluate(() => performance.now());
  await save.click();
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return savedRevisions.length === 1 && await save.getAttribute("aria-busy") === "false";
  }).toBe(true);
  expect(savedRevisions).toEqual([initialRevision + 1]);
  const success = page.getByRole("dialog", { name: "已保存", exact: true });
  await expect(success).toBeVisible();
  await expect(page.getByRole("region", { name: "提示", exact: true })).toHaveCount(1);
  await page.clock.runFor(1000);
  await name.fill("通知验证二");
  await page.clock.runFor(600);
  // JS clock ticks do not finish the browser's CSS exit animation. Keep the
  // auto-dismiss deadline paused while waiting for the toast to leave the DOM.
  const exitWaitTick = await page.evaluate(() => performance.now());
  expect(exitWaitTick - firstSaveTick, "editing clears the toast before its 4-second auto-dismiss").toBeLessThan(4000);
  await expect(success, "editing the saved form clears its previous success").toHaveCount(0);
  const exitCompleteTick = await page.evaluate(() => performance.now());
  expect(exitCompleteTick, "waiting for CSS completion must not advance the auto-dismiss clock").toBe(exitWaitTick);
  await save.click();
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return savedRevisions.length === 2 && await save.getAttribute("aria-busy") === "false";
  }).toBe(true);
  expect(savedRevisions).toEqual([initialRevision + 1, initialRevision + 2]);
  // Snapshot while the first notification's deadline is still paused; retrying
  // the count could hide duplicates by waiting for the older toast to expire.
  expect(await success.count()).toBe(1);
  await page.clock.runFor(3000);
  await expect(success).toBeVisible();
  await success.hover();
  await page.clock.runFor(5000);
  await expect(success).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5000);
  await expect(success).toBeHidden();

  await page.clock.resume();
  await page.goto(manifest.origin + "/admin" + sitePath + "/settings/integration");
  await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
  await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
  const trigger = page.getByRole("button", { name: "轮换 API 密钥", exact: true });
  await trigger.click();
  await page.getByRole("button", { name: "确认轮换", exact: true }).click();
  const keyDialog = page.getByRole("dialog", { name: "API 密钥", exact: true });
  const keyContent = keyDialog.getByRole("textbox", { name: "API 密钥", exact: true });
  await expect(keyContent).toHaveValue(secret);
  const notification = page.getByRole("dialog", { name: "密钥已生成或轮换，请更新业务网站配置。", exact: true });
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute("aria-modal", "false");
  // Visibility can precede the entrance animation's final position.
  await expect.poll(() => notification.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  }), { message: "the notification lands above the key dialog" }).toBe(true);
  // Test F6 after the dialog's initial autofocus has completed.
  await expect(keyContent).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.getByRole("region", { name: "提示", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(notification).toBeFocused();
  await page.clock.runFor(5000);
  await expect(notification).toBeVisible();
  await expect(keyContent).toHaveValue(secret);
  await expect.poll(() => keyContent.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  }), { message: "the focused notification leaves the displayed key readable" }).toBe(true);
  await record(page, info, {
    width, syntheticSettingsWrites: true, toastAlongsideKey: true,
    toastExitClock: { firstSaveTick, exitWaitTick, exitCompleteTick },
  });
  await screenshot(page, info, "toast-with-key-dialog");
  await audit(page, info, "toast-with-key-dialog");
  await page.keyboard.press("Tab");
  await expect(notification.getByRole("button", { name: "关闭提示", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notification).toBeHidden();
  await expect(keyContent).toHaveValue(secret);
  await expect.poll(() => keyDialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await keyDialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(keyDialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
