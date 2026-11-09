import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

for (const width of [1440, 390]) {
  test(`website secret reads stay visible beside their controls at ${width}px`, async ({ page }, info) => {
    const fixture = await createSettingsServer(Date.now());
    try {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.context().addCookies(fixture.cookies);
      await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
      const sitePath = "/api/admin/v1/sites/default";
      const headers = { origin: fixture.origin, "x-csrf-token": fixture.cookies.find(cookie => cookie.name.includes("csrf"))!.value };
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
      const emptyGroup = page.locator("[data-overlay-content]").getByRole("group", { name: "API 密钥", exact: true });
      await emptyGroup.getByRole("button", { name: "查看 API 密钥", exact: true }).click();
      const missing = emptyGroup.getByText("尚未生成该网站的密钥。", { exact: true });
      await expect(missing).toBeVisible();
      await expect(emptyGroup.getByRole("textbox")).toHaveCount(0);
      const missingBounds = await missing.boundingBox();
      expect(missingBounds!.y).toBeGreaterThanOrEqual(0);
      expect(missingBounds!.y + missingBounds!.height).toBeLessThanOrEqual(720);
      for (const purpose of ["api_secret", "webhook_secret"]) {
        const current = await page.request.get(fixture.origin + sitePath);
        expect(current.status()).toBe(200);
        const revision = (await current.json()).data.revision;
        const response = await page.request.post(fixture.origin + sitePath + "/secrets/" + purpose + "/actions/rotate", { headers, data: { revision } });
        expect(response.status()).toBe(200);
      }
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
      const editor = page.locator("[data-overlay-content]");
      await expect(editor).toBeVisible();
      for (const [groupName, buttonName, inputName] of [
        ["API 密钥", "查看 API 密钥", "API 密钥"],
        ["通知密钥", "查看通知密钥", "通知签名密钥"],
      ] as const) {
        const group = editor.getByRole("group", { name: groupName, exact: true });
        await group.getByRole("button", { name: buttonName, exact: true }).click();
        const input = group.getByRole("textbox", { name: inputName, exact: true });
        await expect(input).not.toHaveValue("");
        await expect(input).toBeFocused();
        const bounds = await input.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(720);
        await page.screenshot({ path: info.outputPath(`native-${width}-${groupName}.png`), mask: [input] });
        await group.getByRole("button", { name: /^隐藏/ }).click();
        await expect(input).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await fixture.close(); }
  });
}
