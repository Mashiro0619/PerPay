import type { AxeResults } from "axe-core";
import type { Page } from "@playwright/test";

/** Resolve only plain dialog descriptions with independently measurable paint. */
export function measureDialogDescriptionContrast(element: Element) {
  const popup = element.closest('[data-admin-dialog][data-overlay-viewport="dialog"]');
  if (!element.matches('p[data-slot="dialog-description"]') || !popup || element.children.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const box = (node: Element) => node.getBoundingClientRect().toJSON();
  const popupStyle = getComputedStyle(popup), styles = getComputedStyle(element);
  const background = rgba(popupStyle.backgroundColor), foreground = rgba(styles.color);
  const conflicts: string[] = [];
  if (background[3] !== 255 || foreground[3] !== 255) conflicts.push("paint is not fully opaque");
  if (styles.textShadow !== "none") conflicts.push("text shadow");
  const clipAncestors: Array<{ tag: string; slot: string | null; left: number; top: number; right: number; bottom: number; clipX: boolean; clipY: boolean }> = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
    if (Number.parseFloat(style.opacity) !== 1 || style.filter !== "none" || style.mixBlendMode !== "normal" || style.maskImage !== "none") conflicts.push(node.tagName + ": opacity, filter, mask or blend");
    if (style.backgroundImage !== "none") conflicts.push(node.tagName + ": background image");
    // Between the description and the opaque popup, another painted color
    // would require separate compositing rather than the popup's known color.
    if (node !== popup && popup.contains(node)) {
      const color = rgba(style.backgroundColor);
      if (color[3] !== 0 && color.some((value, index) => value !== background[index])) conflicts.push(node.tagName + ": intervening background");
    }
    const clipX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
    const clipY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
    if (clipX || clipY) clipAncestors.push({ tag: node.tagName, slot: node.getAttribute("data-slot"),
      left: bounds.left + node.clientLeft, top: bounds.top + node.clientTop,
      right: bounds.left + node.clientLeft + node.clientWidth,
      bottom: bounds.top + node.clientTop + node.clientHeight, clipX, clipY });
  }
  const visible = window.visualViewport;
  const viewport = { left: visible?.offsetLeft ?? 0, top: visible?.offsetTop ?? 0,
    width: visible?.width ?? innerWidth, height: visible?.height ?? innerHeight };
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height).map(rect => rect.toJSON());
  const characters: Array<{ text: string; rects: ReturnType<DOMRect["toJSON"]>[]; contained: boolean; hit: boolean; owner: { tag: string; slot: string | null } | null }> = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    let offset = 0;
    for (const text of node.textContent ?? "") {
      const start = offset;
      offset += text.length;
      if (!text.trim()) continue;
      range.setStart(node, start);
      range.setEnd(node, offset);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const contained = rects.length > 0 && rects.every(rect =>
        rect.left >= viewport.left - 1 && rect.top >= viewport.top - 1 &&
        rect.right <= viewport.left + viewport.width + 1 && rect.bottom <= viewport.top + viewport.height + 1 &&
        clipAncestors.every(clip => (!clip.clipX || rect.left >= clip.left - 1 && rect.right <= clip.right + 1) &&
          (!clip.clipY || rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1)));
      const rect = range.getBoundingClientRect();
      const owner = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      characters.push({ text, rects: rects.map(rect => rect.toJSON()), contained,
        hit: owner === element || owner !== null && element.contains(owner),
        owner: owner && { tag: owner.tagName, slot: owner.getAttribute("data-slot") } });
    }
  }
  const luminance = (channels: number[]) => channels.slice(0, 3).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
  const first = luminance(foreground), second = luminance(background);
  const contrast = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  return { kind: "html-dialog-description" as const, text: element.textContent, box: box(element), popupBox: box(popup),
    foreground: styles.color, foregroundRgba: foreground, background: popupStyle.backgroundColor, backgroundRgba: background,
    contrast, requiredRatio: 4.5, viewport, lines, clipAncestors, characters, conflicts,
    passed: characters.length > 0 && characters.every(character => character.contained && character.hit) && conflicts.length === 0 && contrast >= 4.5 };
}

export async function resolveDialogDescriptionContrast(page: Page, result: AxeResults) {
  const reviews = [];
  for (const rule of result.incomplete.filter(rule => rule.id === "color-contrast")) for (const node of rule.nodes) {
    const reasons = [...node.any, ...node.all, ...node.none].map(check => check.data?.messageKey);
    if (!reasons.length || !reasons.every(reason => reason === "elmPartiallyObscuring")) continue;
    const selector = node.target.length === 1 && typeof node.target[0] === "string" ? node.target[0] : null;
    const measurement = selector && await page.locator(selector).count() === 1
      ? await page.locator(selector).evaluate(measureDialogDescriptionContrast) : null;
    reviews.push({ target: node.target, originalReasons: reasons, resolved: measurement?.passed === true, measurement });
  }
  return reviews;
}
