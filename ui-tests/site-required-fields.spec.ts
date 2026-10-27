import { test, expect } from "@playwright/test";
import { createSettingsServer } from "./settings-server";

test("website required fields show custom feedback, suppress native bubbles and focus the first invalid control", async ({ page }) => {
  const fixture = await createSettingsServer(Date.now());
  try {
    const writes: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === fixture.origin && ["POST", "PUT"].includes(request.method()) &&
        ["/api/admin/v1/sites", "/api/admin/v1/sites/default", "/api/admin/v1/settings/site-defaults"].includes(url.pathname)) {
        writes.push(url.pathname);
      }
    });
    await page.route("**/*", route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort("blockedbyclient"));
    await page.context().addCookies(fixture.cookies);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const form of [
        { path: "/sites/new", label: "业务网站名称", button: "创建业务网站" },
        { path: "/sites/default/settings/basic", label: "业务网站名称", button: "保存业务网站" },
        { path: "/sites/default/settings/display", label: "收银台名称", button: "保存业务网站" },
        { path: "/sites/defaults", label: "收银台名称", button: "保存默认模板", tab: "收银台展示" },
      ]) {
        await page.goto(fixture.origin + "/admin" + form.path);
        if (form.tab) await page.getByRole("tab", { name: form.tab, exact: true }).click();
        const input = page.getByLabel(form.label, { exact: true });
        const original = await input.inputValue();
        await input.evaluate((element: HTMLInputElement) => {
          element.addEventListener("invalid", event => {
            queueMicrotask(() => element.setAttribute("data-test-invalid-handled", String(event.defaultPrevented)));
          });
        });
        for (const value of ["", " \u3000 "]) {
          await input.fill(value);
          await page.getByRole("button", { name: form.button, exact: true }).click();
          await expect(input).toHaveAttribute("aria-invalid", "true");
          await expect(input).toHaveAccessibleDescription(`请输入${form.label}。`);
          await expect(input).toHaveAttribute("data-test-invalid-handled", "true");
          await expect(input).toBeFocused();
          expect(writes).toEqual([]);
        }
        await input.fill("有效名称");
        await expect(input).not.toHaveAttribute("aria-invalid", "true");
        await expect(input).not.toHaveAttribute("aria-describedby");
        expect(await input.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(true);
        await input.fill(original);
      }

      await page.goto(fixture.origin + "/admin/sites/default/settings/orders");
      const ttl = page.getByLabel("收银台有效期（秒）", { exact: true });
      const offset = page.getByLabel("最大加价金额（分）", { exact: true });
      const originalTtl = await ttl.inputValue(), originalOffset = await offset.inputValue();
      await ttl.fill("");
      await offset.fill("");
      await page.getByRole("button", { name: "保存业务网站", exact: true }).click();
      await expect(ttl).toHaveAccessibleDescription("请输入收银台有效期（秒）。");
      await expect(offset).toHaveAccessibleDescription("请输入最大加价金额（分）。");
      await expect(ttl).toBeFocused();
      expect(writes).toEqual([]);
      await ttl.fill(originalTtl);
      await offset.fill(originalOffset);

      await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
      const advanced = page.getByRole("button", { name: "高级设置", exact: true });
      await advanced.click();
      const attempts = page.getByLabel("最多发送次数", { exact: true });
      const originalAttempts = await attempts.inputValue();
      await attempts.fill("");
      await advanced.click();
      await page.getByRole("button", { name: "保存业务网站", exact: true }).click();
      await expect(attempts).toBeVisible();
      await expect(attempts).toHaveAccessibleDescription("请输入最多发送次数。");
      await expect(attempts).toBeFocused();
      expect(writes).toEqual([]);
      await attempts.fill(originalAttempts);
    }
  } finally { await fixture.close(); }
});
