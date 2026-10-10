import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, {
  type AtRule,
  type Document as CssDocument,
  type Root,
  type Rule,
} from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
const sheet = postcss.parse(css);

function rules(selector: string) {
  const found: Rule[] = [];
  sheet.walkRules((rule) => {
    if (rule.selectors.includes(selector)) found.push(rule);
  });
  return found;
}

function declarations(rule: Rule) {
  return Object.fromEntries(
    rule.nodes.flatMap((node) =>
      node.type === "decl" ? [[node.prop, node.value]] : [],
    ),
  );
}

function base(selector: string) {
  return Object.assign(
    {},
    ...rules(selector)
      .filter((rule) => rule.parent?.type === "root")
      .map(declarations),
  ) as Record<string, string>;
}

function mediaFor(rule: Rule) {
  for (
    let parent: Rule | AtRule | Root | CssDocument | undefined = rule.parent;
    parent;
    parent = parent.parent
  ) {
    if (parent.type === "atrule" && parent.name === "media") return parent.params;
  }
  return undefined;
}

function luminance(color: string) {
  const match = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!match) throw new Error("Expected an opaque theme token: " + color);
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]) * Math.PI / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return (
    0.2126 * clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function theme(selector: string) {
  return Object.assign({}, base(":root"), ...rules(selector).map(declarations));
}

function color(value: string, tokens: Record<string, string>) {
  const name = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (!name || !tokens[name]) throw new Error("Expected a named theme color: " + value);
  return tokens[name]!;
}

describe("website overview card layout", () => {
  it("uses the section width and 16px gutters for the one-to-four-column grid", () => {
    expect(base(".site-overview-section")).toMatchObject({
      "container-name": "site-overview",
      "container-type": "inline-size",
      "min-width": "0",
    });
    expect(base(".site-overview-grid")).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr)",
      gap: "1rem",
      margin: "0",
      padding: "0",
      "list-style": "none",
    });
    const columns: [number, number][] = [];
    sheet.walkAtRules("container", (container) => {
      const match = container.params.match(/^site-overview \(min-width: (\d+)rem\)$/);
      if (!match) return;
      container.walkRules(".site-overview-grid", (rule) => {
        const count = declarations(rule)["grid-template-columns"]?.match(/^repeat\((\d+),/);
        if (count) columns.push([Number(match[1]), Number(count[1])]);
      });
    });
    expect(columns).toEqual([[41, 2], [62, 3], [83, 4]]);
    for (const [width, expected] of [[20, 1], [40.99, 1], [41, 2], [61.99, 2], [62, 3], [82.99, 3], [83, 4]]) {
      const actual = columns.reduce((count, [minimum, next]) => width! >= minimum ? next : count, 1);
      expect(actual).toBe(expected);
    }
    expect(css).not.toContain(".site-overview-table");
  });

  it("keeps whole-card navigation out of inline-link and coarse-pointer layout rules", () => {
    const card = document.createElement("a");
    card.href = "/sites/shop";
    card.className = "site-overview-card";
    card.dataset.slot = "site-overview-card";
    card.dataset.internalLink = "true";
    const text = document.createElement("a");
    text.href = "/orders";
    text.dataset.internalLink = "true";
    const inlineRules: Rule[] = [];
    sheet.walkRules((rule) => {
      if (rule.selector.startsWith("a[data-internal-link]:not(")) inlineRules.push(rule);
    });
    expect(inlineRules).toHaveLength(2);
    for (const rule of inlineRules) {
      expect(card.matches(rule.selector)).toBe(false);
      expect(text.matches(rule.selector)).toBe(true);
    }
    expect(base(".site-overview-card")).toMatchObject({
      display: "block",
      width: "100%",
      height: "100%",
      "text-decoration": "none",
    });
  });

  it("keeps natural card height with compact spacing and a four-pixel amount bar", () => {
    expect(base(".site-overview-card-surface")).toMatchObject({
      padding: "1rem",
      gap: "0.75rem",
    });
    expect(base('.site-overview-card-surface > [data-slot="card-content"]')).toMatchObject({
      padding: "0",
      gap: "0.75rem",
    });
    for (const selector of [".site-overview-card", ".site-overview-card-surface", ".site-overview-card-heading"]) {
      expect(base(selector)["min-height"]).toBeUndefined();
      expect(base(selector).height ?? "").not.toMatch(/px|rem|vh/);
    }
    expect(base(".site-overview-amount-bar")).toMatchObject({
      width: "100%",
      height: "4px",
      color: "var(--chart-1)",
    });
    expect(base(".site-overview-amount-track").fill).toBe("var(--muted)");
  });

  it("wraps titles normally and scales long amounts without clipping their digits", () => {
    expect(base(".site-overview-card-title")).toMatchObject({
      "-webkit-line-clamp": "2",
      "white-space": "normal",
      "word-break": "normal",
      "overflow-wrap": "anywhere",
    });
    const amount = base(".site-overview-card-amount");
    expect(amount["font-variant-numeric"]).toContain("tabular-nums");
    expect(amount["white-space"]).toBe("nowrap");
    expect(amount.overflow).toBeUndefined();
    expect(amount["text-overflow"]).toBeUndefined();
    expect(base(".site-overview-card-surface")["container-type"]).toBe("inline-size");
    expect(base('.site-overview-card-amount[data-wide="true"]')["font-size"]).toContain("cqi");
  });

  it("restricts hover to fine pointers and gives active and keyboard feedback without movement", () => {
    const hover = rules(".site-overview-card:hover .site-overview-card-surface");
    expect(hover).toHaveLength(1);
    expect(mediaFor(hover[0]!)).toBe("(hover: hover) and (pointer: fine)");
    expect(base(".site-overview-card:focus-visible").outline).toBe("2px solid var(--foreground)");
    expect(base(".site-overview-card:active .site-overview-card-surface")["box-shadow"]).toBeTruthy();
    sheet.walkRules((rule) => {
      if (!rule.selector.includes(".site-overview-")) return;
      const properties = declarations(rule);
      for (const property of ["transform", "translate", "scale", "rotate"]) {
        expect(properties[property]).toBeUndefined();
      }
    });
    const reduced = rules(".site-overview-card-surface")
      .find((rule) => mediaFor(rule) === "(prefers-reduced-motion: reduce)");
    expect(reduced && declarations(reduced).transition).toBe("none");
  });

  it.each([":root", ".dark", ":root:not([data-theme])"])(
    "keeps names, amounts, supporting text, warning badges and the amount bar readable in %s",
    (mode) => {
      const tokens = theme(mode);
      const surface = color(base(".site-overview-card-surface").background!, tokens);
      for (const selector of [
        ".site-overview-card-title",
        ".site-overview-card-amount",
      ]) {
        expect(contrast(color(base(selector).color!, tokens), surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(tokens["--muted-foreground"]!, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens["--warning-foreground"]!, tokens["--warning"]!)).toBeGreaterThanOrEqual(4.5);
      const bar = color(base(".site-overview-amount-bar").color!, tokens);
      const track = color(base(".site-overview-amount-track").fill!, tokens);
      expect(contrast(bar, track)).toBeGreaterThanOrEqual(3);
      expect(contrast(bar, surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens["--foreground"]!, tokens["--background"]!)).toBeGreaterThanOrEqual(3);
    },
  );
});
