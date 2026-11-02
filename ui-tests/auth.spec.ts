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
    const body = (await response.text())
      .replace(/(name="perpay-initialized" content=")true/, "$1false")
      .replace(/(name="perpay-setup-token-required" content=")(true|false)/, "$1true");
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

test("initialization without token protection creates an administrator using only the password", async ({ page, manifest }, info) => {
  await page.route("**/admin/", async route => {
    const response = await route.fetch();
    const body = (await response.text())
      // The setup POST below is intercepted; allow this synthetic page to exercise the request body.
      .replace(' data-perpay-demo="readonly"', "")
      .replace(/(name="perpay-initialized" content=")true/, "$1false")
      .replace(/(name="perpay-setup-token-required" content=")(true|false)/, "$1false");
    await route.fulfill({ response, body });
  });
  const requests: unknown[] = [];
  await page.route("**/api/admin/v1/setup", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto(manifest.origin + "/admin/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/初始化/);
  await expect(page.getByLabel("一次性初始化令牌", { exact: true })).toHaveCount(0);
  await page.locator("#password").fill("new-admin-password");
  await page.locator('input[name="password-confirmation"]').fill("different");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.getByText("两次输入的密码不一致。")).toBeVisible();
  expect(requests).toEqual([]);
  await page.locator('input[name="password-confirmation"]').fill("new-admin-password");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("登录管理后台");
  expect(requests).toEqual([{ password: "new-admin-password" }]);
  await record(page, info, { state: "synthetic initialization without token", write: false });
});

for (const state of ["login", "setup"] as const) {
  test(`${state} card spacing and keyboard access survive short viewports and enlarged text`, async ({ page, manifest }, info) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (state === "setup") {
      // The real form is rendered from a synthetic first-start document. No
      // setup request is submitted by this layout and keyboard regression.
      await page.route("**/admin/", async route => {
        const response = await route.fetch();
        const body = (await response.text())
          .replace(/(name="perpay-initialized" content=")true/, "$1false")
          .replace(/(name="perpay-setup-token-required" content=")(true|false)/, "$1true");
        await route.fulfill({ response, body });
      });
    }
    const auth = page.locator("[data-admin-auth]");
    const measure = () => auth.evaluate(element => {
      const bounds = (selector: string) => {
        const target = element.querySelector(selector);
        if (!target) throw new Error("Missing authentication layout element: " + selector);
        const box = target.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const card = element.querySelector<HTMLElement>('[data-slot="card"]')!;
      return {
        card: bounds('[data-slot="card"]'),
        heading: bounds("h1"),
        passwordGroup: bounds('[data-slot="input-group"]'),
        form: bounds("form"),
        brand: bounds("a[href]"),
        theme: bounds('button[aria-label^="外观，当前"]'),
        cardScrollWidth: card.scrollWidth,
        cardClientWidth: card.clientWidth,
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        fontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      };
    });
    const verify = async (width: number, textPercent: number, recovery: "closed" | "open") => {
      const geometry = await measure();
      const { card, heading, passwordGroup, form, brand, theme } = geometry;
      expect(card.left, "the card remains inside the browser width").toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      for (const [name, box] of [["heading", heading], ["password group", passwordGroup]] as const) {
        expect(box.left - card.left, name + " keeps a real left card inset").toBeGreaterThanOrEqual(16);
        expect(card.right - box.right, name + " keeps a real right card inset").toBeGreaterThanOrEqual(16);
        expect(Math.abs((box.left - card.left) - (card.right - box.right)), name + " has balanced card insets").toBeLessThanOrEqual(1);
      }
      expect(Math.abs(heading.left - passwordGroup.left), "title and password control share their left edge").toBeLessThanOrEqual(1);
      expect(Math.abs(heading.right - passwordGroup.right), "title and password control share their right edge").toBeLessThanOrEqual(1);
      for (const [name, first, second] of [["theme/brand", theme, brand], ["theme/form", theme, form], ["brand/form", brand, form]] as const) {
        const overlapWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const overlapHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        expect(overlapWidth <= 1 || overlapHeight <= 1, name + " never overlap, including on a naturally scrolling page").toBe(true);
      }
      expect(geometry.cardScrollWidth, "the card does not conceal horizontal overflow").toBeLessThanOrEqual(geometry.cardClientWidth + 1);
      expect(geometry.documentWidth, "authentication does not create horizontal page scrolling").toBeLessThanOrEqual(geometry.viewportWidth + 1);
      await record(page, info, { feature: "auth-card-spacing", state, requestedWidth: width, textPercent, recovery,
        evidence: state === "setup" ? "real browser layout with synthetic first-start metadata" : "real browser login layout", geometry });
    };

    for (const width of [320, 390, 1440]) for (const textPercent of [100, 200]) {
      await test.step(`${width}x480 at ${textPercent}% text`, async () => {
        await page.setViewportSize({ width, height: 480 });
        await page.goto(manifest.origin + "/admin/");
        await expect(auth.getByRole("heading", { level: 1 })).toHaveText(state === "login" ? "登录管理后台" : /^初始化 /);
        await expect(auth.locator('[data-slot="input-group"]')).toBeVisible();
        await page.evaluate(percent => { document.documentElement.style.fontSize = percent + "%"; }, textPercent);
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(100);
        await verify(width, textPercent, "closed");

        const password = auth.locator("#password");
        await password.focus();
        await expect(password).toBeFocused();
        await expect(password).toBeInViewport({ ratio: 1 });
        if (state === "login") {
          const recovery = auth.getByRole("button", { name: "忘记密码？", exact: true });
          await recovery.focus();
          await expect(recovery).toBeFocused();
          await page.keyboard.press("Enter");
          await expect(recovery).toHaveAttribute("aria-expanded", "true");
          const help = auth.getByRole("link", { name: "查看恢复步骤", exact: true });
          await page.keyboard.press("Tab");
          await expect(help).toBeFocused();
          await expect(help).toBeInViewport({ ratio: 1 });
          await verify(width, textPercent, "open");
          if (width === 320 && textPercent === 200) await screenshot(page, info, "auth-login-320-enlarged-recovery");
          await page.keyboard.press("Shift+Tab");
          await expect(recovery).toBeFocused();
          await page.keyboard.press("Space");
          await expect(recovery).toHaveAttribute("aria-expanded", "false");
          await expect(help).toHaveCount(0);
        } else if (width === 320 && textPercent === 200) {
          await screenshot(page, info, "auth-setup-320-enlarged");
        }
      });
    }
  });
}
