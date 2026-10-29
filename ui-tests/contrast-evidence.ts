import type { AxeResults } from "axe-core";
import type { Page } from "@playwright/test";

/** Supplement axe's SVG image-node result without suppressing its raw evidence. */
export function measureAxisContrast(element: Element) {
  const text = element.closest("text");
  const svg = text?.closest("svg.recharts-surface");
  if (!text || !svg || !text.matches("text.recharts-cartesian-axis-tick-value")) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const box = (node: Element) => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const textBox = box(text), surfaceBox = box(svg);
  const styles = getComputedStyle(text);
  const foreground = rgba(styles.fill);
  const conflicts = [];
  let opacity = Number.parseFloat(styles.fillOpacity) || 0;
  let background: number[] | null = null;
  let backgroundCss: string | null = null;
  let backgroundSource: string | null = null;
  for (let node: Element | null = text; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    opacity *= Number.parseFloat(style.opacity);
    if (style.filter !== "none" || style.mixBlendMode !== "normal") conflicts.push(node.tagName + ": filter or blend");
    const candidate = rgba(style.backgroundColor);
    if (style.backgroundImage !== "none") conflicts.push(node.tagName + ": background image");
    if (candidate[3] === 255) {
      background = candidate;
      backgroundCss = style.backgroundColor;
      backgroundSource = node.getAttribute("data-slot") ?? node.tagName;
      break;
    }
    if (candidate[3]! > 0) conflicts.push(node.tagName + ": translucent background");
  }
  const paintedSeries = [...svg.querySelectorAll(".recharts-area-area, .recharts-line-curve, .recharts-bar-rectangle path, .recharts-bar-rectangle rect, .recharts-scatter-symbol")]
    .map(node => ({ shape: node.getAttribute("class") ?? node.tagName, ...box(node) }))
    .filter(r => r.width > 0 && r.height > 0 &&
      Math.min(r.right, textBox.right) - Math.max(r.x, textBox.x) > 0 &&
      Math.min(r.bottom, textBox.bottom) - Math.max(r.y, textBox.y) > 0);
  const overlappingLabels = [...(text.closest(".recharts-cartesian-axis-tick-labels")?.querySelectorAll("text") ?? [])]
    .filter(label => label !== text)
    .map(label => ({ text: label.textContent, ...box(label) }))
    .filter(r => r.width > 0 && r.height > 0 &&
      Math.min(r.right, textBox.right) - Math.max(r.x, textBox.x) > 1 &&
      Math.min(r.bottom, textBox.bottom) - Math.max(r.y, textBox.y) > 1);
  const fontSize = Number.parseFloat(styles.fontSize);
  const fontWeight = Number.parseFloat(styles.fontWeight);
  const requiredRatio = fontSize >= 24 || fontWeight >= 700 && fontSize >= 18.6667 ? 3 : 4.5;
  const luminance = (channels: number[]) => channels.slice(0, 3)
    .map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
  const alpha = foreground[3]! / 255 * opacity;
  const ink = background?.slice(0, 3).map((channel, index) => foreground[index]! * alpha + channel * (1 - alpha));
  const first = ink && luminance(ink), second = background && luminance(background);
  const contrast = first === undefined || second === null ? null : (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  const contained = textBox.x >= surfaceBox.x - 1 && textBox.y >= surfaceBox.y - 1 &&
    textBox.right <= surfaceBox.right + 1 && textBox.bottom <= surfaceBox.bottom + 1;
  return {
    text: text.textContent, foreground: styles.fill, foregroundRgba: foreground,
    background: backgroundCss, backgroundRgba: background, backgroundSource,
    opacity, fontSize, fontWeight, requiredRatio, contrast,
    textBox, surfaceBox, contained, paintedSeries, overlappingLabels, conflicts,
    passed: contrast !== null && contrast >= requiredRatio && contained && paintedSeries.length === 0 && overlappingLabels.length === 0 && conflicts.length === 0,
  };
}

/** Only the known opaque, settled background of a selected ToggleGroup is eligible. */
export function measureSelectionContrast(element: Element) {
  const control = element.closest<HTMLElement>('button[data-slot="toggle-group-item"][aria-pressed="true"]');
  const group = control?.closest('[data-selection-motion="fill"]');
  const indicator = control?.querySelector<HTMLElement>(':scope > [data-selection-indicator="fill"]');
  if (!control || !group || !indicator || group.querySelectorAll('[data-selection-indicator="fill"]').length !== 1) return null;
  const context = document.createElement("canvas").getContext("2d")!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const contents = [...control.children].filter(child => child !== indicator);
  const icon = contents.find(child => child.tagName.toLowerCase() === "svg");
  const label = contents.find(child => child.tagName === "SPAN");
  const labelledIcon = contents.length === 2 && icon?.getAttribute("aria-hidden") === "true" &&
    !icon.querySelector("foreignObject, image, a, text") && label?.children.length === 0 && Boolean(label.textContent?.trim());
  const textElement = labelledIcon ? label! : control;
  const text = getComputedStyle(control), labelStyle = getComputedStyle(textElement), paint = getComputedStyle(indicator);
  const foreground = rgba(labelStyle.color), background = rgba(paint.backgroundColor);
  const box = control.getBoundingClientRect(), fill = indicator.getBoundingClientRect();
  const conflicts: string[] = [];
  const identity = (transform: string) => transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
  for (let node: Element | null = indicator; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.opacity !== "1" || style.filter !== "none" || style.backdropFilter !== "none" || style.mixBlendMode !== "normal" || !identity(style.transform)) conflicts.push("opacity, filter, blend or transform");
    if (style.maskImage !== "none" || style.clipPath !== "none") conflicts.push("mask or clipping");
  }
  if (contents.length !== 0 && !labelledIcon) conflicts.push("unexpected control content");
  if (labelledIcon && [...control.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) conflicts.push("unmeasured direct text");
  const textFill = labelStyle.getPropertyValue("-webkit-text-fill-color");
  if (textFill && rgba(textFill).some((channel, index) => channel !== foreground[index]) ||
    labelStyle.textShadow !== "none" || Number.parseFloat(labelStyle.getPropertyValue("-webkit-text-stroke-width")) > 0) conflicts.push("unverified text paint");
  if (labelledIcon) {
    const iconStyle = getComputedStyle(icon!);
    if (!["hidden", "clip"].includes(iconStyle.overflowX) || !["hidden", "clip"].includes(iconStyle.overflowY) ||
      iconStyle.filter !== "none" || iconStyle.backdropFilter !== "none" || iconStyle.boxShadow !== "none" ||
      iconStyle.mixBlendMode !== "normal" || !identity(iconStyle.transform) || iconStyle.pointerEvents !== "none" ||
      [...icon!.querySelectorAll("*")].some(node => !["path", "line", "rect", "circle", "ellipse", "polyline", "polygon", "g"].includes(node.tagName.toLowerCase()))) conflicts.push("unverified icon paint");
  }
  if (textElement !== control && (labelStyle.opacity !== "1" || labelStyle.filter !== "none" || labelStyle.backdropFilter !== "none" ||
    labelStyle.mixBlendMode !== "normal" || !identity(labelStyle.transform) || labelStyle.maskImage !== "none" || labelStyle.clipPath !== "none" ||
    rgba(labelStyle.backgroundColor)[3] !== 0 || labelStyle.backgroundImage !== "none" || labelStyle.visibility !== "visible")) conflicts.push("unverified label paint");
  if (paint.position !== "absolute" || paint.zIndex !== "-1" || text.isolation !== "isolate" || text.position !== "relative") conflicts.push("unverified paint order");
  if (paint.pointerEvents !== "none" || indicator.getAttribute("aria-hidden") !== "true" || indicator.tabIndex >= 0 || indicator.textContent?.trim()) conflicts.push("interactive decoration");
  if (foreground[3] !== 255 || background[3] !== 255 || rgba(text.backgroundColor)[3] !== 0 || text.backgroundImage !== "none" || paint.backgroundImage !== "none") conflicts.push("non-opaque or layered paint");
  if (paint.display === "none" || paint.visibility !== "visible" || text.visibility !== "visible" || indicator.getAnimations().some(animation => animation.playState === "running")) conflicts.push("hidden or moving decoration");
  for (const node of new Set([control, textElement])) for (const pseudo of ["::before", "::after"]) {
    const style = getComputedStyle(node, pseudo);
    if (!["none", "normal"].includes(style.content) && (rgba(style.backgroundColor)[3]! > 0 || style.backgroundImage !== "none" || style.boxShadow !== "none")) conflicts.push("painted pseudo-element");
  }
  const fit = Math.abs(fill.left - box.left - control.clientLeft) <= 1 && Math.abs(fill.top - box.top - control.clientTop) <= 1 &&
    Math.abs(fill.width - control.clientWidth) <= 1 && Math.abs(fill.height - control.clientHeight) <= 1;
  const ranges = [...textElement.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()).flatMap(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    return [...range.getClientRects()].filter(line => line.width > 0 && line.height > 0);
  });
  const textContained = ranges.length > 0 && ranges.every(line => line.left >= fill.left && line.right <= fill.right && line.top >= fill.top && line.bottom <= fill.bottom);
  const hits = ranges.map(line => {
    const target = document.elementFromPoint((line.left + line.right) / 2, (line.top + line.bottom) / 2);
    return target === control || target === textElement;
  });
  const iconBox = labelledIcon ? icon!.getBoundingClientRect() : null;
  if (iconBox && ranges.some(line => Math.min(line.right, iconBox.right) - Math.max(line.left, iconBox.left) > 0.5 &&
    Math.min(line.bottom, iconBox.bottom) - Math.max(line.top, iconBox.top) > 0.5)) conflicts.push("icon overlaps label");
  const overlappingControls = [...group.querySelectorAll('button[data-slot="toggle-group-item"]')].filter(node => node !== control).some(node => {
    const other = node.getBoundingClientRect();
    return Math.min(other.right, fill.right) - Math.max(other.left, fill.left) > 1 && Math.min(other.bottom, fill.bottom) - Math.max(other.top, fill.top) > 1;
  });
  const luminance = (channels: number[]) => channels.slice(0, 3).map(channel => channel / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
  const a = luminance(foreground), b = luminance(background);
  const fontSize = Number.parseFloat(labelStyle.fontSize), fontWeight = Number.parseFloat(labelStyle.fontWeight);
  const requiredRatio = fontSize >= 24 || fontWeight >= 700 && fontSize >= 18.6667 ? 3 : 4.5;
  const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  return { kind: "opaque-selection-decoration", text: control.textContent?.trim(), foreground, background, contrast, requiredRatio,
    controlBox: box.toJSON(), indicatorBox: fill.toJSON(), iconBox: iconBox?.toJSON() ?? null, fit, textContained, hits, overlappingControls, conflicts,
    passed: conflicts.length === 0 && fit && textContained && hits.every(Boolean) && !overlappingControls && contrast >= requiredRatio };
}

export async function resolveSvgContrast(page: Page, result: AxeResults) {
  const review = [];
  for (const rule of result.incomplete.filter(rule => rule.id === "color-contrast")) {
    for (const node of rule.nodes) {
      const selector = node.target.length === 1 && typeof node.target[0] === "string" ? node.target[0] : null;
      const keys = [...node.any, ...node.all, ...node.none].map(check => check.data?.messageKey);
      const svgEligible = keys.length > 0 && keys.every(key => key === "imgNode");
      const selectionEligible = keys.length > 0 && keys.every(key => key === "bgOverlap");
      const measurement = selector && await page.locator(selector).count() === 1
        ? svgEligible ? await page.locator(selector).evaluate(measureAxisContrast)
          : selectionEligible ? await page.locator(selector).evaluate(measureSelectionContrast) : null
        : null;
      review.push({ target: node.target, originalReasons: keys, resolved: measurement?.passed === true, measurement });
    }
  }
  return review;
}
