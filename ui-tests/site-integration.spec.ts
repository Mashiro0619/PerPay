import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { Site, SiteEpayConfiguration } from "../web/src/api/generated/types.gen";

for (const width of [1440, 390, 320]) {
  test(`integration assistant connects websites and manages keys through real APIs at ${width}px`, async ({ page }, info) => {
    const fixture = await createSettingsServer(Date.now());
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.context().addCookies(fixture.cookies);
      await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
      const headers = { origin: fixture.origin, "x-csrf-token": fixture.cookies.find(cookie => cookie.name.includes("csrf"))!.value };
      const apiPath = "/api/admin/v1/sites/default";
      const readSite = async () => {
        const response = await page.request.get(fixture.origin + apiPath);
        expect(response.status()).toBe(200);
        return (await response.json()).data as Site;
      };
      const readConfiguration = async (clientId = "default") => {
        const response = await page.request.get(fixture.origin + "/api/admin/v1/sites/" + clientId + "/epay");
        expect(response.status()).toBe(200);
        return (await response.json()).data as SiteEpayConfiguration;
      };
      // This fixture owns a disposable database; all key actions use the real administrator routes.
      let site = await readSite();
      const configured = await page.request.put(fixture.origin + apiPath, { headers, data: {
        revision: site.revision, configuration: { ...site.configuration, notifications_enabled: true,
          notification_origin: "https://shop.example.com", return_origin: "https://shop.example.com" },
      } });
      expect(configured.status()).toBe(200);
      site = (await configured.json()).data as Site;
      const created = await page.request.post(fixture.origin + "/api/admin/v1/sites", { headers, data: {
        operation_id: randomUUID(), client_id: "browser_other", configuration: {
          name: "浏览器隔离网站", accepting_orders: true, notifications_enabled: false,
          notification_origin: "https://other-shop.example.com", return_origin: "https://other-shop.example.com", policy: site.configuration.policy,
        },
      } });
      expect(created.status()).toBe(201);
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      const assistant = page.locator("[data-site-integration]");
      await expect(assistant).toBeVisible();
      for (const label of ["原生 API", "易支付 V1", "易支付 V2"]) {
        await assistant.getByRole("button", { name: label, exact: true }).click();
        const protocolRows = await assistant.locator('[data-slot="toggle-group-item"]').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
        expect(Math.max(...protocolRows) - Math.min(...protocolRows)).toBeLessThanOrEqual(1);
        await expect(assistant).not.toContainText(/Demo|调用示例/);
        await expect(assistant.getByRole("button", { name: /下载/ })).toHaveCount(0);
        await expect(assistant.getByRole("link", { name: "接入文档", exact: true })).toHaveAttribute("href",
          "https://github.com/Mashiro0619/PerPay/blob/main/docs/" + (label === "原生 API" ? "integration-quickstart.md" : "epay-integration.md"));
        await expect(assistant.getByRole("textbox", { name: "Demo 通知地址", exact: true })).toHaveCount(0);
        await expect(assistant.getByRole("textbox", { name: "可复制内容", exact: true })).toHaveCount(0);
        if (label !== "原生 API") {
          await expect(assistant.getByRole("button", { name: "密钥管理", exact: true })).toHaveAttribute("aria-expanded", "false");
          await expect(assistant.getByRole("button", { name: /^更新/ })).toHaveCount(0);
        }
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
          await assistant.scrollIntoViewIfNeeded();
          const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
          expect(geometry.content).toBeLessThanOrEqual(geometry.viewport + 1);
          await assistant.screenshot({ path: info.outputPath(`integration-default-${width}-${label}-${colorScheme}.png`) });
        }
      }
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await assistant.getByRole("button", { name: "原生 API", exact: true }).click();
      async function viewKey(label: string, purpose: string, clientId = "default") {
        const viewing = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/sites/" + clientId + "/secrets/" + purpose + "/actions/view");
        await assistant.getByRole("button", { name: label, exact: true }).click();
        const response = await viewing;
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toBe("no-store");
        return (await response.json()).data as { secret: string; public_key?: string };
      }
      let firstMerchantPrivateKey: string | undefined;
      for (const protocol of ["epay_v1", "epay_v2"] as const) {
        const label = protocol === "epay_v1" ? "易支付 V1" : "易支付 V2";
        const keyLabel = protocol === "epay_v1" ? "V1 密钥" : "V2 商户私钥";
        await assistant.getByRole("button", { name: label, exact: true }).click();
        await expect(assistant.getByText(fixture.origin + "/", { exact: true })).toBeVisible();
        const initial = await readConfiguration();
        expect(initial.v1_enabled).toBe(true);
        expect(initial.v2_enabled).toBe(true);
        expect(initial.v1_key_version).toBeGreaterThanOrEqual(1);
        expect(initial.merchant_key_version).toBeGreaterThanOrEqual(1);
        expect(initial.platform_key_version).toBeGreaterThanOrEqual(1);
        const accepting = assistant.getByRole("switch", { name: "允许" + label + "新订单", exact: true });
        await expect(accepting).toBeChecked();
        await accepting.click();
        const saving = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/epay" && response.request().method() === "PUT");
        await assistant.getByRole("button", { name: "保存易支付设置", exact: true }).click();
        expect((await saving).status()).toBe(200);
        const paused = await readConfiguration();
        expect(protocol === "epay_v1" ? paused.v1_enabled : paused.v2_enabled).toBe(false);
        await expect(accepting).not.toBeChecked();
        const pausedKey = await viewKey("查看" + keyLabel, protocol === "epay_v1" ? "epay_v1" : "epay_merchant");
        await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue(pausedKey.secret);
        await accepting.click();
        const resuming = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/epay" && response.request().method() === "PUT");
        await assistant.getByRole("button", { name: "保存易支付设置", exact: true }).click();
        expect((await resuming).status()).toBe(200);
        const configuration = await readConfiguration();
        expect(protocol === "epay_v1" ? configuration.v1_enabled : configuration.v2_enabled).toBe(true);
        expect(configuration.v1_key_version).toBe(initial.v1_key_version);
        expect(configuration.merchant_key_version).toBe(initial.merchant_key_version);
        expect(configuration.platform_key_version).toBe(initial.platform_key_version);
        await expect(assistant.getByText(configuration.pid, { exact: true })).toBeVisible();
        const viewing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/actions/view"));
        await assistant.getByRole("button", { name: "查看" + keyLabel, exact: true }).click();
        const secret = (await (await viewing).json()).data.secret as string;
        await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue(secret);
        expect(secret).toBe(pausedKey.secret);
        await assistant.getByRole("button", { name: "密钥管理", exact: true }).click();
        await assistant.getByRole("button", { name: "更新" + keyLabel, exact: true }).click();
        const rotating = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/actions/rotate"));
        await page.getByRole("alertdialog").getByRole("button", { name: "确认更新", exact: true }).click();
        const rotated = (await (await rotating).json()).data as { secret: string };
        expect(rotated.secret).not.toBe(secret);
        const replacement = await viewKey("查看" + keyLabel, protocol === "epay_v1" ? "epay_v1" : "epay_merchant");
        expect(replacement.secret).toBe(rotated.secret);
        if (protocol === "epay_v2") {
          firstMerchantPrivateKey = replacement.secret;
          const platform = await viewKey("查看V2 平台公钥", "epay_platform");
          await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveCount(0);
          await expect(assistant.getByRole("textbox", { name: "可复制内容", exact: true })).toHaveValue(platform.public_key!);
          expect(await assistant.textContent()).not.toContain(platform.secret);
        }
      }
      // An independent administrator write makes the displayed revision stale.
      const current = await readConfiguration();
      expect((await page.request.put(fixture.origin + apiPath + "/epay", { headers, data: {
        revision: current.revision, v1_enabled: current.v1_enabled, v2_enabled: current.v2_enabled,
      } })).status()).toBe(200);
      await assistant.getByRole("switch", { name: "允许易支付 V2新订单", exact: true }).click();
      const conflicting = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/epay" && response.request().method() === "PUT");
      await assistant.getByRole("button", { name: "保存易支付设置", exact: true }).click();
      expect((await conflicting).status()).toBe(409);
      await expect(assistant.getByRole("button", { name: "保存易支付设置", exact: true })).toBeDisabled();
      await assistant.getByRole("button", { name: "重新读取配置", exact: true }).click();
      const rebased = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/epay" && response.request().method() === "PUT");
      await assistant.getByRole("button", { name: "保存易支付设置", exact: true }).click();
      expect((await rebased).status()).toBe(200);
      expect((await readConfiguration()).v2_enabled).toBe(false);
      await assistant.getByRole("button", { name: "易支付 V1", exact: true }).click();
      await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveCount(0);
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      expect(geometry.content).toBeLessThanOrEqual(geometry.viewport + 1);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`integration-${width}.png`), fullPage: true });
      await info.attach("integration-layout", { body: JSON.stringify(geometry), contentType: "application/json" });
      await assistant.getByRole("button", { name: "查看V1 密钥", exact: true }).click();
      const secretField = assistant.getByRole("textbox", { name: "密钥内容", exact: true });
      await expect(secretField).toBeVisible();
      const previousSecret = await secretField.inputValue();
      if (width < 768) await page.getByRole("button", { name: "切换导航", exact: true }).click();
      const expand = page.getByRole("button", { name: /^业务网站 .*，展开$/ });
      const compact = page.getByRole("button", { name: /^切换业务网站，当前/ });
      if (await expand.isVisible()) await expand.click();
      else if (await compact.isVisible()) await compact.click();
      await page.getByRole("link", { name: "浏览器隔离网站", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/sites\/browser_other\/settings\/integration/);
      await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveCount(0);
      await assistant.getByRole("button", { name: "易支付 V1", exact: true }).click();
      const otherResponse = await page.request.get(fixture.origin + "/api/admin/v1/sites/browser_other/epay");
      const other = (await otherResponse.json()).data as SiteEpayConfiguration;
      expect(other.pid).not.toBe(current.pid);
      expect(other.v1_enabled).toBe(true);
      expect(other.v2_enabled).toBe(true);
      expect(other.v1_key_version).toBe(1);
      expect(other.merchant_key_version).toBe(1);
      expect(other.platform_key_version).toBe(1);
      await expect(assistant.getByText(other.pid, { exact: true })).toBeVisible();
      await expect(assistant.getByRole("switch", { name: "允许易支付 V1新订单", exact: true })).toBeChecked();
      expect(await assistant.textContent()).not.toContain(previousSecret);
      const viewingOther = page.waitForResponse(response => new URL(response.url()).pathname === "/api/admin/v1/sites/browser_other/secrets/epay_v1/actions/view");
      await assistant.getByRole("button", { name: "查看V1 密钥", exact: true }).click();
      const otherSecret = (await (await viewingOther).json()).data.secret as string;
      expect(otherSecret).not.toBe(previousSecret);
      await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue(otherSecret);
      await assistant.getByRole("button", { name: "易支付 V2", exact: true }).click();
      const otherMerchant = await viewKey("查看V2 商户私钥", "epay_merchant", "browser_other");
      expect(otherMerchant.secret).not.toBe(firstMerchantPrivateKey);
      await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue(otherMerchant.secret);
    } finally { await fixture.close(); }
  });
}
