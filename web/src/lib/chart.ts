export interface ChartBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function chartScale(values: readonly number[]) {
  const maximum = Math.max(1, ...values);
  const approximate = maximum / 3;
  const magnitude = 10 ** Math.floor(Math.log10(approximate));
  const multiplier = [1, 2, 5, 10].find((value) => value * magnitude >= approximate) ?? 10;
  const step = Math.max(1, multiplier * magnitude);
  const ceiling = Math.ceil(maximum / step) * step;
  const ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step);
  return { maximum: ceiling, ticks };
}

export function areaGeometry(values: readonly number[], bounds: ChartBounds, maximum: number) {
  const points = values.map((value, index) => ({
    horizontal: values.length === 1 ? (bounds.left + bounds.right) / 2 : bounds.left + index / (values.length - 1) * (bounds.right - bounds.left),
    vertical: bounds.bottom - Math.max(0, value) / maximum * (bounds.bottom - bounds.top),
  }));
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return { points, line: "", area: "" };
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.horizontal},${point.vertical}`).join(" ");
  const area = points.length === 1
    ? `M${first.horizontal - 2},${bounds.bottom} L${first.horizontal - 2},${first.vertical} L${first.horizontal + 2},${first.vertical} L${first.horizontal + 2},${bounds.bottom} Z`
    : `${line} L${last.horizontal},${bounds.bottom} L${first.horizontal},${bounds.bottom} Z`;
  return { points, line, area };
}

export function chartIndex(horizontal: number, bounds: ChartBounds, length: number) {
  if (length <= 1) return 0;
  return Math.max(0, Math.min(length - 1, Math.round((horizontal - bounds.left) / (bounds.right - bounds.left) * (length - 1))));
}
