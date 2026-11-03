import { test, expect } from "@playwright/test";
import { AlipayAccountService } from "../src/alipay-accounts/service";
import type { AlipayAccountView } from "../src/alipay-accounts/model";
import { SettingsError } from "../src/settings/store";
import { createSettingsServer } from "./settings-server";

for (const layout of [{ width: 1440, height: 900, font: 100 }, { width: 390, height: 700, font: 100 }, { width: 320, height: 560, font: 200 }]) {
  test.describe(`${layout.width}px ${layout.font}% account validation`, () => {
    test.use({ hasTouch: layout.width < 768, isMobile: layout.width < 768 });
    test("retains rejected imports and active keys, reveals errors and replaces stale feedback after verified activation", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now(), { runtime: services => {
        const store = services.settings.accountService()!.store();
        const originalFingerprint = store.list()[0]!.application_key_fingerprint;
        return { alipayAccounts: new AlipayAccountService({ store, verifyProviderApplicationKey: async provider => {
          if (provider.applicationKeyFingerprint === originalFingerprint) {
            throw new SettingsError("provider_application_key_verification_failed", "原密钥未通过连接检查。");
          }
        } }) };
      } });
      try {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
        await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        const catalog = await page.request.get(fixture.origin + "/api/admin/v1/alipay-accounts");
        const account = (await catalog.json()).data[0] as AlipayAccountView;
        const accountPath = "/api/admin/v1/alipay-accounts/" + account.id;
        const mutations: string[] = [];
        page.on("request", request => {
          if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.method() + " " + new URL(request.url()).pathname);
        });
        const read = async () => (await (await page.request.get(fixture.origin + accountPath)).json()).data as AlipayAccountView;
        await page.goto(fixture.origin + "/admin/settings/accounts");
        await page.evaluate(font => document.documentElement.style.fontSize = font + "%", layout.font);
        await page.getByRole("link", { name: "配置" + account.name, exact: true }).click();
        const dialog = page.locator("[data-overlay-content]");
        await dialog.getByRole("tab", { name: "应用信息", exact: true }).click();
        const appId = dialog.getByRole("textbox", { name: "应用 ID（App ID）", exact: true });
        await appId.fill("edited-app-id");
        const link = dialog.getByRole("link", { name: "打开支付宝应用管理", exact: true });
        expect(new URL((await link.getAttribute("href"))!).searchParams.get("appId")).toBe("edited-app-id");
        await appId.fill(account.app_id!);

        const optional = dialog.getByRole("button", { name: "导入已有应用私钥（可选）", exact: true });
        await optional.click();
        const privateKey = dialog.getByRole("textbox", { name: "应用私钥（可选）", exact: true });
        await privateKey.fill("invalid-imported-private-key");
        await optional.click();
        await dialog.getByRole("tab", { name: "基本信息", exact: true }).click();
        const rejectedImport = page.waitForResponse(response => new URL(response.url()).pathname === accountPath && response.request().method() === "PUT");
        await dialog.getByRole("button", { name: "更多账号操作", exact: true }).click();
        await page.getByRole("menuitem", { name: "保存草稿", exact: true }).click();
        expect((await rejectedImport).status()).toBe(422);
        await expect(optional).toHaveAttribute("aria-expanded", "true");
        await expect(dialog.getByRole("tab", { name: "应用信息", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(privateKey).toBeFocused();
        await expect(privateKey).toHaveValue("invalid-imported-private-key");
        await expect(privateKey).toHaveAttribute("aria-invalid", "true");
        const privateError = privateKey.locator("..").locator('[data-slot="field-error"]');
        await expect(privateError).toContainText("应用私钥格式不正确");
        await privateError.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("private-key-validation.png") });
        expect((await read()).revision).toBe(account.revision);
        await privateKey.fill("");
        await optional.click();

        async function failOldCheck() {
          await dialog.getByRole("tab", { name: "基本信息", exact: true }).click();
          await dialog.getByRole("button", { name: "更多账号操作", exact: true }).click();
          await page.getByRole("menuitem", { name: "重新检查", exact: true }).click();
          await expect(dialog.getByText("连接检查未通过", { exact: true })).toBeVisible();
          await dialog.getByRole("tab", { name: "应用信息", exact: true }).click();
        }
        await failOldCheck();
        await dialog.getByRole("button", { name: "更换应用密钥", exact: true }).click();
        await page.getByRole("alertdialog", { name: "生成新的应用密钥？", exact: true }).getByRole("button", { name: "确认", exact: true }).click();
        await expect(dialog.getByRole("textbox", { name: "待启用应用公钥", exact: true })).toBeVisible();
        await expect(dialog.getByText("连接检查未通过", { exact: true })).toHaveCount(0);
        const pending = (await read()).pending_application_key!;
        expect((await read()).application_public_key).toBe(account.application_public_key);
        await failOldCheck();

        const platformKey = dialog.getByRole("textbox", { name: "新的支付宝公钥", exact: true });
        await platformKey.fill("invalid-platform-public-key");
        const rejectedActivation = page.waitForResponse(response => new URL(response.url()).pathname === accountPath + "/application-key/activate");
        await dialog.getByRole("button", { name: "验证并启用", exact: true }).click();
        expect((await rejectedActivation).status()).toBe(422);
        await expect(platformKey).toBeFocused();
        await expect(platformKey).toHaveAttribute("aria-invalid", "true");
        await expect(platformKey).toHaveValue("invalid-platform-public-key");
        const platformError = platformKey.locator("..").locator('[data-slot="field-error"]');
        await expect(platformError).toContainText("支付宝公钥格式不正确");
        await platformError.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath("platform-key-validation.png") });
        const retained = await read();
        expect(retained.application_public_key).toBe(account.application_public_key);
        expect(retained.pending_application_key?.change_id).toBe(pending.change_id);
        await platformKey.fill(account.platform_public_key!);
        await expect(platformKey).toHaveAttribute("aria-invalid", "false");
        await expect(platformError).toHaveCount(0);
        await dialog.getByRole("button", { name: "验证并启用", exact: true }).click();
        await expect(dialog.getByText("新应用密钥已启用", { exact: true })).toBeVisible();
        await expect(dialog.getByText("连接检查未通过", { exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("textbox", { name: "应用公钥", exact: true })).toHaveValue(pending.public_key);
        const activated = await read();
        expect(activated.pending_application_key).toBeNull();
        expect(activated.application_public_key).toBe(pending.public_key);
        expect(activated.platform_public_key).toBe(account.platform_public_key);
        expect(mutations).toEqual([
          "PUT " + accountPath,
          "POST " + accountPath + "/check",
          "POST " + accountPath + "/application-key/regenerate",
          "POST " + accountPath + "/check",
          "POST " + accountPath + "/application-key/activate",
          "POST " + accountPath + "/application-key/activate",
        ]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("activation-completed.png") });
      } finally { await fixture.close(); }
    });
  });
}
