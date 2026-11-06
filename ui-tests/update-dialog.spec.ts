import { test, expect, type Page } from "@playwright/test";
import { APP_VERSION } from "../src/version";
import { OfficialUpdateChecker, type OfficialUpdate, type OfficialUpdateChannel } from "../src/update/checker";
import { HTTP_TEST_ADMIN_PASSWORD } from "../test/http-fixture";
import { createSettingsServer } from "./settings-server";

const dialog = (page: Page) => page.getByRole("dialog", { name: "发现新版本", exact: true });
const panel = (page: Page) => page.getByRole("region", { name: "官方更新", exact: true });
const updateLink = (page: Page) => page.getByRole("navigation", { name: "全局管理", exact: true })
  .getByRole("link", { name: /运行状态.*有更新/ });
const updateIndicator = (page: Page) => page.locator("[data-update-indicator]");

function update(version: string, epoch: number): OfficialUpdate {
  return {
    status: "update_available", current_version: APP_VERSION, latest_version: version,
    release_url: "https://github.com/Mashiro0619/PerPay/releases/tag/v" + version,
    published_at: new Date(epoch - 86_400_000).toISOString(), checked_at: new Date(epoch).toISOString(),
  };
}

function release(version: string, epoch: number) {
  return { tag_name: "v" + version, html_url: update(version, epoch).release_url,
    published_at: update(version, epoch).published_at, draft: false, prerelease: version.includes("-") };
}

async function acknowledge(page: Page) {
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("button", { name: "知道了", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
}

async function open(page: Page, fixture: Awaited<ReturnType<typeof createSettingsServer>>, path = "/admin/system") {
  await page.context().addCookies(fixture.cookies);
  await page.bringToFront();
  await page.goto(fixture.origin + path);
}

for (const width of [390, 740, 1440]) {
  test(`${width}: a release is announced once across reload, channel changes and login, and can be reopened`, async ({ page }, info) => {
    const epoch = Date.now();
    const checks: { channel: OfficialUpdateChannel; refresh: boolean }[] = [];
    const fixture = await createSettingsServer(epoch, { updateChecker: { check: async (channel = "prerelease", options = {}) => {
      checks.push({ channel, refresh: options.refresh === true });
      return update("1.1.0", epoch);
    } } });
    try {
      await page.setViewportSize({ width, height: 900 });
      if (width === 740) {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.addInitScript(() => localStorage.setItem("perpay:theme", "dark"));
      }
      if (width === 390) {
        await page.route(fixture.origin + "/api/admin/v1/system/status", async route => {
          const response = await route.fetch();
          const payload = await response.json();
          payload.data.status = "degraded";
          payload.data.reconciliation.last_error_code = "reconciliation_storage_error";
          payload.data.reconciliation.consecutive_failures = 2;
          await route.fulfill({ response, json: payload });
        });
      }
      await open(page, fixture);
      await expect(dialog(page)).toContainText("v" + APP_VERSION);
      await expect(dialog(page)).toContainText("v1.1.0");
      await expect(dialog(page).getByRole("link", { name: "查看发布说明", exact: true }))
        .toHaveAttribute("href", update("1.1.0", epoch).release_url);
      await expect(dialog(page).getByRole("link", { name: "更新方法", exact: true }))
        .toHaveAttribute("rel", "noopener noreferrer");
      await page.screenshot({ path: info.outputPath("update-dialog.png"), animations: "disabled" });
      await acknowledge(page);
      await expect(page.getByRole("status", { name: "官方版本更新", exact: true })).toHaveCount(0);
      await expect(panel(page).getByRole("button", { name: "忽略此版本", exact: true })).toBeVisible();
      await panel(page).screenshot({ path: info.outputPath("update-panel-available.png"), animations: "disabled" });
      const sidebarWasHidden = !await page.getByRole("navigation", { name: "全局管理", exact: true }).isVisible();
      if (sidebarWasHidden) await page.getByRole("button", { name: "切换导航", exact: true }).click();
      await expect(updateLink(page)).toBeVisible();
      await expect(updateLink(page).getByText("运行状态", { exact: true })).toBeVisible();
      await expect(updateIndicator(page)).toBeVisible();
      await expect(updateLink(page)).not.toContainText("有更新");
      const runtimeIndicator = page.locator("[data-runtime-notice]");
      await expect(runtimeIndicator.locator("svg")).toBeVisible();
      await expect(updateLink(page)).toHaveAccessibleDescription("已暂停接收新订单");
      await expect(updateLink(page)).not.toContainText("已暂停接收新订单");
      await expect(runtimeIndicator.locator('[data-slot="badge"]')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("update-sidebar.png"), animations: "disabled" });
      if (width === 1440) await updateLink(page).screenshot({ path: info.outputPath("update-navigation.png"), animations: "disabled" });
      if (sidebarWasHidden) await page.keyboard.press("Escape");
      else if (width === 1440) {
        const toggle = page.getByRole("button", { name: "切换导航", exact: true });
        await updateLink(page).focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(updateLink(page)).toBeFocused();
        const tooltip = page.getByRole("tooltip");
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText(/运行状态.*有更新.*已暂停接收新订单/);
        await tooltip.screenshot({ path: info.outputPath("runtime-tooltip.png"), animations: "disabled" });
        await toggle.click();
        await expect(updateLink(page)).toHaveAttribute("aria-label", /运行状态.*有更新/);
        await expect(updateIndicator(page)).toBeVisible();
        await expect(runtimeIndicator.locator("svg")).toBeVisible();
        await updateLink(page).hover();
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText(/运行状态.*有更新.*已暂停接收新订单/);
        await page.screenshot({ path: info.outputPath("update-sidebar-collapsed.png"), animations: "disabled" });
        await toggle.click();
      }
      await panel(page).getByRole("button", { name: "忽略此版本", exact: true }).click();
      await expect(panel(page)).toContainText("（已忽略）");
      await expect(panel(page).getByRole("button", { name: "忽略此版本", exact: true })).toHaveCount(0);
      await panel(page).screenshot({ path: info.outputPath("update-panel-ignored.png"), animations: "disabled" });
      if (sidebarWasHidden) await page.getByRole("button", { name: "切换导航", exact: true }).click();
      await expect(updateLink(page)).toHaveCount(0);
      await expect(updateIndicator(page)).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "全局管理", exact: true })
        .getByRole("link", { name: "运行状态", exact: true })).toBeVisible();
      await expect(runtimeIndicator.locator("svg")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "全局管理", exact: true })
        .getByRole("link", { name: "运行状态", exact: true })).toHaveAccessibleDescription("已暂停接收新订单");
      if (sidebarWasHidden) await page.keyboard.press("Escape");
      await panel(page).getByRole("button", { name: "恢复此通道更新提醒", exact: true }).click();
      await expect(panel(page)).not.toContainText("（已忽略）");
      await page.reload();
      await expect(panel(page)).toContainText("有可用更新：v1.1.0");
      await expect(dialog(page)).toHaveCount(0);

      await panel(page).getByRole("combobox", { name: "检查通道", exact: true }).click();
      await page.getByRole("option", { name: "仅稳定版", exact: true }).click();
      await expect.poll(() => checks.at(-1)?.channel).toBe("stable");
      await expect(panel(page)).toContainText("有可用更新：v1.1.0");
      await expect(dialog(page)).toHaveCount(0);

      const manual = panel(page).getByRole("button", { name: "检查更新", exact: true });
      await manual.click();
      await expect(dialog(page)).toBeVisible();
      expect(checks.at(-1)).toEqual({ channel: "stable", refresh: true });
      await page.keyboard.press("Escape");
      await expect(dialog(page)).not.toBeVisible();
      await expect(manual).toBeFocused();

      const view = panel(page).getByRole("button", { name: "查看更新", exact: true });
      await view.click();
      await expect(dialog(page)).toBeVisible();
      await dialog(page).getByRole("button", { name: "关闭对话框", exact: true }).click();
      await expect(dialog(page)).not.toBeVisible();
      await expect(view).toBeFocused();
      await view.click();
      await expect(dialog(page)).toBeVisible();
      await page.mouse.click(1, 1);
      await expect(dialog(page)).not.toBeVisible();
      await expect(view).toBeFocused();

      if (width === 1440) {
        await page.getByRole("button", { name: /账户菜单$/ }).click();
        await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
        await expect(page.getByRole("heading", { name: "登录管理后台", exact: true })).toBeVisible();
        await page.getByLabel("管理员密码", { exact: true }).fill(HTTP_TEST_ADMIN_PASSWORD);
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await expect(page.getByRole("button", { name: /账户菜单$/ })).toBeVisible();
        await page.goto(fixture.origin + "/admin/system");
        await expect(panel(page)).toContainText("有可用更新：v1.1.0");
        await expect(dialog(page)).toHaveCount(0);
      } else if (width === 390) {
        await page.setViewportSize({ width: 320, height: 560 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await view.click();
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).getByRole("heading", { name: "发现新版本", exact: true })).toBeInViewport();
        expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("update-dialog-320-200pct-top.png"), animations: "disabled" });
        await dialog(page).getByRole("button", { name: "知道了", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("update-dialog-320-200pct.png"), animations: "disabled" });
        await dialog(page).getByRole("button", { name: "忽略此版本", exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog(page).getByRole("button", { name: "忽略此版本", exact: true })).toBeInViewport();
        await acknowledge(page);
        await page.getByRole("button", { name: "切换导航", exact: true }).click();
        await expect(updateLink(page)).toBeVisible();
        await expect(updateIndicator(page)).toBeVisible();
        await expect(updateLink(page)).not.toContainText("有更新");
        const notice = page.locator("[data-runtime-notice]");
        await expect(notice).toBeVisible();
        await updateLink(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("update-sidebar-320-200pct.png"), animations: "disabled" });
        const labelBounds = await updateLink(page).getByText("运行状态", { exact: true }).boundingBox();
        const iconBounds = await updateIndicator(page).boundingBox();
        const noticeBounds = await notice.boundingBox();
        expect(noticeBounds).not.toBeNull();
        for (const bounds of [labelBounds, iconBounds]) {
          expect(bounds).not.toBeNull();
          expect(bounds!.x + bounds!.width <= noticeBounds!.x + 1 ||
            noticeBounds!.x + noticeBounds!.width <= bounds!.x + 1 ||
            bounds!.y + bounds!.height <= noticeBounds!.y + 1 ||
            noticeBounds!.y + noticeBounds!.height <= bounds!.y + 1).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
        await page.keyboard.press("Escape");
      }
      expect(checks[0]).toEqual({ channel: "prerelease", refresh: false });
    } finally { await fixture.close(); }
  });
}

test("versions ignored from runtime remain inspectable after reload and a higher SemVer release is announced", async ({ page }) => {
  const epoch = Date.now();
  let latest = "1.1.0-rc.2";
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => update(latest, epoch) } });
  try {
    await open(page, fixture);
    await expect(dialog(page)).toContainText("v1.1.0-rc.2");
    await acknowledge(page);
    await panel(page).getByRole("button", { name: "忽略此版本", exact: true }).click();
    await expect(updateLink(page)).toHaveCount(0);
    await expect(page.getByRole("status", { name: "官方版本更新", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "运行状态", exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(updateLink(page)).toHaveCount(0);

    await expect(panel(page)).toContainText("v1.1.0-rc.2");
    await expect(panel(page)).toContainText("（已忽略）");
    const restore = panel(page).getByRole("button", { name: "恢复此通道更新提醒", exact: true });
    await expect(restore).toBeVisible();
    await panel(page).getByRole("button", { name: "检查更新", exact: true }).click();
    await acknowledge(page);
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(restore).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    await page.goto(fixture.origin + "/admin/");
    await expect(updateLink(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await updateLink(page).click();
    await panel(page).getByRole("button", { name: "查看更新", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await acknowledge(page);
    await panel(page).getByRole("button", { name: "忽略此版本", exact: true }).click();
    await expect(updateLink(page)).toHaveCount(0);

    latest = "1.1.0-rc.10";
    await page.reload();
    await expect(dialog(page)).toContainText("v1.1.0-rc.10");
    await acknowledge(page);
    await expect(updateLink(page)).toBeVisible();
    await expect(panel(page)).toContainText("v1.1.0-rc.10");
    await expect(panel(page)).not.toContainText("（已忽略）");
  } finally { await fixture.close(); }
});

test("an automatic update waits for a dirty form and its discard confirmation", async ({ page }) => {
  const epoch = Date.now();
  let finish!: (result: OfficialUpdate) => void;
  const pending = new Promise<OfficialUpdate>(resolve => { finish = resolve; });
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => pending } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, fixture, "/admin/settings/collection-policy");
    await page.getByRole("link", { name: "编辑查账设置", exact: true }).click();
    const field = page.getByLabel("查账有效时限（秒）", { exact: true });
    await field.fill("450");
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/admin/v1/system/update");
    finish(update("1.1.0", epoch));
    await response;
    await expect(updateIndicator(page)).toHaveCount(1);
    await expect(field).toHaveValue("450");
    await expect(dialog(page)).toHaveCount(0);
    await page.locator('[data-overlay-content]').getByRole('button', { name: '关闭对话框', exact: true }).click();
    const discard = page.getByRole("alertdialog", { name: "放弃未保存的修改？", exact: true });
    await expect(discard).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await discard.getByRole("button", { name: "放弃修改并继续", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(discard).not.toBeVisible();
    await acknowledge(page);
    await updateLink(page).click();
    await expect(panel(page)).toContainText("v1.1.0");
  } finally { finish(update("1.1.0", epoch)); await fixture.close(); }
});

test("an automatic update waits until a business dialog has closed and restores focus", async ({ page }) => {
  const epoch = Date.now();
  let finish!: (result: OfficialUpdate) => void;
  const pending = new Promise<OfficialUpdate>(resolve => { finish = resolve; });
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => pending } });
  try {
    await page.route("**/api/admin/v1/system/status", async route => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.data.status = "degraded";
      payload.data.reconciliation.last_error_code = "reconciliation_storage_error";
      payload.data.reconciliation.consecutive_failures = 2;
      await route.fulfill({ response, json: payload });
    });
    await open(page, fixture);
    const diagnose = page.getByRole("button", { name: "自动确认收款运行诊断", exact: true });
    await diagnose.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/admin/v1/system/update");
    finish(update("1.1.0", epoch));
    await response;
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    await expect(page.locator('[data-slot="dialog-content"]:visible')).toHaveCount(1);
    await acknowledge(page);
    await expect(diagnose).toBeFocused();
  } finally { finish(update("1.1.0", epoch)); await fixture.close(); }
});

test("an automatic update waits for the mobile navigation sheet", async ({ page }) => {
  const epoch = Date.now();
  let finish!: (result: OfficialUpdate) => void;
  const pending = new Promise<OfficialUpdate>(resolve => { finish = resolve; });
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => pending } });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, fixture);
    await page.getByRole("button", { name: "切换导航", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "导航菜单", exact: true });
    await expect(sheet).toBeVisible();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/admin/v1/system/update");
    finish(update("1.1.0", epoch));
    await response;
    await expect(dialog(page)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await acknowledge(page);
  } finally { finish(update("1.1.0", epoch)); await fixture.close(); }
});

test("an automatic update waits until the destination workspace has finished loading", async ({ page }) => {
  const epoch = Date.now();
  let finish!: (result: OfficialUpdate) => void;
  const pending = new Promise<OfficialUpdate>(resolve => { finish = resolve; });
  let releaseSite!: () => void;
  const heldSite = new Promise<void>(resolve => { releaseSite = resolve; });
  let siteRequested = false;
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => pending } });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(fixture.origin + "/api/admin/v1/sites/default", async route => {
      const response = await route.fetch();
      siteRequested = true;
      await heldSite;
      await route.fulfill({ response });
    });
    await open(page, fixture, "/admin/");
    await page.getByRole("navigation", { name: "网站选择", exact: true })
      .locator('a[href="/admin/sites/default"]').click();
    await expect.poll(() => siteRequested).toBe(true);
    await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute("aria-busy", "true");
    const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/admin/v1/system/update");
    finish(update("1.1.0", epoch));
    await response;
    await expect(updateLink(page)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("perpay:update-presented:1.1.0"))).toBeNull();
    releaseSite();
    await expect(page).toHaveURL(fixture.origin + "/admin/sites/default");
    await expect(page.locator('[data-slot="sidebar-inset"]')).toHaveAttribute("aria-busy", "false");
    await expect(dialog(page)).toBeVisible();
    await acknowledge(page);
  } finally {
    releaseSite();
    finish(update("1.1.0", epoch));
    await page.unrouteAll({ behavior: "wait" });
    await fixture.close();
  }
});

test("session expiry cancels a pending update without consuming its announcement", async ({ page }) => {
  const epoch = Date.now();
  let finish!: (result: OfficialUpdate) => void;
  const pending = new Promise<OfficialUpdate>(resolve => { finish = resolve; });
  let checks = 0;
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => {
    checks++;
    return checks === 1 ? pending : update("1.1.0", epoch);
  } } });
  try {
    await open(page, fixture);
    const runtime = page.getByRole("region", { name: "服务运行状态", exact: true });
    await expect(runtime).toBeVisible();
    await expect.poll(() => checks).toBe(1);
    await page.route(fixture.origin + "/api/admin/v1/system/status", route => route.fulfill({
      status: 401, json: { error: { code: "session_invalid", message: "管理员会话已过期。" } },
    }), { times: 1 });
    await runtime.getByRole("button", { name: "刷新", exact: true }).click();
    const login = page.getByRole("heading", { name: "登录管理后台", exact: true });
    await expect(login).toBeVisible();
    finish(update("1.1.0", epoch));
    await expect(dialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("perpay:update-presented:1.1.0"))).toBeNull();
    await page.getByLabel("管理员密码", { exact: true }).fill(HTTP_TEST_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(dialog(page)).toContainText("v1.1.0");
    await expect.poll(() => checks).toBe(2);
    await acknowledge(page);
  } finally { finish(update("1.1.0", epoch)); await fixture.close(); }
});

test("only the focused tab announces a release and ignore changes synchronize", async ({ page }) => {
  const epoch = Date.now();
  let checks = 0;
  const fixture = await createSettingsServer(epoch, { updateChecker: { check: async () => {
    checks++;
    return update("1.1.0", epoch);
  } } });
  const other = await page.context().newPage();
  const foreground = async (active: Page, inactive: Page) => {
    // Headless Chromium may report every page focused. Model only those browser
    // signals while retaining real storage events, Web Locks and HTTP requests.
    for (const [target, focused] of [[inactive, false], [active, true]] as const) {
      if (focused) await target.bringToFront();
      await target.evaluate(focused => {
        Object.defineProperties(document, {
          visibilityState: { configurable: true, value: focused ? "visible" : "hidden" },
          hidden: { configurable: true, value: !focused },
        });
        document.hasFocus = () => focused;
        window.dispatchEvent(new Event(focused ? "focus" : "blur"));
        document.dispatchEvent(new Event("visibilitychange"));
      }, focused);
    }
    await expect.poll(async () => Promise.all([active, inactive].map(target => target.evaluate(() => ({
      focused: document.hasFocus(), visibility: document.visibilityState, hidden: document.hidden,
    }))))).toEqual([{ focused: true, visibility: "visible", hidden: false }, { focused: false, visibility: "hidden", hidden: true }]);
  };
  try {
    await page.context().addInitScript(() => {
      if (localStorage.getItem("perpay:update-preferences") === null)
        localStorage.setItem("perpay:update-preferences", JSON.stringify({ automatic: false, channel: "prerelease" }));
    });
    await open(page, fixture);
    await other.goto(fixture.origin + "/admin/system");
    await foreground(other, page);
    await panel(other).getByRole("switch", { name: "自动检查更新", exact: true }).click();
    await expect(dialog(other)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await dialog(other).getByRole("button", { name: "忽略此版本", exact: true }).click();
    await expect(dialog(other)).not.toBeVisible();
    await foreground(page, other);
    const restore = panel(page).getByRole("button", { name: "恢复此通道更新提醒", exact: true });
    await expect(restore).toBeVisible();
    await expect.poll(() => checks).toBeGreaterThanOrEqual(2);
    await expect(dialog(page)).toHaveCount(0);
    await expect(updateLink(page)).toHaveCount(0);
    await expect(updateLink(other)).toHaveCount(0);
    await expect(updateIndicator(page)).toHaveCount(0);
    await expect(updateIndicator(other)).toHaveCount(0);
    await expect(panel(page)).toContainText("（已忽略）");
    await restore.click();
    await expect(panel(other).getByRole("button", { name: "恢复此通道更新提醒", exact: true })).toHaveCount(0);
    await expect(updateLink(page)).toBeVisible();
    await expect(updateLink(other)).toBeVisible();
    await expect(updateIndicator(page)).toBeVisible();
    await expect(updateIndicator(other)).toBeVisible();
    await expect(panel(other)).not.toContainText("（已忽略）");
    await expect(dialog(page)).toHaveCount(0);
    await foreground(other, page);
    await expect(dialog(other)).toHaveCount(0);
    await panel(other).getByRole("button", { name: "检查更新", exact: true }).click();
    await acknowledge(other);
  } finally { await other.close(); await fixture.close(); }
});

test("real checker headers enforce the manual interval and the shared upstream retry deadline", async ({ page }) => {
  const epoch = Date.now();
  let clock = epoch, upstreamRequests = 0, limited = false;
  const checker = new OfficialUpdateChecker({ currentVersion: APP_VERSION, clock: () => clock, fetch: async url => {
    upstreamRequests++;
    if (limited) return new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
    const metadata = release("1.1.0", epoch);
    return Response.json(String(url).includes("?per_page=") ? [metadata] : metadata);
  } });
  const fixture = await createSettingsServer(epoch, { updateChecker: checker, clock: () => clock });
  try {
    await page.clock.install({ time: new Date(epoch) });
    await open(page, fixture);
    await acknowledge(page);
    const manual = panel(page).getByRole("button", { name: "检查更新", exact: true });
    await expect(manual).toBeDisabled();
    expect(upstreamRequests).toBe(2);
    clock += 60_000;
    await page.clock.fastForward(60_000);
    await expect(manual).toBeEnabled();
    await manual.click();
    await acknowledge(page);
    expect(upstreamRequests).toBe(4);
    await expect(manual).toBeDisabled();
    await expect(page.locator("#main-content")).toBeFocused();

    limited = true;
    clock += 60_000;
    await page.clock.fastForward(60_000);
    await expect(manual).toBeEnabled();
    await manual.click();
    await expect(panel(page)).toContainText(/频率|限流/);
    await expect(manual).toBeDisabled();
    expect(upstreamRequests).toBe(5);
    await panel(page).getByRole("combobox", { name: "检查通道", exact: true }).click();
    await page.getByRole("option", { name: "仅稳定版", exact: true }).click();
    await expect(panel(page)).toContainText(/频率|限流/);
    expect(upstreamRequests).toBe(5);

    clock += 60_000;
    await page.clock.fastForward(60_000);
    await expect(manual).toBeDisabled();
    expect(upstreamRequests).toBe(5);
    clock += 3_540_000;
    await page.clock.fastForward(3_540_000);
    await expect(manual).toBeEnabled();
    expect(upstreamRequests).toBe(5);
    limited = false;
    await manual.click();
    await acknowledge(page);
    expect(upstreamRequests).toBe(6);
  } finally { await fixture.close(); }
});
