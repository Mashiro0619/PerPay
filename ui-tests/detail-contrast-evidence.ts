import type { AxeResults } from "axe-core";
import type { Page } from "@playwright/test";

/** Measure actual text runs on an opaque surface; uncertain paint stays unresolved. */
export function measureDetailTextContrast(element: Element, scope: "detail" | "tabs" = "detail") {
  const detail = element.closest("[data-overlay-detail], [data-technical-dialog]") ?? (element.matches("h1")
    ? element.closest('[data-overlay-record="true"] [data-overlay-primary] > [data-slot="dialog-header"]') : null);
  const tabScroller = element.closest("[data-settings-tabs-scroll], .audit-view-scroll");
  const eligible = scope === "tabs" ? tabScroller && element.matches('button[role="tab"][data-slot="tabs-trigger"]') && element.getAttribute("aria-disabled") !== "true" && !element.hasAttribute("disabled")
    : detail && element.matches('p, h1, h2, h3, h4, h5, h6, dt, dd, span, a, div[data-slot$="-description"]');
  if (!eligible ||
    [...element.querySelectorAll("*")].some(node => !["SPAN", "TIME", "A", "STRONG", "EM", "B", "I", "CODE", "BR", "SMALL"].includes(node.tagName))) return null;
  const context = document.createElement("canvas").getContext("2d")!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const luminance = (channels: number[]) => channels.slice(0, 3).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
  const identity = (node: Element | null) => node && ({ tag: node.tagName, slot: node.getAttribute("data-slot"), id: node.id || null });
  const visible = window.visualViewport;
  const viewport = { left: visible?.offsetLeft ?? 0, top: visible?.offsetTop ?? 0,
    right: (visible?.offsetLeft ?? 0) + (visible?.width ?? innerWidth), bottom: (visible?.offsetTop ?? 0) + (visible?.height ?? innerHeight) };
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const runs = [];
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || !node.textContent?.trim()) continue;
    const style = getComputedStyle(parent), foreground = rgba(style.color);
    const conflicts: string[] = [];
    const pseudoPaints: Array<{ owner: ReturnType<typeof identity>; pseudo: string; left: number; top: number; right: number; bottom: number; color: string; opacity: string }> = [];
    let background: number[] | null = null, backgroundCss: string | null = null, backgroundElement: Element | null = null;
    const clips: Array<{ tag: string; slot: string | null; left: number; top: number; right: number; bottom: number; clipX: boolean; clipY: boolean; overflowX: string; overflowY: string }> = [];
    if (style.textShadow !== "none" || Number.parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) > 0) conflicts.push("unverified text paint");
    const textFill = style.getPropertyValue("-webkit-text-fill-color");
    if (textFill && rgba(textFill).some((channel, index) => channel !== foreground[index])) conflicts.push("different text fill");
    for (let ancestor: Element | null = parent; ancestor; ancestor = ancestor.parentElement) {
      const paint = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
      if (paint.opacity !== "1" || paint.filter !== "none" || paint.backdropFilter !== "none" || paint.mixBlendMode !== "normal" || paint.maskImage !== "none" || paint.clipPath !== "none") conflicts.push(ancestor.tagName + ": opacity, filter, mask, clip path or blend");
      const transform = new DOMMatrixReadOnly(paint.transform === "none" ? undefined : paint.transform);
      if (!transform.is2D || transform.a !== 1 || transform.b !== 0 || transform.c !== 0 || transform.d !== 1 || paint.perspective !== "none") conflicts.push(ancestor.tagName + ": scale, rotation or perspective");
      if (paint.visibility !== "visible" || paint.display === "none" || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true") conflicts.push(ancestor.tagName + ": hidden or inert");
      if (!background) {
        const color = rgba(paint.backgroundColor);
        if (paint.backgroundImage !== "none") conflicts.push(ancestor.tagName + ": background image");
        if (color[3] === 255) { background = color; backgroundCss = paint.backgroundColor; backgroundElement = ancestor; }
        else if (color[3]! > 0) conflicts.push(ancestor.tagName + ": translucent background");
      }
      if (ancestor === parent || element.contains(ancestor)) for (const pseudo of ["::before", "::after"]) {
        const decoration = getComputedStyle(ancestor, pseudo);
        if (["none", "normal"].includes(decoration.content) || decoration.display === "none" || decoration.visibility !== "visible" || Number.parseFloat(decoration.opacity) === 0) continue;
        if (decoration.content !== '""') conflicts.push(ancestor.tagName + ": generated text");
        const painted = rgba(decoration.backgroundColor)[3]! > 0 || decoration.backgroundImage !== "none" || decoration.boxShadow !== "none";
        if (painted) {
          // Base UI's selected horizontal tab underline is a two-pixel stripe
          // outside the text box. Prove that geometry; reject other paint.
          const underline = scope === "tabs" && ancestor === element && pseudo === "::after" && decoration.content === '""' &&
            decoration.position === "absolute" && decoration.transform === "none" && decoration.filter === "none" &&
            decoration.backgroundImage === "none" && decoration.boxShadow === "none" && decoration.clipPath === "none" &&
            [decoration.left, decoration.top, decoration.width, decoration.height].every(value => Number.isFinite(Number.parseFloat(value))) &&
            Number.parseFloat(decoration.height) <= 2 && Number.parseFloat(decoration.height) > 0 &&
            Number.parseFloat(decoration.bottom) <= -1 && decoration.top !== "auto" && Number.parseFloat(decoration.top) >= ancestor.clientHeight;
          if (!underline) conflicts.push(ancestor.tagName + ": unverified pseudo-element paint");
          else {
            const left = box.left + ancestor.clientLeft + Number.parseFloat(decoration.left);
            const top = box.top + ancestor.clientTop + Number.parseFloat(decoration.top);
            pseudoPaints.push({ owner: identity(ancestor), pseudo, left, top, right: left + Number.parseFloat(decoration.width),
              bottom: top + Number.parseFloat(decoration.height), color: decoration.backgroundColor, opacity: decoration.opacity });
          }
        }
      }
      const clipX = ["auto", "scroll", "hidden", "clip"].includes(paint.overflowX);
      const clipY = ["auto", "scroll", "hidden", "clip"].includes(paint.overflowY);
      if (clipX || clipY) clips.push({ tag: ancestor.tagName, slot: ancestor.getAttribute("data-slot"),
        left: box.left + ancestor.clientLeft, top: box.top + ancestor.clientTop,
        right: box.left + ancestor.clientLeft + ancestor.clientWidth, bottom: box.top + ancestor.clientTop + ancestor.clientHeight,
        clipX, clipY, overflowX: paint.overflowX, overflowY: paint.overflowY });
    }
    if (!background) conflicts.push("no opaque background");
    // Hit testing alone cannot see pointer-events:none paint. Reject any such
    // overlapping paint inside the text's opaque surface, including SVG ink.
    const decorations = [...backgroundElement?.querySelectorAll("*") ?? []].filter(candidate => {
      if (candidate === parent || candidate.contains(parent)) return false;
      const paint = getComputedStyle(candidate);
      return paint.pointerEvents === "none" && paint.visibility === "visible" && paint.display !== "none" &&
        (rgba(paint.backgroundColor)[3]! > 0 || paint.backgroundImage !== "none" || paint.boxShadow !== "none" || candidate instanceof SVGElement);
    }).map(candidate => ({ owner: identity(candidate), box: candidate.getBoundingClientRect() }));
    const foregroundAlpha = foreground[3]! / 255;
    const compositedForeground = background?.slice(0, 3).map((channel, index) => foreground[index]! * foregroundAlpha + channel * (1 - foregroundAlpha));
    const first = luminance(compositedForeground ?? foreground), second = background && luminance(background);
    const contrast = second === null ? null : (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    const characters = [];
    let offset = 0;
    for (const text of node.textContent) {
      const start = offset; offset += text.length;
      if (!text.trim()) continue;
      range.setStart(node, start); range.setEnd(node, offset);
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      const contained = rects.length > 0 && rects.every(rect => rect.left >= viewport.left - 1 && rect.top >= viewport.top - 1 &&
        rect.right <= viewport.right + 1 && rect.bottom <= viewport.bottom + 1 && clips.every(clip =>
          (!clip.clipX || rect.left >= clip.left - 1 && rect.right <= clip.right + 1) &&
          (!clip.clipY || rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1)));
      const hits = rects.flatMap(rect => [[.5, .5], [.2, .5], [.8, .5], [.5, .2], [.5, .8]].map(([x, y]) => {
        const owner = document.elementFromPoint(rect.left + rect.width * x!, rect.top + rect.height * y!);
        return { passed: owner === parent, owner: identity(owner) };
      }));
      const overlappingPaint = decorations.filter(({ box }) => rects.some(rect =>
        Math.min(box.right, rect.right) - Math.max(box.left, rect.left) > .5 && Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) > .5)).map(({ owner }) => owner);
      overlappingPaint.push(...pseudoPaints.filter(box => rects.some(rect =>
        Math.min(box.right, rect.right) - Math.max(box.left, rect.left) > .5 && Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) > .5)).map(({ owner }) => owner));
      characters.push({ text, rects: rects.map(rect => rect.toJSON()), contained, hits, overlappingPaint });
    }
    runs.push({ text: node.textContent, parent: identity(parent), foreground: style.color, foregroundRgba: foreground,
      compositedForeground, background: backgroundCss, backgroundRgba: background, backgroundSource: identity(backgroundElement), contrast, requiredRatio: 4.5,
      clips, pseudoPaints, conflicts: [...new Set(conflicts)], characters,
      passed: characters.length > 0 && characters.every(character => character.contained && character.hits.every(hit => hit.passed) && !character.overlappingPaint.length) &&
        !conflicts.length && contrast !== null && contrast >= 4.5 });
  }
  return { kind: scope === "tabs" ? "opaque-tab-text" as const : "opaque-detail-text" as const, text: element.textContent, box: element.getBoundingClientRect().toJSON(), viewport, runs,
    passed: runs.length > 0 && runs.every(run => run.passed) };
}

async function resolveTextContrast(page: Page, result: AxeResults, scope: "detail" | "tabs") {
  const reviews = [];
  for (const rule of result.incomplete.filter(rule => rule.id === "color-contrast")) for (const node of rule.nodes) {
    const reasons = [...node.any, ...node.all, ...node.none].map(check => check.data?.messageKey);
    if (!reasons.length || !reasons.every(reason => reason === "elmPartiallyObscuring" || reason === "elmPartiallyObscured")) continue;
    const selector = node.target.length === 1 && typeof node.target[0] === "string" ? node.target[0] : null;
    const locator = selector ? page.locator(selector) : null;
    if (!locator || await locator.count() !== 1) continue;
    const initial = await locator.evaluate(measureDetailTextContrast, scope);
    if (!initial) continue;
    let revealed: ReturnType<typeof measureDetailTextContrast> = null;
    let scrollChanges: Array<{ tag: string; detail: boolean; before: { left: number; top: number }; after: { left: number; top: number } }> = [];
    if (!initial.passed && initial.runs.every(run => !run.conflicts.length && run.contrast !== null && run.contrast >= run.requiredRatio)) {
      const scrollers = await locator.evaluateHandle(element => {
        const result = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) result.push({ element: ancestor, top: ancestor.scrollTop, left: ancestor.scrollLeft });
        return result;
      });
      try {
        // Only move real user-scrollable axes. overflow:hidden and clipped text
        // never become reachable merely because a test scrolls them by script.
        scrollChanges = await locator.evaluate((element, scope) => {
          const changes = [];
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect(), target = element.getBoundingClientRect();
            const before = { left: ancestor.scrollLeft, top: ancestor.scrollTop };
            const scrollY = scope === "detail" && ["auto", "scroll"].includes(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
            const scrollX = ["auto", "scroll"].includes(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
            if (!scrollX && !scrollY) continue;
            ancestor.scrollTo({ behavior: "instant", top: scrollY ? before.top + target.top + target.height / 2 - box.top - ancestor.clientTop - ancestor.clientHeight / 2 : before.top,
              left: scrollX ? before.left + target.left + target.width / 2 - box.left - ancestor.clientLeft - ancestor.clientWidth / 2 : before.left });
            changes.push({ tag: ancestor.tagName, detail: ancestor.hasAttribute("data-overlay-detail"), before, after: { left: ancestor.scrollLeft, top: ancestor.scrollTop } });
          }
          return changes;
        }, scope);
        revealed = await locator.evaluate(measureDetailTextContrast, scope);
      } finally {
        await scrollers.evaluate(states => { for (const state of states) state.element.scrollTo({ top: state.top, left: state.left, behavior: "instant" }); });
        await scrollers.dispose();
      }
    }
    reviews.push({ target: node.target, originalReasons: reasons, resolved: initial.passed || revealed?.passed === true,
      measurement: { initial, revealed, scrollChanges } });
  }
  return reviews;
}

export function resolveDetailTextContrast(page: Page, result: AxeResults) { return resolveTextContrast(page, result, "detail"); }
export function resolveScrollingTabContrast(page: Page, result: AxeResults) { return resolveTextContrast(page, result, "tabs"); }
