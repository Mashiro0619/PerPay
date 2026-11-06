import { test, expect, type Locator } from "@playwright/test";
import { createSettingsServer } from "./settings-server";
import type { RuntimeSettings } from "../web/src/api/generated/types.gen";

async function dockGeometry(footer: Locator) {
  return footer.evaluate(element => {
    const box = (target: Element) => target.getBoundingClientRect().toJSON();
    const rect = element.getBoundingClientRect();
    const toast = document.querySelector('[data-slot="toast"]:not([data-ending-style]):not([data-limited])');
    const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
    const surface = element.closest('[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]')!;
    const bounds = surface.getBoundingClientRect();
    const visible = window.visualViewport;
    const top = Math.max(bounds.top, visible?.offsetTop ?? 0);
    const bottom = Math.min(bounds.bottom, (visible?.offsetTop ?? 0) + (visible?.height ?? innerHeight));
    const toastBounds = toast?.getBoundingClientRect();
    const maxHeight = toast ? Number.parseFloat(getComputedStyle(toast).maxHeight) : 0;
    const separated = !!toastBounds && (toastBounds.bottom <= rect.top + 1 || toastBounds.top >= rect.bottom - 1);
    const contained = !!toastBounds && Number.isFinite(maxHeight) && maxHeight > 0 && toastBounds.height <= maxHeight + 1
      && toastBounds.top >= top - 1 && toastBounds.bottom <= bottom + 1
      && (toastBounds.top < rect.bottom - 1 || toastBounds.bottom - maxHeight >= rect.bottom - 1);
    return {
      footer: box(element), toast: toast && box(toast), viewportStyle: viewport?.getAttribute("style"),
      maxHeight, separated, contained, visibleTop: top, visibleBottom: bottom,
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
          return geometry.separated && geometry.contained && geometry.buttons.every(button => button.centerHit && button.topHit);
        }).toBe(true);
        const returned = await dockGeometry(primary);
        await input.fill("192.0.2.12");
        await primary.getByRole("button", { name: "保存白名单", exact: true }).click({ timeout: 1000 });
        await expect(page.getByRole("heading", { name: "确认保存访问规则？", exact: true })).toBeVisible();
        const footer = page.locator('[data-overlay-step] [data-slot="dialog-footer"]');
        await expect(footer).toBeVisible();
        const before = await dockGeometry(footer);
        await page.keyboard.press("F6");
        await expect(page.getByRole("region", { name: "提示", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(toast).toBeFocused();
        await expect(page.locator("[data-overlay-step]")).toHaveCount(1);
        await footer.getByRole("button", { name: "确认保存", exact: true }).evaluate(button => {
          const text = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
          if (!text) throw new Error("Confirmation label is missing");
          text.textContent = "确认保存访问规则，请再次核对";
          Object.assign(button.style, { whiteSpace: "normal", maxWidth: "8rem", height: "auto", minHeight: "7rem" });
        });
        await expect.poll(async () => (await dockGeometry(footer)).footer.height).toBeGreaterThan(before.footer.height + 1);
        const reflowedActions = [];
        for (const action of await footer.getByRole("button").all()) {
          const label = (await action.textContent())?.trim();
          await action.scrollIntoViewIfNeeded();
          await info.attach("reflowed-action-initial", { body: JSON.stringify({ label, ...(await dockGeometry(footer)) }), contentType: "application/json" });
          try {
            await expect.poll(async () => {
              const geometry = await dockGeometry(footer);
              const target = geometry.buttons.find(button => button.text === label);
              return { separated: geometry.separated, contained: geometry.contained,
                centerHit: !!target?.centerHit, topHit: !!target?.topHit };
            }).toMatchObject({ separated: true, contained: true, centerHit: true, topHit: true });
          } finally {
            await info.attach("reflowed-action", { body: JSON.stringify({ label, ...(await dockGeometry(footer)) }), contentType: "application/json" });
          }
          reflowedActions.push(await dockGeometry(footer));
        }
        const after = await dockGeometry(footer);
        await info.attach("live-step-feedback", { body: JSON.stringify({ layout, returned, before, after, reflowedActions, writes, errors }), contentType: "application/json" });
        await page.screenshot({ path: info.outputPath("reflowed-step.png") });
        // A footer covering the whole scroll window leaves no vertical dock.
        // Feedback must still offer a visible dismissal before the next action.
        await footer.evaluate(element => {
          const footer = element as HTMLElement;
          footer.style.minHeight = `${innerHeight * 2}px`;
          const scroll = footer.closest<HTMLElement>('[data-admin-dialog-scroll]')!;
          const surface = footer.closest('[data-slot="dialog-content"]')!;
          scroll.scrollTop += footer.getBoundingClientRect().top - surface.getBoundingClientRect().top + 16;
        });
        await expect.poll(() => footer.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const surface = element.closest('[data-slot="dialog-content"]')!.getBoundingClientRect();
          return bounds.top <= surface.top && bounds.bottom >= surface.bottom;
        })).toBe(true);
        await expect.poll(() => toast.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const viewport = window.visualViewport;
          const top = viewport?.offsetTop ?? 0;
          return Number.parseFloat(getComputedStyle(element).maxHeight) > 0
            && bounds.top >= top - 1 && bounds.bottom <= top + (viewport?.height ?? innerHeight) + 1;
        })).toBe(true);
        await toast.getByRole("button", { name: "关闭提示", exact: true }).click();
        await expect(toast).toHaveCount(0);
        await expect(page.locator("[data-overlay-step]"), "closing feedback keeps the confirmation open").toHaveCount(1);
        await footer.getByRole("button", { name: "取消", exact: true }).click({ timeout: 1000 });
        await expect(page.locator("[data-overlay-step]")).toHaveCount(0);
        expect(writes).toEqual([{ method: "PUT", path: "/api/admin/v1/settings/admin-access" }]);
        expect(errors).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}
