import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const css = readFileSync(resolve(process.cwd(), "web/src/styles/theme.css"), "utf8");
function rawVariables(selector: string) {
  const index = css.indexOf(selector + " {");
  if (index === -1) throw new Error("Selector not found: " + selector);
  const content = css.slice(index + selector.length + 2).split("}")[0]!;
  return Object.fromEntries(
    [...content.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  );
}
const rootRaw = rawVariables(":root");
function variables(selector: string) {
  const raw = rawVariables(selector);
  const merged = { ...rootRaw, ...raw };
  const resolveToken = (value: string, depth = 0): string => {
    if (depth > 4) return value;
    const ref = /^var\(--([\w-]+)\)$/.exec(value.trim());
    if (ref && ref[1] && ref[1] in merged) return resolveToken(merged[ref[1]]!, depth + 1);
    return value;
  };
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, key === "sidebar-ring" ? value : resolveToken(value)]),
  );
}
function luminance(color: string) {
  const match = color.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/);
  if (!match) throw new Error("Expected an official OKLCH token: " + color);
  const L = Number(match[1]),
    C = Number(match[2]),
    h = (Number(match[3]) * Math.PI) / 180,
    a = C * Math.cos(h),
    b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}
const pairs = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["sidebar-foreground", "sidebar"],
  ["accent-foreground", "accent"],
  ["destructive", "background"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["danger-foreground", "danger"],
];
describe("official Neutral theme", () => {
  for (const mode of [":root", ".dark", ":root:not([data-theme])"])
    it(mode + " gives opaque focus indicators and input boundaries at least 3:1 on adjacent surfaces", () => {
      const tokens = variables(mode);
      expect(tokens["sidebar-ring"]).toBe("var(--ring)");
      for (const surface of ["background", "card", "popover", "secondary", "sidebar", "sidebar-accent"]) {
        expect(contrast(luminance(tokens.ring!), luminance(tokens[surface]!))).toBeGreaterThanOrEqual(3);
        expect(contrast(luminance(tokens["input-ring"]!), luminance(tokens[surface]!))).toBeGreaterThanOrEqual(3);
      }
      for (const surface of ["background", "card", "muted"]) {
        expect(contrast(luminance(tokens.input!), luminance(tokens[surface]!))).toBeGreaterThanOrEqual(3);
      }
    });
  for (const mode of [":root", ".dark", ":root:not([data-theme])"])
    it.each(pairs)(
      mode + " keeps %s readable on %s",
      (foreground, background) => {
        const tokens = variables(mode);
        const values = [
          luminance(tokens[foreground]!),
          luminance(tokens[background]!),
        ].sort((a, b) => b - a);
        expect(
          (values[0]! + 0.05) / (values[1]! + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
      },
    );
  it("provides system dark mode via color-scheme, light-dark(), Forced Colors Mode, and oklab color-mix", () => {
    const primitivesCss = readFileSync(resolve(process.cwd(), "web/src/styles/primitives.css"), "utf8");
    const stylesCss = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
    const checkoutCss = readFileSync(resolve(process.cwd(), "web/src/checkout/checkout-layout.css"), "utf8");
    expect(css).toContain("color-scheme: light dark;");
    expect(css).toContain("@supports (color: light-dark(white, black))");
    expect(css).toContain(":root:not([data-theme])");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).not.toMatch(/data-palette|perpay:palette|status-refund/);
    expect(primitivesCss).toContain("@media (forced-colors: active)");
    expect(stylesCss).not.toMatch(/color-mix\(in oklch/i);
    expect(checkoutCss).not.toMatch(/color-mix\(in oklch/i);
  });
});

// SVG opacity is composited in sRGB. For neutral colors all channels are equal,
// so encode/decode the luminance rather than blending linear-light luminances.
function neutralSrgb(color: string): number {
  expect(color).toMatch(/^oklch\([\d.]+ 0 0\)$/);
  const linear = luminance(color);
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}
function neutralLuminance(srgb: number): number {
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}
function contrast(first: number, second: number): number {
  const brighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (brighter + 0.05) / (darker + 0.05);
}

describe("neutral chart colors", () => {
  for (const mode of [":root", ".dark", ":root:not([data-theme])"])
    it.each(["muted", "card"])(mode + " keeps the amount bar distinct on %s", (surface) => {
      const tokens = variables(mode);
      expect(contrast(luminance(tokens["chart-1"]!), luminance(tokens[surface]!))).toBeGreaterThanOrEqual(3);
    });

  for (const mode of [":root", ".dark", ":root:not([data-theme])"])
    it.each([
      ["chart-1", "primary"],
      ["chart-2", "muted-foreground"],
    ])(mode + " keeps %s neutral and readable, including translucent marks", (series, semantic) => {
      const tokens = variables(mode);
      expect(tokens[series]).toBe(tokens[semantic]);
      const ink = neutralSrgb(tokens[series]!);
      const card = neutralSrgb(tokens.card!);
      const cursor = neutralSrgb(tokens.muted!) * 0.5 + card * 0.5;
      // Both idle and hovered columns retain at least 3:1 against their background.
      for (const background of [card, cursor]) {
        for (const opacity of [0.85, 1]) {
          const mark = ink * opacity + background * (1 - opacity);
          expect(contrast(neutralLuminance(mark), neutralLuminance(background))).toBeGreaterThanOrEqual(3);
        }
      }
      // Area outlines stay distinct from even the strongest part of the fill.
      const area = ink * 0.18 + card * 0.82;
      expect(contrast(neutralLuminance(ink), neutralLuminance(area))).toBeGreaterThanOrEqual(3);
    });

  it("uses the same series palette before and after dark-mode initialization", () => {
    const dark = variables(".dark");
    const fallback = variables(":root:not([data-theme])");
    for (const name of ["chart-1", "chart-2", "success", "success-foreground", "warning", "warning-foreground", "danger", "danger-foreground"]) expect(fallback[name]).toBe(dark[name]);
  });
});
