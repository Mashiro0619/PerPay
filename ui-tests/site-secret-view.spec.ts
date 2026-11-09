import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

for (const width of [1440, 390, 320]) {
  test(`website secret dialogs retry reads and restore focus at ${width}px`, async ({ page }, info) => {
    const fixture = await createSettingsServer(Date.now());
    try {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.context().addCookies(fixture.cookies);
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
          writeText: async (value: string) => { (window as Window & { copiedSecret?: string }).copiedSecret = value; },
        } });
      });
      await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
      const sitePath = "/api/admin/v1/sites/default";
      const headers = { origin: fixture.origin, "x-csrf-token": fixture.cookies.find(cookie => cookie.name.includes("csrf"))!.value };
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
      const emptyGroup = page.locator("[data-overlay-content]").getByRole("group", { name: "API 密钥", exact: true });
      const emptyTrigger = emptyGroup.getByRole("button", { name: "查看 API 密钥", exact: true });
      await emptyTrigger.click();
      const missingDialog = page.getByRole("dialog", { name: "API 密钥", exact: true });
      const missing = missingDialog.getByText("尚未生成该网站的密钥。", { exact: true });
      await expect(missing).toBeVisible();
      await expect(missingDialog.getByRole("textbox")).toHaveCount(0);
      const missingBounds = await missing.boundingBox();
      expect(missingBounds!.y).toBeGreaterThanOrEqual(0);
      expect(missingBounds!.y + missingBounds!.height).toBeLessThanOrEqual(720);
      const secrets: Record<string, string> = {};
      for (const purpose of ["api_secret", "webhook_secret"]) {
        const current = await page.request.get(fixture.origin + sitePath);
        expect(current.status()).toBe(200);
        const revision = (await current.json()).data.revision;
        const response = await page.request.post(fixture.origin + sitePath + "/secrets/" + purpose + "/actions/rotate", { headers, data: { revision } });
        expect(response.status()).toBe(200);
        secrets[purpose] = (await response.json()).data.secret;
      }
      await missingDialog.getByRole("button", { name: "重新读取", exact: true }).click();
      await expect(missingDialog.getByRole("textbox", { name: "API 密钥", exact: true })).toHaveValue(secrets.api_secret!);
      await expect(missing).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(missingDialog).toHaveCount(0);
      await expect(emptyTrigger).toBeFocused();
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
      const editor = page.locator("[data-overlay-content]");
      await expect(editor).toBeVisible();
      for (const [groupName, buttonName, inputName, purpose] of [
        ["API 密钥", "查看 API 密钥", "API 密钥", "api_secret"],
        ["通知签名密钥", "查看通知签名密钥", "通知签名密钥", "webhook_secret"],
      ] as const) {
        const group = editor.getByRole("group", { name: groupName, exact: true });
        const trigger = group.getByRole("button", { name: buttonName, exact: true });
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: inputName, exact: true });
        expect(await dialog.evaluate(element => element.closest("[data-overlay-step]") === null)).toBe(true);
        const input = dialog.getByRole("textbox", { name: inputName, exact: true });
        await expect(input).toHaveValue(secrets[purpose]!);
        await dialog.getByRole("button", { name: "复制" + inputName, exact: true }).click();
        expect(await page.evaluate(() => (window as Window & { copiedSecret?: string }).copiedSecret)).toBe(secrets[purpose]);
        for (const scale of width === 320 ? [100, 200] : [100]) {
          await page.evaluate(value => { document.documentElement.style.fontSize = value + "%"; }, scale);
          for (const colorScheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
            const bounds = await dialog.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(-1);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
            await dialog.screenshot({ path: info.outputPath(`native-${width}-${purpose}-${scale}-${colorScheme}.png`), mask: [input] });
          }
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(input).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(editor).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await fixture.close(); }
  });
}

test("closing a pending secret dialog ignores its late response and permits a fresh read", async ({ page }) => {
  const fixture = await createSettingsServer(Date.now());
  let release = () => {};
  try {
    await page.setViewportSize({ width: 390, height: 720 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.context().addCookies(fixture.cookies);
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    const sitePath = "/api/admin/v1/sites/default";
    const headers = { origin: fixture.origin, "x-csrf-token": fixture.cookies.find(cookie => cookie.name.includes("csrf"))!.value };
    const current = (await (await page.request.get(fixture.origin + sitePath)).json()).data;
    const generated = await page.request.post(fixture.origin + sitePath + "/secrets/api_secret/actions/rotate", { headers, data: { revision: current.revision } });
    expect(generated.status()).toBe(200);
    const secret = (await generated.json()).data.secret as string;
    await page.goto(fixture.origin + "/admin/sites/default/edit?section=integration");
    const trigger = page.getByRole("button", { name: "查看 API 密钥", exact: true });
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void, delivered!: () => void;
    const pendingRead = new Promise<void>(resolve => { started = resolve; });
    const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
    let holdNext = true;
    await page.route("**/sites/default/secrets/api_secret/actions/view", async route => {
      if (!holdNext) return route.continue();
      holdNext = false;
      const response = await route.fetch();
      started();
      await held;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    await trigger.click();
    await pendingRead;
    const dialog = page.getByRole("dialog", { name: "API 密钥", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    release();
    await responseDelivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog).toHaveCount(0);
    await trigger.click();
    await expect(dialog.getByRole("textbox", { name: "API 密钥", exact: true })).toHaveValue(secret);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally { release(); await fixture.close(); }
});
