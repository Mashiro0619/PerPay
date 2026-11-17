import type { Locator, Page } from "@playwright/test";
import { test, expect, login } from "./fixtures";

const popup = '[data-overlay-viewport="dialog"]';

interface Sample { opacity: number; scale: string; translate: string; kinds: string[]; duration: string }

/** Records the popup's computed style on every frame from the moment it is inserted, and once more when it starts closing. */
async function watchDialog(page: Page) {
  await page.evaluate(selector => {
    const state: { opening: Sample[]; closing: Sample | null } = { opening: [], closing: null };
    (window as unknown as { dialogMotion: typeof state }).dialogMotion = state;
    const read = (element: Element): Sample => {
      const style = getComputedStyle(element);
      return {
        opacity: Number(style.opacity), scale: style.scale, translate: style.translate, duration: style.transitionDuration,
        kinds: element.getAnimations().map(animation => animation.constructor.name + ":" + ((animation as CSSTransition).transitionProperty ?? "")),
      };
    };
    let watched: Element | null = null;
    new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) return;
      if (element !== watched) {
        watched = element;
        const started = performance.now();
        const frame = () => {
          if (!element.isConnected || element.hasAttribute("data-ending-style")) return;
          state.opening.push(read(element));
          if (performance.now() - started < 600) requestAnimationFrame(frame);
        };
        frame();
      }
      if (element.hasAttribute("data-ending-style") && !state.closing) state.closing = read(element);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ending-style"] });
  }, popup);
}

async function recorded(page: Page) {
  return page.evaluate(() => (window as unknown as { dialogMotion: { opening: Sample[]; closing: Sample | null } }).dialogMotion);
}

async function openOverlay(page: Page, list: string, link: Locator, content: string) {
  await page.goto(list);
  const trigger = link.first();
  await expect(trigger).toBeVisible();
  await watchDialog(page);
  await trigger.click();
  const overlay = page.locator("[data-overlay-content]");
  await expect(overlay.locator(content).first()).toBeVisible();
  // Let the entrance finish before reading the settled state.
  await expect.poll(async () => (await recorded(page)).opening.at(-1)?.kinds.length).toBe(0);
  return overlay;
}

const openFirstOrder = (page: Page, origin: string) =>
  openOverlay(page, origin + "/admin/orders", page.locator("a[data-row-link]"), '[data-detail-section="overview"]');

test.describe("dialog motion", () => {
  test("a centred dialog rises and fades in with transitions, then leaves with a faster fade", async ({ page, manifest }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await login(page, manifest);
    const overlay = await openOverlay(page, manifest.origin + "/admin/sites", page.getByRole("link", { name: "创建业务网站", exact: true }), "form");
    const opening = (await recorded(page)).opening;
    const first = opening[0]!;
    const last = opening.at(-1)!;
    expect(first.opacity).toBeLessThan(0.2);
    expect(Number(first.scale)).toBeCloseTo(0.98, 2);
    // Centred popups start 8px below their resting place.
    expect(first.translate).toMatch(/-50% calc\(-50% \+ 8px\)|calc\(-50% \+ 8px\)/);
    expect(opening.some(sample => sample.opacity > 0.05 && sample.opacity < 0.95), "opacity passes through intermediate values").toBe(true);
    const kinds = new Set(opening.flatMap(sample => sample.kinds));
    expect([...kinds].sort()).toEqual(["CSSTransition:opacity", "CSSTransition:scale", "CSSTransition:translate"]);
    expect(last.opacity).toBe(1);
    expect(["none", "1"]).toContain(last.scale);
    expect(last.duration).toBe("0.28s, 0.28s, 0.28s");

    await overlay.locator('[data-slot="dialog-close"]').click();
    await expect(overlay).toHaveCount(0);
    const closing = (await recorded(page)).closing!;
    expect(closing.duration).toBe("0.14s");
    // The exit only fades: the popup stays where it was.
    expect(["none", "1"]).toContain(closing.scale);
    expect(closing.translate).toBe(last.translate);
  });

  test("a record opens as a full-height drawer that slides in from the right and fades out in place", async ({ page, manifest }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await login(page, manifest);
    const overlay = await openFirstOrder(page, manifest.origin);
    const opening = (await recorded(page)).opening;
    const first = opening[0]!;
    const last = opening.at(-1)!;
    expect(first.opacity).toBeLessThan(0.2);
    expect(first.translate).toBe("16px");
    expect(first.scale).toBe("none");
    expect(opening.some(sample => sample.opacity > 0.05 && sample.opacity < 0.95), "opacity passes through intermediate values").toBe(true);
    expect(last.opacity).toBe(1);
    expect(last.translate).toBe("0px");
    // 44rem wide, flush with the top, right and bottom edges; the list stays visible to its left.
    expect(await overlay.boundingBox()).toEqual({ x: 1440 - 704, y: 0, width: 704, height: 900 });
    const backdrop = page.locator('[data-slot="dialog-overlay"]');
    await expect(backdrop).toHaveCSS("background-color", "rgba(0, 0, 0, 0.2)");
    await expect(backdrop).toHaveCSS("backdrop-filter", "none");

    await overlay.locator('[data-slot="dialog-close"]').click();
    await expect(overlay).toHaveCount(0);
    const closing = (await recorded(page)).closing!;
    expect(closing.duration).toBe("0.14s");
    expect(closing.translate).toBe("0px");
  });

  test("a full-screen overlay on a phone slides up instead of scaling", async ({ page, manifest }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await login(page, manifest);
    await openFirstOrder(page, manifest.origin);
    const opening = (await recorded(page)).opening;
    expect(opening[0]!.opacity).toBeLessThan(0.2);
    expect(opening[0]!.translate).toBe("0px 16px");
    expect(opening[0]!.scale).toBe("none");
    expect(["none", "0px"]).toContain(opening.at(-1)!.translate);
    expect(opening.at(-1)!.opacity).toBe(1);
  });

  test("reduced motion shows and removes the overlay without a visible transition", async ({ page, manifest }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await login(page, manifest);
    const overlay = await openFirstOrder(page, manifest.origin);
    const opening = (await recorded(page)).opening;
    // The first frame may still carry the starting style; from the second frame on it is fully shown.
    expect(opening.slice(1).every(sample => sample.opacity === 1)).toBe(true);
    expect(opening.at(-1)!.duration).toBe("1e-05s");
    await overlay.locator('[data-slot="dialog-close"]').click();
    await expect(overlay).toHaveCount(0);
  });
});
