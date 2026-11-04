import { test, expect, type Locator } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { RuntimeSettings } from "../web/src/api/generated/types.gen";

async function dockGeometry(footer: Locator) {
  return footer.evaluate(element => {
    const box = (target: Element) => target.getBoundingClientRect().toJSON();
    const rect = element.getBoundingClientRect();
    const toast = document.querySelector('[data-slot="toast"]:not([data-ending-style]):not([data-limited])');
    const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
    return {
      footer: box(element), toast: toast && box(toast), viewportStyle: viewport?.getAttribute("style"),
      gap: (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.75,
      buttons: [...element.querySelectorAll("button")].filter(button => !button.disabled).map(button => {
        const bounds = button.getBoundingClientRect();
        return { text: button.textContent?.trim(), box: box(button),
          centerHit: button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)),
          topHit: button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 4)),
        };
      }),
      expectedBottom: innerHeight - rect.top + (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.75,
    };
  });
}

for (const layout of [
  { width: 320, height: 560, font: 200 },
  { width: 640, height: 280, font: 150 },
] as const) {
  test.describe(`${layout.width}px ${layout.font}% live step feedback`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, isMobile: true, hasTouch: true });

    test("keeps repeated save and reflowed step actions unobstructed with the browser clock running", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      let settings: RuntimeSettings | undefined;
      const writes: Array<{ method: string; path: string }> = [];
      const errors: string[] = [];
      try {
        await page.context().addCookies(fixture.cookies);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.addInitScript(font => {
          const apply = () => { document.documentElement.style.fontSize = font + "%"; };
          if (document.documentElement) apply(); else document.addEventListener("DOMContentLoaded", apply, { once: true });
        }, layout.font);
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== fixture.origin) return route.abort("blockedbyclient");
          if (url.pathname === "/api/admin/v1/settings" && request.method() === "GET") {
            settings ??= (await (await route.fetch()).json()).data;
            return route.fulfill({ json: { data: settings } });
          }
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            writes.push({ method: request.method(), path: url.pathname });
            if (url.pathname !== "/api/admin/v1/settings/admin-access" || request.method() !== "PUT" || !settings) {
              return route.fulfill({ status: 503, json: { error: { code: "isolated_visual_only", message: "本次补查未执行此操作。" } } });
            }
            const { revision, ...admin_access } = request.postDataJSON();
            settings = { ...settings, revision: revision + 1, admin_access: { ...settings.admin_access, ...admin_access } };
            return route.fulfill({ json: { data: settings } });
          }
          return route.continue();
        });
        await page.goto(fixture.origin + "/admin/settings/security/access");
        const primary = page.locator("[data-overlay-footer]");
        const input = page.getByRole("textbox", { name: "允许的 IP / 网段", exact: true });
        await input.fill("192.0.2.11");
        await primary.getByRole("button", { name: "保存白名单", exact: true }).click();
        await page.getByRole("button", { name: "确认保存", exact: true }).click();
        const toast = page.locator('[data-slot="toast"]');
        await expect(toast.locator('[data-slot="toast-title"]')).toHaveText("管理员 IP 白名单已保存");
        await expect(page.locator("[data-overlay-step]")).toHaveCount(0);
        await expect(primary).toBeVisible();
        await expect.poll(async () => {
          const geometry = await dockGeometry(primary);
          return !!geometry.toast && geometry.toast.bottom <= geometry.footer.top + 1 && geometry.buttons.every(button => button.centerHit && button.topHit);
        }).toBe(true);
        const returned = await dockGeometry(primary);
        await input.fill("192.0.2.12");
        await primary.getByRole("button", { name: "保存白名单", exact: true }).click({ timeout: 1000 });
        await expect(page.getByRole("heading", { name: "确认保存访问规则？", exact: true })).toBeVisible();
        const footer = page.locator('[data-overlay-step] [data-slot="dialog-footer"]');
        await expect(footer).toBeVisible();
        const before = await dockGeometry(footer);
        await footer.getByRole("button", { name: "确认保存", exact: true }).evaluate(button => {
          const text = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
          if (!text) throw new Error("Confirmation label is missing");
          text.textContent = "确认保存访问规则，请再次核对";
          Object.assign(button.style, { whiteSpace: "normal", maxWidth: "8rem", height: "auto", minHeight: "7rem" });
        });
        await expect.poll(async () => {
          const geometry = await dockGeometry(footer);
          return geometry.footer.height > before.footer.height + 1 && !!geometry.toast
            && geometry.toast.bottom <= geometry.footer.top + 1
            && geometry.buttons.every(button => button.centerHit && button.topHit);
        }).toBe(true);
        const after = await dockGeometry(footer);
        await info.attach("live-step-feedback", { body: JSON.stringify({ layout, returned, before, after, writes, errors }), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath("reflowed-step.png") });
        await footer.getByRole("button", { name: "取消", exact: true }).click({ timeout: 1000 });
        await expect(page.locator("[data-overlay-step]")).toHaveCount(0);
        expect(writes).toEqual([{ method: "PUT", path: "/api/admin/v1/settings/admin-access" }]);
        expect(errors).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}
