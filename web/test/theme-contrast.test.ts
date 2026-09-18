import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const css = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
function variables(selector: string) {
  const content = css.slice(css.indexOf(selector + " {")).split("}")[0]!;
  return Object.fromEntries(
    [...content.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
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
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "card"],
  ["sidebar-foreground", "sidebar"],
  ["accent-foreground", "accent"],
  ["destructive", "background"],
];
describe("official Neutral theme", () => {
  for (const mode of [":root", ".dark"])
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
  it("provides system dark mode before JavaScript without palette overrides", () => {
    expect(css).toContain(":root:not([data-theme])");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).not.toMatch(/data-palette|perpay:palette|status-refund/);
  });
});
