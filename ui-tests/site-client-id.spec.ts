import { test, expect, type Page } from "@playwright/test";
import type { Site } from "../web/src/api/generated/types.gen";
import { createSettingsServer } from "./settings-server";

async function submitSite(page: Page, expectedStatus: number) {
  const responseReady = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/admin/v1/sites" && response.request().method() === "POST",
  );
  await page.locator("[data-overlay-content]").getByRole("button", { name: "创建业务网站", exact: true }).click();
  const response = await responseReady;
  expect(response.status()).toBe(expectedStatus);
  return response;
}

for (const width of [1440, 390]) {
  test.describe(`${width}px custom website client identity`, () => {
    test.use({ viewport: { width, height: 900 }, reducedMotion: "reduce" });

    test("corrects reserved and duplicate IDs, preserves the chosen identity and supports automatic IDs", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin
          ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        await page.goto(fixture.origin + "/admin/sites");
        const dialog = page.locator("[data-overlay-content]");
        const clientId = dialog.getByRole("textbox", { name: /客户端 ID/ });
        const siteName = dialog.getByRole("textbox", { name: "业务网站名称", exact: true });

        async function openCreation(name: string) {
          await page.getByRole("link", { name: "创建业务网站", exact: true }).click();
          await siteName.fill(name);
        }

        async function verifyCreated(site: Site, expectedId: string, expectedName: string) {
          expect(site.client_id).toBe(expectedId);
          await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(`/sites/${expectedId}/edit?section=basic`);
          await expect(dialog.getByRole("textbox", { name: /客户端 ID/ })).toHaveCount(0);
          const stored = await page.request.get(`${fixture.origin}/api/admin/v1/sites/${expectedId}`);
          expect(stored.status()).toBe(200);
          expect((await stored.json()).data).toMatchObject({ client_id: expectedId, configuration: { name: expectedName } });
          await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        }

        const firstName = `自定义网站 ${width}`;
        await openCreation(firstName);
        await clientId.fill("new");
        await submitSite(page, 422);
        await expect(clientId).toHaveAttribute("aria-invalid", "true");
        await expect(clientId).toBeFocused();
        await expect(siteName).toHaveValue(firstName);
        await expect(dialog.getByText("创建结果待确认", { exact: true })).toHaveCount(0);

        const firstId = `Shop.${width}_A`;
        await clientId.fill(firstId);
        const inputBox = await clientId.boundingBox();
        expect(inputBox).not.toBeNull();
        expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(width + 1);
        await page.screenshot({ path: info.outputPath("custom-client-id-form.png") });
        const created = await submitSite(page, 201);
        await verifyCreated((await created.json()).data, firstId, firstName);

        const secondName = `重复纠正网站 ${width}`;
        await openCreation(secondName);
        await clientId.fill(firstId);
        const conflict = await submitSite(page, 409);
        expect((await conflict.json()).error.code).toBe("site_client_id_conflict");
        await expect(clientId).toHaveAttribute("aria-invalid", "true");
        await expect(clientId).toBeFocused();
        await expect(dialog.getByText("该客户端 ID 已被使用，请换一个。", { exact: true })).toHaveCount(1);
        await expect(siteName).toHaveValue(secondName);
        await expect(dialog.getByText("创建结果待确认", { exact: true })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath("duplicate-client-id.png") });
        const secondId = `member-${width}`;
        await clientId.fill(secondId);
        const corrected = await submitSite(page, 201);
        await verifyCreated((await corrected.json()).data, secondId, secondName);

        const automaticName = `自动编号网站 ${width}`;
        await openCreation(automaticName);
        await expect(clientId).toHaveValue("");
        const automatic = await submitSite(page, 201);
        expect(automatic.request().postDataJSON()).not.toHaveProperty("client_id");
        const automaticSite = (await automatic.json()).data as Site;
        expect(automaticSite.client_id).toMatch(/^site_[0-9a-f-]{36}$/);
        await verifyCreated(automaticSite, automaticSite.client_id, automaticName);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      } finally {
        await fixture.close();
      }
    });

    test("distinguishes same-name websites with custom prefix IDs through creation and navigation", async ({ page }) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin
          ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        await page.goto(fixture.origin + "/admin/sites");
        const dialog = page.locator("[data-overlay-content]");
        for (const id of ["shop", "site_shop"]) {
          await page.getByRole("link", { name: "创建业务网站", exact: true }).click();
          await dialog.getByRole("textbox", { name: "业务网站名称", exact: true }).fill("同名测试网站");
          await dialog.getByRole("textbox", { name: /客户端 ID/ }).fill(id);
          const response = await submitSite(page, 201);
          expect((await response.json()).data.client_id).toBe(id);
          await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(`/sites/${id}/edit?section=basic`);
          await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        }
        const overview = page.getByRole("region", { name: "网站经营概况", exact: true });
        const links = overview.getByRole("link", { name: /^同名测试网站 · / });
        await expect(links).toHaveCount(2);
        const labels = await links.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")));
        expect(labels.every(label => label?.startsWith("同名测试网站 · "))).toBe(true);
        expect(new Set(labels).size).toBe(2);
        for (const [id, label] of [
          ["shop", "同名测试网站 · shop"],
          ["site_shop", "同名测试网站 · site_sho"],
        ] as const) {
          await overview.getByRole("link", { name: label, exact: true }).click();
          await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toContain(`/sites/${id}/summary`);
          await expect(dialog.getByText(id, { exact: true })).toBeVisible();
          await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
          await expect(dialog).toHaveCount(0);
        }
      } finally { await fixture.close(); }
    });

    test("changes the public ID while the website route and historical order stay attached", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      try {
        const orderId = fixture.seedPaidOrder();
        await page.context().route("**/*", route => new URL(route.request().url()).origin === fixture.origin
          ? route.continue() : route.abort("blockedbyclient"));
        await page.context().addCookies(fixture.cookies);
        await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
        await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
        await page.getByRole("button", { name: "更换客户端 ID", exact: true }).click();
        const newId = `Billing.${width}_Shop`;
        const input = page.getByRole("textbox", { name: "新客户端 ID", exact: true });
        await expect(input).toHaveValue("default");
        await input.fill(newId);
        await page.screenshot({ path: info.outputPath("change-client-id-form.png") });
        await page.getByRole("button", { name: "继续核对", exact: true }).click();
        const confirmation = page.getByRole("alertdialog", { name: "确认更换客户端 ID？", exact: true });
        await expect(confirmation).toBeVisible();
        await expect(confirmation.getByText(newId, { exact: true })).toBeVisible();
        await page.screenshot({ path: info.outputPath("change-client-id-confirmation.png") });
        const responseReady = page.waitForResponse(response =>
          new URL(response.url()).pathname === "/api/admin/v1/sites/default/actions/change-client-id"
          && response.request().method() === "POST");
        await confirmation.getByRole("button", { name: "确认更换", exact: true }).click();
        const response = await responseReady;
        expect(response.status()).toBe(200);
        expect((await response.json()).data).toMatchObject({ client_id: "default", api_client_id: newId });
        await expect(page.getByRole("textbox", { name: "新客户端 ID", exact: true })).toHaveCount(0);
        await expect(page.locator("[data-overlay-content]").getByText(newId, { exact: true })).toBeVisible();
        const stored = await page.request.get(fixture.origin + "/api/admin/v1/sites/default");
        expect((await stored.json()).data).toMatchObject({ client_id: "default", api_client_id: newId });
        const history = await page.request.get(`${fixture.origin}/api/admin/v1/sites/default/orders/${orderId}`);
        expect(history.status()).toBe(200);
        expect((await history.json()).data.order_id).toBe(orderId);
        await page.locator("[data-overlay-content]").getByRole("button", { name: "关闭对话框", exact: true }).click();
        await page.goto(fixture.origin + "/admin/sites/default/settings/basic");
        await expect(page.getByText(newId, { exact: true })).toBeVisible();
        await page.goto(fixture.origin + "/admin/sites?q=" + encodeURIComponent(newId));
        await expect(page.getByRole("link", { name: /^网站设置/ })).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      } finally {
        await fixture.close();
      }
    });
  });
}
