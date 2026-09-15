import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
const fromRoot = resolve(process.cwd(), "web/src/styles/themes.css");
const css = readFileSync(existsSync(fromRoot) ? fromRoot : resolve(process.cwd(), "src/styles/themes.css"), "utf8");

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
}
function contrast(a: string, b: string) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0]! + .05) / (values[1]! + .05); }
const definitions = [...css.matchAll(/:root\[data-palette="([^"]+)"\]\[data-theme="([^"]+)"\]\s*\{([^}]+)\}/g)].map(match => ({
  palette: match[1]!, mode: match[2]!, tokens: Object.fromEntries([...match[3]!.matchAll(/--([a-z-]+):\s*(#[0-9a-f]+);/g)].map(token => [token[1]!, token[2]!])),
}));

describe("complete palette contrast", () => {
  it("defines all five palettes in both brightness modes", () => expect(definitions).toHaveLength(10));
  it.each(definitions)("keeps normal and secondary text, selection and controls readable in $palette/$mode", ({ tokens }) => {
    for (const [foreground, background] of [["ink", "surface"], ["muted", "surface"], ["muted", "canvas"], ["muted", "surface-muted"], ["accent", "accent-soft"], ["on-accent", "accent"], ["on-accent", "accent-hover"], ["accent", "surface"]]) {
      expect(contrast(tokens[foreground!]!, tokens[background!]!), foreground + " on " + background).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of ["line-strong", "chart-orders", "accent"]) expect(contrast(tokens[foreground]!, tokens.surface!)).toBeGreaterThanOrEqual(3);
  });
  it.each(["light", "dark"])("keeps success, warning, error and information independent from the %s palette", mode => {
    const block = mode === "light" ? css.match(/:root \{ --success:[^}]+\}/)![0] : css.match(/:root\[data-theme="dark"\] \{ --success:[^}]+\}/)![0];
    const tokens = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]+);/g)].map(token => [token[1]!, token[2]!]));
    for (const semantic of ["success", "warning", "danger", "info"]) expect(contrast(tokens[semantic]!, tokens[semantic + "-soft"]!)).toBeGreaterThanOrEqual(4.5);
  });
});
