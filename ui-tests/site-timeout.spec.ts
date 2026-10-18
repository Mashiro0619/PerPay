import { test, expect, login, record } from "./fixtures";

test("template seconds drafts survive tabs, reject excess precision and save exact milliseconds", async ({ page, manifest }, info) => {
  await login(page, manifest);
  await page.goto(manifest.origin + "/admin/sites/defaults");
  await page.getByRole("tab", { name: "通知策略" }).click();
  await page.getByRole("button", { name: "高级设置" }).click();
  const timeout = page.getByLabel("通知超时（秒）", { exact: true });
  const save = page.getByRole("button", { name: "保存默认模板" });
  await timeout.fill("5.0004");
  await expect(page.getByText("通知超时最多 3 位小数。", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel("最大投递次数", { exact: true }).fill("15");
  await expect(timeout).toHaveValue("5.0004");
  await page.getByRole("tab", { name: "订单设置" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await page.getByRole("tab", { name: "通知策略" }).click();
  await expect(timeout).toHaveValue("5.0004");
  await timeout.fill("5.123");
  expect(await timeout.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  const response = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/settings/site-defaults"));
  await save.click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON().policy.notification_delivery.timeout_milliseconds).toBe(5123);
  await expect(page.getByText("模板已保存，已有网站不受影响。", { exact: true })).toBeVisible();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await record(page, info, { feature: "notification-timeout", width });
    await info.attach(`timeout-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
});
