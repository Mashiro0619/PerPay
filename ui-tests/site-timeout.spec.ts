import { test, expect, record } from "./fixtures";
import { test as browserTest } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("template seconds drafts survive tabs, reject excess precision and save exact milliseconds", async ({ page, manifest }, info) => {
  const fixture = await createSettingsServer(manifest.epoch);
  try {
    await page.unroute("**/*");
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/sites/defaults");
    await page.getByRole("tab", { name: "通知策略" }).click();
    await page.getByRole("button", { name: "高级设置" }).click();
    const timeout = page.getByLabel("通知超时（秒）", { exact: true });
    const save = page.getByRole("button", { name: "保存默认模板" });
    await timeout.fill("5.0004");
    await expect(page.getByText("通知超时最多 3 位小数。", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByLabel("最多发送次数", { exact: true }).fill("15");
    await expect(timeout).toHaveValue("5.0004");
    await page.getByRole("tab", { name: "订单设置" }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(save).toBeDisabled();
    await page.getByRole("tab", { name: "通知策略" }).click();
    await expect(timeout).toHaveValue("5.0004");
    await timeout.fill("5.123");
    expect(await timeout.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    const response = page.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/settings/site-defaults"));
    await save.click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON().policy.notification_delivery.timeout_milliseconds).toBe(5123);
    expect(fixture.timeout()).toBe(5123);
    await expect(page.getByText("模板已保存", { exact: true })).toBeVisible();
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await record(page, info, { feature: "notification-timeout", width });
      await info.attach(`timeout-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }
  } finally { await fixture.close(); }
});

browserTest("site timeout keeps invalid input through a concurrent key conflict and saves only its correction", async ({ page }, info) => {
  const fixture = await createSettingsServer(Date.now());
  try {
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
    await page.getByRole("button", { name: "高级设置", exact: true }).click();
    const timeout = page.getByLabel("通知超时（秒）", { exact: true });
    const save = page.getByRole("button", { name: "保存业务网站", exact: true });
    await timeout.fill("5.123");
    await timeout.fill("5.1234");
    await expect(save).toBeDisabled();

    // An independent administrator updates another group while this form is dirty.
    const siteUrl = fixture.origin + "/api/admin/v1/sites/default";
    const current = await page.request.get(siteUrl);
    expect(current.status()).toBe(200);
    const latest = (await current.json()).data;
    const remoteTtl = latest.configuration.policy.orders.order_ttl_seconds === 600 ? 900 : 600;
    latest.configuration.policy.orders.order_ttl_seconds = remoteTtl;
    const csrf = fixture.cookies.find(cookie => cookie.name.includes("csrf"));
    expect(csrf).toBeDefined();
    const remoteSave = await page.request.put(siteUrl, {
      headers: { origin: fixture.origin, "x-csrf-token": decodeURIComponent(csrf!.value) },
      data: { revision: latest.revision, configuration: latest.configuration },
    });
    expect(remoteSave.status()).toBe(200);
    const formWrites: unknown[] = [];
    page.on("request", request => {
      if (request.method() === "PUT" && request.url() === siteUrl) formWrites.push(request.postDataJSON());
    });

    await page.getByRole("button", { name: "生成／轮换 API 密钥", exact: true }).click();
    const rejectedRotation = page.waitForResponse(response => response.request().method() === "POST" && response.status() === 409);
    await page.getByRole("alertdialog").getByRole("button", { name: "确认", exact: true }).click();
    expect((await (await rejectedRotation).json()).error.code).toBe("site_revision_conflict");
    await page.getByRole("button", { name: "读取最新配置并核对", exact: true }).click();
    await expect(page.getByText("最新配置已合并，尚未保存", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "应用核对结果", exact: true })).toHaveCount(0);
    await expect(timeout).toHaveValue("5.1234");
    await expect(timeout).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("通知超时最多 3 位小数。", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    expect(formWrites).toHaveLength(0);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      await info.attach(`timeout-recovery-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    }

    await timeout.fill("6.234");
    const savedResponse = page.waitForResponse(response => response.request().method() === "PUT" && response.url() === siteUrl);
    await save.click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON().configuration.policy.notification_delivery.timeout_milliseconds).toBe(6234);
    const stored = (await (await page.request.get(siteUrl)).json()).data.configuration.policy;
    expect(stored.notification_delivery.timeout_milliseconds).toBe(6234);
    expect(stored.orders.order_ttl_seconds).toBe(remoteTtl);
    expect(formWrites).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});
