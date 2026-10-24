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
  // Near-edge samples exercise the extension outside a 36px visible control.
  const points = [.02, .5, .98].flatMap(x => [.02, .5, .98].map(y => {
    const point = { x: left + (right - left) * x, y: top + (bottom - top) * y };
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
    visual,
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
  expect(geometry.width, `effective touch width; ${diagnostic}`).toBeGreaterThanOrEqual(43.5);
  expect(geometry.height, `effective touch height; ${diagnostic}`).toBeGreaterThanOrEqual(43.5);
  expect(geometry.fits, `entire touch target is inside the visible browser area; ${diagnostic}`).toBe(true);
  if (hitTest) expect(geometry.hits, `nine near-edge points hit the control or its children; ${diagnostic}`).toBe(true);
  return geometry;
}

export async function tapOutsideVisible(page: Page, target: Locator, edge: "top" | "bottom" | "left" | "right") {
  const geometry = await expectTouchTarget(target);
  const { visual } = geometry;
  const point = {
    x: edge === "left" ? visual.x - 3 : edge === "right" ? visual.x + visual.width + 3 : visual.x + visual.width / 2,
    y: edge === "top" ? visual.y - 3 : edge === "bottom" ? visual.y + visual.height + 3 : visual.y + visual.height / 2,
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
