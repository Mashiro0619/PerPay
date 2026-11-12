import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Site } from "../web/src/api/generated/types.gen";
import { createSettingsServer } from "./settings-server";

for (const layout of [
  { width: 390, height: 844, font: 100, theme: "light" },
  { width: 1440, height: 900, font: 100, theme: "dark" },
  { width: 320, height: 560, font: 200, theme: "light" },
  { width: 640, height: 280, font: 150, theme: "dark" },
] as const) {
  test.describe(`${layout.width}px ${layout.font}% website key dialog feedback`, () => {
    test.use({ isMobile: layout.width < 768, hasTouch: layout.width < 768 });

    test("keeps the key dialog footer clickable while the success notification remains", async ({ page }, info) => {
      const fixture = await createSettingsServer(Date.now());
      const writes: Array<{ path: string; method: string; intercepted: boolean }> = [];
      const errors: string[] = [];
      let site: Site | undefined;
      try {
        await page.setViewportSize({ width: layout.width, height: layout.height });
        await page.emulateMedia({ colorScheme: layout.theme, reducedMotion: "reduce" });
        await page.context().addCookies(fixture.cookies);
        await page.addInitScript(({ font, theme }) => {
          localStorage.setItem("perpay:theme", theme);
          const applyFont = () => { document.documentElement.style.fontSize = font + "%"; };
          if (document.documentElement) applyFont();
          else document.addEventListener("DOMContentLoaded", applyFont, { once: true });
        }, layout);
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/*", async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== fixture.origin) return route.abort("blockedbyclient");
          if (url.pathname === "/api/admin/v1/sites/default" && request.method() === "GET") {
            if (!site) {
              const initial: Site = (await (await route.fetch()).json()).data;
              site = { ...initial, secrets: { ...initial.secrets, api_secret: true, webhook_secret: initial.secrets?.webhook_secret ?? false } };
            }
            return route.fulfill({ json: { data: site } });
          }
          if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
            writes.push({ path: url.pathname, method: request.method(), intercepted: true });
            if (url.pathname === "/api/admin/v1/sites/default/secrets/api_secret/actions/rotate") {
              if (!site) throw new Error("Website was not loaded before the intercepted key rotation");
              site = { ...site, revision: site.revision + 1 };
              return route.fulfill({ json: { data: {
                site, secret: "synthetic-toast-footer-dialog-key",
              } } });
            }
            return route.fulfill({ status: 503, json: { error: {
              code: "synthetic_visual_only", message: "本次补查未执行此操作。",
            } } });
          }
          return route.continue();
        });

        await page.goto(fixture.origin + "/admin/sites/default/settings/integration");
        await page.getByRole("link", { name: "编辑接入与通知", exact: true }).click();
        await expect(page.locator("html")).toHaveCSS("font-size", (16 * layout.font / 100) + "px");
        // Only this page permits intercepted writes. No provider key is changed.
        await page.evaluate(() => delete document.documentElement.dataset.perpayDemo);
        await page.getByRole("button", { name: "轮换 API 密钥", exact: true }).click();
        await page.getByRole("button", { name: "确认轮换", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "API 密钥", exact: true });
        const notification = page.locator('[data-slot="toast"]');
        await expect(dialog).toBeVisible();
        await expect(notification.locator('[data-slot="toast-title"]')).toHaveText("密钥已生成或轮换，请更新业务网站配置。");
        await expect.poll(() => notification.evaluate(element => {
          const title = element.querySelector<HTMLElement>('[data-slot="toast-title"]')!;
          return title.getBoundingClientRect().width / parseFloat(getComputedStyle(title).fontSize);
        }), { message: "提示正文至少保留四个汉字的行宽" }).toBeGreaterThanOrEqual(4);
        const closeBounds = await notification.locator('[data-slot="toast-close"]').boundingBox();
        expect(closeBounds!.x).toBeGreaterThanOrEqual(0);
        expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(layout.width);
        const finish = dialog.getByRole("button", { name: "关闭", exact: true });
        await finish.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        // Freeze auto-dismiss after layout settles so waiting cannot hide an obstruction.
        await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now())));

        const geometry = await finish.evaluate(element => {
          const box = (target: Element) => {
            const rect = target.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
          };
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            button: box(element),
            footer: box(element.closest('[data-slot="dialog-footer"]')!),
            dialog: box(element.closest('[data-slot="dialog-content"]')!),
            viewport: { width: innerWidth, height: innerHeight },
            centerHit: element.contains(hit),
            hitSlot: hit?.closest("[data-slot]")?.getAttribute("data-slot"),
            toasts: [...document.querySelectorAll<HTMLElement>('[data-slot="toast"]')].map(toast => ({
              text: toast.innerText, box: box(toast), maxHeight: Number.parseFloat(getComputedStyle(toast).maxHeight),
            })),
            overlayHostActive: !!document.querySelector("[data-overlay-content]"),
          };
        });
        await page.screenshot({ path: info.outputPath("before-pointer.png"), animations: "disabled", caret: "hide" });
        await page.evaluate(() => {
          const observed = window as typeof window & { __toastFooterClick: { slot: string | null; button: string | null } | null };
          observed.__toastFooterClick = null;
          document.addEventListener("click", event => {
            const target = event.target instanceof Element ? event.target : null;
            const button = target?.closest("button");
            observed.__toastFooterClick = {
              slot: target?.closest("[data-slot]")?.getAttribute("data-slot") ?? null,
              button: button?.getAttribute("aria-label") ?? button?.textContent?.trim() ?? null,
            };
          }, { capture: true, once: true });
        });
        await page.mouse.click(geometry.button.x + geometry.button.width / 2, geometry.button.y + geometry.button.height / 2);
        let closed = false;
        try {
          await expect(dialog).toBeHidden({ timeout: 1000 });
          closed = true;
        } catch {
          // Save the actual target and screenshot before the assertions report the obstruction.
        }
        const actualClick = await page.evaluate(() => (
          window as typeof window & { __toastFooterClick: { slot: string | null; button: string | null } | null }
        ).__toastFooterClick);
        const result = {
          layout, ...geometry, actualClick,
          finishReceivedClick: actualClick?.button === "关闭",
          closedAfterActualPointer: closed, writes, errors,
          note: "Isolated website fixture; key mutation is intercepted. The close button is scrolled into the viewport before the actual pointer event.",
        };
        const resultPath = info.outputPath("toast-footer-geometry.json");
        await writeFile(resultPath, JSON.stringify(result, null, 2));
        await info.attach("toast-footer-geometry", { path: resultPath, contentType: "application/json" });
        if (!closed) await page.screenshot({ path: info.outputPath("after-blocked-pointer.png"), animations: "disabled", caret: "hide" });

        expect(geometry.overlayHostActive, "the website editor remains behind its key dialog").toBe(true);
        const center = { x: geometry.button.x + geometry.button.width / 2, y: geometry.button.y + geometry.button.height / 2 };
        expect(center.x).toBeGreaterThanOrEqual(0);
        expect(center.x).toBeLessThan(geometry.viewport.width);
        expect(center.y).toBeGreaterThanOrEqual(0);
        expect(center.y).toBeLessThan(geometry.viewport.height);
        expect(geometry.toasts).toHaveLength(1);
        for (const toast of geometry.toasts) {
          expect(Number.isFinite(toast.maxHeight), "the notification has a finite height limit").toBe(true);
          expect(toast.maxHeight).toBeGreaterThan(0);
          expect(toast.box.height).toBeLessThanOrEqual(toast.maxHeight + 1);
          const aboveFooter = toast.box.bottom <= geometry.footer.y + 1;
          const belowFooter = toast.box.y >= geometry.footer.bottom - 1;
          expect(aboveFooter || belowFooter, "the notification leaves the footer unobstructed").toBe(true);
          if (belowFooter) {
            expect(toast.box.bottom).toBeLessThanOrEqual(Math.min(geometry.dialog.bottom, geometry.viewport.height) + 1);
            expect(toast.box.bottom - toast.maxHeight, "feedback can grow only inside the space below the footer").toBeGreaterThanOrEqual(geometry.footer.bottom - 1);
          }
        }
        expect(result.centerHit, "the finish button receives the pointer while feedback remains").toBe(true);
        expect(result.finishReceivedClick).toBe(true);
        expect(result.closedAfterActualPointer).toBe(true);
        expect(writes).toEqual([{ path: "/api/admin/v1/sites/default/secrets/api_secret/actions/rotate", method: "POST", intercepted: true }]);
        expect(errors).toEqual([]);
      } finally {
        await fixture.close();
      }
    });
  });
}
