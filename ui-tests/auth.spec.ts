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
  await expect(page.getByRole("alert")).toHaveText("管理员密码不正确，请检查后重试。");
  const password = page.locator("#password");
  await expect(password).toBeEnabled();
  await expect(password).toHaveValue("invalid-password");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toHaveAttribute("aria-describedby", "password-error");
  await expect(password).toHaveAccessibleDescription("管理员密码不正确，请检查后重试。");
  await expect(page.getByRole("button", { name: "错误详情" })).toHaveCount(0);
  await expect(page.getByText("请求编号：", { exact: false })).toHaveCount(0);
  await record(page, info, { state: "invalid credentials" });
  await page.locator("#password").fill("123456");
  await expect(password).not.toHaveAttribute("aria-invalid", "true");
  await expect(password).not.toHaveAttribute("aria-describedby");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("[data-content-width]")).toBeVisible();
  await page.route("**/api/admin/v1/session", route => route.fulfill({ status: 503, json: { error: { code: "ui_synthetic_read_failure", message: "合成会话读取失败" } } }));
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("无法检查登录状态");
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await record(page, info, { state: "session read failure" });
  await page.unroute("**/api/admin/v1/session");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator("[data-content-width]")).toBeVisible();
});

test("login retry guidance stays concise while service and configuration failures retain diagnostics", async ({ page, manifest }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(manifest.origin + "/admin/");
  for (const failure of [
    { code: "auth_rate_limited", status: 429, message: "尝试过于频繁，请等待后再试。", retryAfter: 60, diagnostics: false },
    { code: "password_work_busy", status: 503, message: "密码验证服务当前繁忙，请稍后重试。", retryAfter: 1, diagnostics: false },
    { code: "internal_error", status: 500, message: "服务处理失败，请稍后重试。", diagnostics: true },
    { code: "origin_not_allowed", status: 403, message: "请求来源不受信任", diagnostics: true },
  ]) {
    await page.route("**/api/admin/v1/session/login", route => route.fulfill({
      status: failure.status,
      headers: failure.retryAfter ? { "Retry-After": String(failure.retryAfter) } : {},
      json: { error: { code: failure.code, message: failure.message, request_id: "ui-login-diagnostic" } },
    }));
    try {
      await page.locator("#password").fill("synthetic-login-password");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(failure.message);
      await expect(page.locator("#password")).not.toHaveAttribute("aria-invalid", "true");
      if (failure.retryAfter) await expect(page.getByRole("alert")).toContainText(`${failure.retryAfter} 秒后可重试。`);
      if (failure.diagnostics) {
        await page.getByRole("button", { name: "错误详情" }).click();
        await expect(page.getByText("请求编号：ui-login-diagnostic", { exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "错误详情" })).toHaveCount(0);
        await expect(page.getByText(/ui-login-diagnostic/)).toHaveCount(0);
      }
      await record(page, info, { state: "synthetic login " + failure.code });
    } finally {
      await page.unroute("**/api/admin/v1/session/login");
    }
  }
});

test("initialization form exposes validation in the same shell using a synthetic bootstrap state", async ({ page, manifest }, info) => {
  await page.route("**/admin/", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/(name="perpay-initialized" content=")true/, "$1false");
    await route.fulfill({ response, body });
  });
  await page.goto(manifest.origin + "/admin/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/初始化/);
  const token = page.getByLabel("一次性初始化令牌", { exact: true });
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(token).toHaveAttribute("aria-invalid", "true");
  await expect(token).toBeFocused();
  await expect(page.getByText("请输入服务器启动日志中的初始化令牌。", { exact: true })).toBeVisible();
  await token.fill("e".repeat(64));
  await page.locator("#password").fill("123456");
  await page.locator('input[name="password-confirmation"]').fill("different");
  await page.getByRole("button", { name: /初始化|创建管理员/ }).click();
  await expect(page.getByText("两次输入的密码不一致。")).toBeVisible();
  await record(page, info, { state: "synthetic initialization validation", write: false });
  await audit(page, info, "initialization");
});
