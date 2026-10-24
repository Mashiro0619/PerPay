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

export async function resolveSvgContrast(page: Page, result: AxeResults) {
  const review = [];
  for (const rule of result.incomplete.filter(rule => rule.id === "color-contrast")) {
    for (const node of rule.nodes) {
      const selector = node.target.length === 1 && typeof node.target[0] === "string" ? node.target[0] : null;
      const keys = [...node.any, ...node.all, ...node.none].map(check => check.data?.messageKey);
      const eligible = keys.length > 0 && keys.every(key => key === "imgNode");
      const measurement = selector && eligible && await page.locator(selector).count() === 1
        ? await page.locator(selector).evaluate(measureAxisContrast)
        : null;
      review.push({ target: node.target, originalReasons: keys, resolved: measurement?.passed === true, measurement });
    }
  }
  return review;
}
