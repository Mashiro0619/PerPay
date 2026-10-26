import { expect, type Locator, type Page } from "@playwright/test";

/** Measure the visible control and its generated touch extension, then probe the real hit area. */
export function measureTouchTarget(element: Element) {
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const before = getComputedStyle(element, "::before");
  const length = (value: string, reference: number, fallback = 0) => {
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return fallback;
    return value.endsWith("%") ? number * reference / 100 : number;
  };
  const visual = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const margin = {
    left: length(style.marginLeft, 0), right: length(style.marginRight, 0),
    top: length(style.marginTop, 0), bottom: length(style.marginBottom, 0),
  };
  const slot = {
    x: bounds.x - margin.left, y: bounds.y - margin.top,
    width: bounds.width + margin.left + margin.right,
    height: bounds.height + margin.top + margin.bottom,
  };
  let left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom;
  const generated = before.content !== "none" && before.content !== "normal" &&
    before.display !== "none" && before.visibility !== "hidden" &&
    before.position === "absolute" && before.pointerEvents !== "none";
  if (generated) {
    const width = length(before.width, element.clientWidth);
    const height = length(before.height, element.clientHeight);
    const x = bounds.left + length(style.borderLeftWidth, bounds.width) +
      length(before.left, element.clientWidth, element.clientWidth - length(before.right, element.clientWidth) - width);
    const y = bounds.top + length(style.borderTopWidth, bounds.height) +
      length(before.top, element.clientHeight, element.clientHeight - length(before.bottom, element.clientHeight) - height);
    const origin = before.transformOrigin.split(" ");
    const originX = length(origin[0] ?? "50%", width), originY = length(origin[1] ?? "50%", height);
    const matrix = new DOMMatrixReadOnly(before.transform === "none" ? undefined : before.transform);
    const translate = before.translate === "none" ? [] : before.translate.split(" ");
    const translateX = length(translate[0] ?? "0", width), translateY = length(translate[1] ?? "0", height);
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([dx = 0, dy = 0]) => ({
      x: x + (dx - originX) * matrix.a + (dy - originY) * matrix.c + originX + matrix.e + translateX,
      y: y + (dx - originX) * matrix.b + (dy - originY) * matrix.d + originY + matrix.f + translateY,
    }));
    left = Math.min(left, ...corners.map(point => point.x));
    top = Math.min(top, ...corners.map(point => point.y));
    right = Math.max(right, ...corners.map(point => point.x));
    bottom = Math.max(bottom, ...corners.map(point => point.y));
  }
  const viewport = window.visualViewport;
  const visible = {
    left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight,
  };
  // Probe the full extension on compact controls. Native rounded controls may
  // be much wider/taller: verify an actual central 40px target within them,
  // avoiding curved corners outside that target.
  const probeWidth = generated ? right - left : Math.min(40, right - left);
  const probeHeight = generated ? bottom - top : Math.min(40, bottom - top);
  const probeLeft = (left + right - probeWidth) / 2;
  const probeTop = (top + bottom - probeHeight) / 2;
  // Subpixel points less than 1 CSS px from a shared edge can be rounded
  // into the adjacent row by Chromium's hit test.
  const insetX = Math.max(1, probeWidth * .02);
  const insetY = Math.max(1, probeHeight * .02);
  const points = [insetX, probeWidth / 2, probeWidth - insetX].flatMap(x => [insetY, probeHeight / 2, probeHeight - insetY].map(y => {
    const point = { x: probeLeft + x, y: probeTop + y };
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      ...point,
      hit: hit !== null && (hit === element || element.contains(hit)),
      owner: hit === null ? null : {
        tag: hit.tagName.toLowerCase(),
        slot: hit.getAttribute("data-slot"),
        label: hit.getAttribute("aria-label") ?? hit.textContent?.trim().slice(0, 120),
      },
    };
  }));
  return {
    label: element.getAttribute("aria-label") ?? element.textContent,
    visual, slot,
    x: left, y: top, width: right - left, height: bottom - top,
    generated,
    fits: left >= visible.left - 1 && top >= visible.top - 1 &&
      right <= visible.left + visible.width + 1 && bottom <= visible.top + visible.height + 1,
    points, hits: points.every(point => point.hit),
  };
}

export async function expectTouchTarget(target: Locator, { hitTest = true } = {}) {
  await expect(target).toBeVisible();
  const geometry = await target.evaluate(measureTouchTarget);
  const diagnostic = `${geometry.label ?? "unlabelled target"}: ${JSON.stringify(geometry)}`;
  expect(geometry.width, `effective touch width; ${diagnostic}`).toBeGreaterThanOrEqual(39.5);
  expect(geometry.height, `effective touch height; ${diagnostic}`).toBeGreaterThanOrEqual(39.5);
  expect(geometry.fits, `entire touch target is inside the visible browser area; ${diagnostic}`).toBe(true);
  if (hitTest) expect(geometry.hits, `nine near-edge points hit the control or its children; ${diagnostic}`).toBe(true);
  return geometry;
}

/** Independent compact buttons reserve their generated target in normal flow. */
export async function expectTouchSlot(target: Locator) {
  const geometry = await expectTouchTarget(target);
  expect(geometry.x).toBeGreaterThanOrEqual(geometry.slot.x - .5);
  expect(geometry.y).toBeGreaterThanOrEqual(geometry.slot.y - .5);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(geometry.slot.x + geometry.slot.width + .5);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(geometry.slot.y + geometry.slot.height + .5);
  return geometry;
}

export async function expectTouchGap(first: Locator, second: Locator, axis: "horizontal" | "vertical") {
  const before = await expectTouchTarget(first);
  const after = await expectTouchTarget(second);
  const gap = axis === "horizontal" ? after.x - before.x - before.width : after.y - before.y - before.height;
  expect(gap, `space between independent touch targets: ${before.label} / ${after.label}`).toBeGreaterThanOrEqual(3.5);
  return gap;
}

export async function tapOutsideVisible(page: Page, target: Locator, edge: "top" | "bottom" | "left" | "right") {
  const geometry = await expectTouchTarget(target);
  const { visual } = geometry;
  const expansion = edge === "left" ? visual.x - geometry.x
    : edge === "right" ? geometry.x + geometry.width - visual.x - visual.width
    : edge === "top" ? visual.y - geometry.y
    : geometry.y + geometry.height - visual.y - visual.height;
  expect(expansion, "the requested edge has a generated extension outside the visible control").toBeGreaterThan(1);
  // Exercise the extension outside the compact visible control.
  const offset = Math.min(5, expansion - .75);
  const point = {
    x: edge === "left" ? visual.x - offset : edge === "right" ? visual.x + visual.width + offset : visual.x + visual.width / 2,
    y: edge === "top" ? visual.y - offset : edge === "bottom" ? visual.y + visual.height + offset : visual.y + visual.height / 2,
  };
  expect(point.x).toBeGreaterThanOrEqual(geometry.x);
  expect(point.x).toBeLessThanOrEqual(geometry.x + geometry.width);
  expect(point.y).toBeGreaterThanOrEqual(geometry.y);
  expect(point.y).toBeLessThanOrEqual(geometry.y + geometry.height);
  expect(await target.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y);
    return hit !== null && (hit === element || element.contains(hit));
  }, point), "a point outside the visible control still belongs to its touch target").toBe(true);
  await page.touchscreen.tap(point.x, point.y);
  return { geometry, point };
}
