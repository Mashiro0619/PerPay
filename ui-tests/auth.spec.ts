import { test, expect, record } from "./fixtures";
import { audit, screenshot } from "./audit";

test("login, failed credentials, session loading and recovery have a unique title and clear feedback", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(manifest.origin + "/admin/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("登录管理后台");
    await screenshot(page, info, "login-" + theme); await audit(page, info, "login-" + theme);
  }
  await page.locator("#password").fill("invalid-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("#password")).toBeEnabled();
  await record(page, info, { state: "invalid credentials" });
  await page.locator("#password").fill("123456");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("[data-content-width]")).toBeVisible();
  await page.route("**/api/admin/v1/session", route => route.fulfill({ status: 503, json: { error: { code: "ui_synthetic_read_failure", message: "合成会话读取失败" } } }));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("无法验证管理员会话");
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await record(page, info, { state: "session read failure" });
  await page.unroute("**/api/admin/v1/session");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator("[data-content-width]")).toBeVisible();
});

test("initialization form exposes validation in the same shell using a synthetic bootstrap state", async ({ page, manifest }, info) => {
  await page.route("**/admin/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(name="perpay-initialized" content=")true/, "$1false");
    await route.fulfill({ response, body });
  });
  await page.goto(manifest.origin + "/admin/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/初始化/);
  await page.locator("#password").fill("123456");
  await page.locator('input[name="password-confirmation"]').fill("different");
  await page.getByRole("button", { name: /初始化|创建管理员/ }).click();
  await expect(page.getByText("两次输入的密码不一致。")).toBeVisible();
  await record(page, info, { state: "synthetic initialization validation", write: false });
  await audit(page, info, "initialization");
});
