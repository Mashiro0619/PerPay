import { selectSettingsSection, expectSettingsSection, expectSettingsSections } from "./settings-sections";
import { test, expect, type Locator } from "@playwright/test";
import type { AlipayAccountView } from "../src/alipay-accounts/model";
import { createSettingsServer } from "./settings-server";

const creationSections = [
  ["basic", "基本信息", "账号名称"],
  ["application", "应用信息", "App ID"],
  ["collection", "收款码", "支付宝收款码内容"],
] as const;

async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const geometry = await control.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return {
      width: bounds.width,
      height: bounds.height,
      insideViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1,
      unobscured: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.insideViewport).toBe(true);
  expect(geometry.unobscured).toBe(true);
  return geometry;
}

for (const layout of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${layout.width}px account creation`, () => {
    test.use({ viewport: layout, hasTouch: layout.width < 768, isMobile: layout.width < 768, reducedMotion: "reduce", colorScheme: "dark" });

    test("shows usable configuration sections until a draft is successfully created, then exposes saved usage", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        const endpoint = "/api/admin/v1/alipay-accounts";
        const mutations: Array<{ method: string; path: string; status: number }> = [];
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        page.on("response", response => {
          const request = response.request(), path = new URL(request.url()).pathname;
          if (path.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) {
            mutations.push({ method: request.method(), path, status: response.status() });
          }
        });
        const catalog = async () => (await (await page.request.get(fixture.origin + endpoint)).json()).data as AlipayAccountView[];
        const initialAccounts = await catalog();
        await page.goto(fixture.origin + "/admin/settings/accounts");
        await page.getByRole("link", { name: "添加支付宝账号", exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe("/settings/accounts/new");
        const dialog = page.getByRole("dialog", { name: "支付宝账号", exact: true });
        const editor = dialog.locator("[data-alipay-account-editor]");
        await expect(editor).toBeVisible();
        await expectSettingsSections(page, editor, "支付宝账号配置分组", creationSections.map(([, label]) => label));

        const accountName = `新增账号回归-${layout.width}`;
        const appId = `202611050000${layout.width}`;
        const collectionCode = `https://qr.alipay.com/creation-${layout.width}`;
        const values = [accountName, appId, collectionCode];
        const panels = [];
        for (const [index, [panel, label, fieldName]] of creationSections.entries()) {
          await selectSettingsSection(page, editor, "支付宝账号配置分组", label);
          const active = editor.locator(`[data-account-panel="${panel}"]`);
          await expect(active).toBeVisible();
          const field = active.getByRole("textbox", { name: fieldName, exact: true });
          const fieldGeometry = await expectReachable(field);
          await field.fill(values[index]!);
          const save = dialog.getByRole("button", { name: "创建账号并继续", exact: true });
          await expect(save).toBeEnabled();
          const saveGeometry = await expectReachable(save);
          expect(await save.getAttribute("form")).toBe(await editor.locator("form").getAttribute("id"));
          await expectReachable(dialog.getByRole("button", { name: "更多账号操作", exact: true }));
          const detail = dialog.locator("[data-overlay-detail]");
          const width = await detail.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
          expect(width.scrollWidth).toBeLessThanOrEqual(width.width + 1);
          await page.screenshot({ path: info.outputPath(`new-account-${panel}.png`) });
          panels.push({ panel, fieldGeometry, saveGeometry, width });
        }
        expect(mutations).toEqual([]);
        for (const [index, [, label, fieldName]] of creationSections.entries()) {
          await selectSettingsSection(page, editor, "支付宝账号配置分组", label);
          await expect(editor.getByRole("textbox", { name: fieldName, exact: true })).toHaveValue(values[index]!);
        }

        await selectSettingsSection(page, editor, "支付宝账号配置分组", "应用信息");
        const platformKey = editor.getByRole("textbox", { name: "支付宝公钥", exact: true });
        await platformKey.fill("invalid-platform-public-key");
        await selectSettingsSection(page, editor, "支付宝账号配置分组", "收款码");
        const rejectedResponse = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "更多账号操作", exact: true }).click();
        await page.getByRole("menuitem", { name: "保存草稿", exact: true }).click();
        const rejected = await rejectedResponse;
        expect(rejected.status()).toBe(422);
        const rejection = await rejected.json() as { error: { code: string; message: string; fields: Record<string, string> } };
        expect(rejection.error.fields.platform_public_key).toContain("支付宝公钥");
        await expectSettingsSection(editor, "支付宝账号配置分组", "应用信息");
        await expect(platformKey).toHaveValue("invalid-platform-public-key");
        await expect(platformKey).toHaveAttribute("aria-invalid", "true");
        await expect(platformKey).toBeFocused();
        await expectSettingsSections(page, editor, "支付宝账号配置分组", creationSections.map(([, label]) => label));
        expect(new URL(page.url()).searchParams.get("overlay")).toBe("/settings/accounts/new");
        expect((await catalog()).map(account => account.id)).toEqual(initialAccounts.map(account => account.id));
        await page.screenshot({ path: info.outputPath("new-account-rejected.png") });

        await platformKey.fill("");
        for (const [index, [, label, fieldName]] of creationSections.entries()) {
          await selectSettingsSection(page, editor, "支付宝账号配置分组", label);
          await expect(editor.getByRole("textbox", { name: fieldName, exact: true })).toHaveValue(values[index]!);
        }
        const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === "POST");
        await dialog.getByRole("button", { name: "创建账号并继续", exact: true }).click();
        const created = await createdResponse;
        expect(created.status()).toBe(201);
        const account = (await created.json()).data as AlipayAccountView;
        expect(created.request().postDataJSON()).toMatchObject({ name: accountName, app_id: appId, code_payload: collectionCode, platform_public_key: null });
        await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe("/settings/accounts/" + account.id);
        await expect(dialog.getByText("账号已保存", { exact: true })).toBeVisible();
        const stored = (await (await page.request.get(fixture.origin + endpoint + "/" + account.id)).json()).data as AlipayAccountView;
        expect(stored).toMatchObject({ id: account.id, name: accountName, app_id: appId, code_payload: collectionCode, configured: false, sites: [] });

        await expect(dialog.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
        await selectSettingsSection(page, editor, "支付宝账号配置分组", "使用情况");
        const usage = editor.locator('[data-account-panel="usage"]');
        await expect(usage).toBeVisible();
        await expect(usage.getByText("账号状态", { exact: true })).toBeVisible();
        await expect(usage.getByText("账号状态", { exact: true }).locator("..").locator("dd")).toHaveText("配置未完成");
        await expect(usage.getByText("收款状态", { exact: true }).locator("..").locator("dd")).toHaveText("配置未完成");
        await expect(usage.getByText("尚未分配给网站。", { exact: true })).toBeVisible();
        await expectReachable(usage.getByRole("button", { name: "删除账号", exact: true }));
        await expect(dialog.getByRole("button", { name: "保存并检查", exact: true })).toHaveCount(0);
        await expect(dialog.locator("[data-overlay-footer] [data-overlay-actions]")).toHaveCount(0);
        await page.screenshot({ path: info.outputPath("created-account-usage.png") });

        await page.reload();
        await selectSettingsSection(page, editor, "支付宝账号配置分组", "基本信息");
        await expect(editor.getByRole("textbox", { name: "账号名称", exact: true })).toHaveValue(accountName);
        await expectSettingsSections(page, editor, "支付宝账号配置分组", [...creationSections.map(([, label]) => label), "使用情况"]);
        expect(mutations).toEqual([{ method: "POST", path: endpoint, status: 422 }, { method: "POST", path: endpoint, status: 201 }]);
        expect(pageErrors).toEqual([]);
        await info.attach("account-creation-flow", {
          body: Buffer.from(JSON.stringify({ layout, panels, rejection: rejection.error, createdAccount: { id: account.id, name: accountName, app_id: appId, code_payload: collectionCode }, mutations }, null, 2)),
          contentType: "application/json",
        });
      } finally {
        await fixture.close();
      }
    });
  });
}
