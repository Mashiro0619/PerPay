import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { Site, SiteEpayConfiguration } from "../web/src/api/generated/types.gen";

for (const width of [1440, 390, 320]) {
  test(`integration assistant saves, rotates and exports through real APIs at ${width}px`, async ({ page }, info) => {
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
      const readConfiguration = async () => {
        const response = await page.request.get(fixture.origin + apiPath + "/epay");
        expect(response.status()).toBe(200);
        return (await response.json()).data as SiteEpayConfiguration;
      };
      // This fixture owns a disposable database. Every key and export comes from the real administrator routes.
      let site = await readSite();
      const nativeSecrets: Record<string, string> = {};
      for (const purpose of ["api_secret", "webhook_secret"]) {
        const rotated = await page.request.post(fixture.origin + apiPath + "/secrets/" + purpose + "/actions/rotate", { headers, data: { revision: site.revision } });
        expect(rotated.status()).toBe(200);
        const result = (await rotated.json()).data as { site: Site; secret: string };
        site = result.site;
        nativeSecrets[purpose] = result.secret;
      }
      const configured = await page.request.put(fixture.origin + apiPath, { headers, data: {
        revision: site.revision, configuration: { ...site.configuration, notifications_enabled: true,
          notification_origin: "https://demo.example.com", return_origin: "https://demo.example.com" },
      } });
      expect(configured.status()).toBe(200);
      site = (await configured.json()).data as Site;
      const created = await page.request.post(fixture.origin + "/api/admin/v1/sites", { headers, data: {
        operation_id: randomUUID(), client_id: "browser_other", configuration: {
          name: "浏览器隔离网站", accepting_orders: true, notifications_enabled: false,
          notification_origin: null, return_origin: null, policy: site.configuration.policy,
        },
      } });
      expect(created.status()).toBe(201);
      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      const assistant = page.locator('[data-slot="card"]').filter({ has: page.getByText("网站接入助手", { exact: true }) });
      await expect(assistant).toBeVisible();
      async function downloadConfiguration(protocol: "native" | "epay_v1" | "epay_v2") {
        const downloading = page.waitForEvent("download");
        const responding = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/integration/export");
        await assistant.getByRole("button", { name: "下载完整配置", exact: true }).click();
        const response = await responding;
        expect(response.status()).toBe(200);
        expect(response.headers()["cache-control"]).toBe("no-store");
        const download = await downloading;
        expect(download.suggestedFilename()).toBe("perpay-default-" + protocol + ".env");
        const contents = parseEnv(readFileSync((await download.path())!, "utf8"));
        expect(contents.PAYMENT_PROTOCOL).toBe(protocol);
        expect(contents.DEMO_NOTIFY_URL).toBe("https://demo.example.com/webhooks/perpay");
        expect(response.request().postDataJSON()).toMatchObject({ protocol, site_revision: site.revision,
          epay_revision: (await readConfiguration()).revision });
        return contents;
      }
      const native = await downloadConfiguration("native");
      expect(native.PERPAY_API_SECRET).toBe(nativeSecrets.api_secret);
      expect(native.PERPAY_WEBHOOK_SECRET).toBe(nativeSecrets.webhook_secret);
      for (const protocol of ["epay_v1", "epay_v2"] as const) {
        const label = protocol === "epay_v1" ? "易支付 V1" : "易支付 V2";
        const keyLabel = protocol === "epay_v1" ? "V1 密钥" : "V2 商户私钥";
        await assistant.getByRole("button", { name: label, exact: true }).click();
        await expect(assistant.getByText(fixture.origin + "/", { exact: true })).toBeVisible();
        await expect(assistant.getByRole("button", { name: "下载完整配置", exact: true })).toBeDisabled();
        await assistant.getByRole("switch", { name: "允许" + label + "新订单", exact: true }).click();
        const saving = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/epay" && response.request().method() === "PUT");
        await assistant.getByRole("button", { name: "保存易支付设置", exact: true }).click();
        expect((await saving).status()).toBe(200);
        const configuration = await readConfiguration();
        expect(protocol === "epay_v1" ? configuration.v1_enabled : configuration.v2_enabled).toBe(true);
        await expect(assistant.getByText(configuration.pid, { exact: true })).toBeVisible();
        const viewing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/actions/view"));
        await assistant.getByRole("button", { name: "查看" + keyLabel, exact: true }).click();
        const secret = (await (await viewing).json()).data.secret as string;
        await expect(assistant.getByRole("textbox", { name: "密钥内容", exact: true })).toHaveValue(secret);
        const exported = await downloadConfiguration(protocol);
        expect(protocol === "epay_v1" ? exported.EPAY_V1_KEY : exported.EPAY_MERCHANT_PRIVATE_KEY)
          .toBe(protocol === "epay_v1" ? secret : secret.replace(/-----[^-]+-----|\s/g, ""));
        expect(exported.EPAY_PID).toBe(configuration.pid);
        await assistant.getByRole("button", { name: "生成／轮换" + keyLabel, exact: true }).click();
        const rotating = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/actions/rotate"));
        await page.getByRole("alertdialog").getByRole("button", { name: "确认更新", exact: true }).click();
        const rotated = (await (await rotating).json()).data as { secret: string };
        expect(rotated.secret).not.toBe(secret);
        const replacement = await downloadConfiguration(protocol);
        expect(protocol === "epay_v1" ? replacement.EPAY_V1_KEY : replacement.EPAY_MERCHANT_PRIVATE_KEY)
          .toBe(protocol === "epay_v1" ? rotated.secret : rotated.secret.replace(/-----[^-]+-----|\s/g, ""));
      }
      // An independent administrator write makes the displayed revision stale.
      const current = await readConfiguration();
      expect((await page.request.put(fixture.origin + apiPath + "/epay", { headers, data: {
        revision: current.revision, v1_enabled: current.v1_enabled, v2_enabled: current.v2_enabled,
      } })).status()).toBe(200);
      const conflicting = page.waitForResponse(response => new URL(response.url()).pathname === apiPath + "/integration/export");
      await assistant.getByRole("button", { name: "下载完整配置", exact: true }).click();
      expect((await conflicting).status()).toBe(409);
      await expect(assistant.getByRole("button", { name: "下载完整配置", exact: true })).toBeDisabled();
      await assistant.getByRole("button", { name: "重新读取配置", exact: true }).click();
      await downloadConfiguration("epay_v2");
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
      await expect(assistant.getByText(other.pid, { exact: true })).toBeVisible();
      await expect(assistant.getByRole("button", { name: "下载完整配置", exact: true })).toBeDisabled();
      await expect(assistant.getByLabel("Demo 通知地址", { exact: true })).toHaveValue("");
      expect(await assistant.textContent()).not.toContain(previousSecret);
    } finally { await fixture.close(); }
  });
}
