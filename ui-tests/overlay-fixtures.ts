import type { Page } from "@playwright/test";
import { expect, type Manifest } from "./fixtures";

export async function expectOverlayTarget(page: Page, target: string) {
  await expect.poll(() => new URL(page.url()).searchParams.get("overlay")).toBe(target);
}

export async function settleOverlay(page: Page) {
  const dialog = page.locator("[data-overlay-content]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-overlay-detail] [data-slot="skeleton"]')).toHaveCount(0);
  await page.clock.runFor(100);
  return dialog;
}

export async function openRecord(page: Page, manifest: Manifest, path: string) {
  await page.goto(manifest.origin + "/admin" + path);
  return settleOverlay(page);
}

export async function expectOverlayFits(page: Page) {
  await settleOverlay(page);
  const measureGeometry = () => page.locator("[data-overlay-content]").evaluate(element => {
    const rect = element.getBoundingClientRect();
    const visible = window.visualViewport;
    const viewport = { left: visible?.offsetLeft ?? 0, top: visible?.offsetTop ?? 0,
      width: visible?.width ?? innerWidth, height: visible?.height ?? innerHeight };
    const scrolling = [...element.querySelectorAll<HTMLElement>("*")].filter(node => {
      // Native multiline editors/readers scroll their own text; they are not
      // competing layout scroll containers. Keep checking every other element.
      if (node instanceof HTMLTextAreaElement) return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(node).overflowY === "auto" && node.scrollHeight > node.clientHeight + 2;
    }).map(node => ({ tag: node.tagName, detail: node.hasAttribute("data-overlay-detail"), step: node.hasAttribute("data-admin-dialog-scroll") }));
    const footer = element.querySelector<HTMLElement>("[data-overlay-footer]");
    return { viewport, rect: rect.toJSON(), scrolling,
      footer: footer?.getBoundingClientRect().toJSON(),
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
  });
  // Advancing the mocked clock does not settle native viewport rendering.
  // Retry a complete snapshot so resize reflow keeps the same geometry limits.
  let geometry!: Awaited<ReturnType<typeof measureGeometry>>;
  await expect(async () => {
    geometry = await measureGeometry();
    expect(geometry.documentOverflow).toBe(false);
    expect(geometry.rect.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
    expect(geometry.rect.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1);
    expect(geometry.rect.right).toBeLessThanOrEqual(geometry.viewport.left + geometry.viewport.width + 1);
    expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.viewport.top + geometry.viewport.height + 1);
    if (page.viewportSize()!.width < 768) {
      expect(Math.abs(geometry.rect.width - geometry.viewport.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.rect.height - geometry.viewport.height)).toBeLessThanOrEqual(1);
    }
    expect(geometry.scrolling).toHaveLength(geometry.scrolling.length ? 1 : 0);
    if (geometry.footer?.height) expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.rect.bottom + 1);
  }).toPass({ timeout: 10_000 });
  return geometry;
}
