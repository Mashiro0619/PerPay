import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("uses official primitives instead of native interactive substitutes in business views", () => {
  const root = resolve(process.cwd(), "web/src");
  const substitutes = new Set([
    "button",
    "input",
    "select",
    "textarea",
    "dialog",
    "details",
    "summary",
    "hr",
    "progress",
  ]);
  const violations: string[] = [];
  for (const file of globSync("**/*.tsx", { cwd: root })) {
    const name = file.replaceAll("\\", "/");
    if (name.startsWith("components/ui/")) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(resolve(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName)
      ) {
        const tag = node.tagName.text;
        // Hidden fields carry FormData only; a styled Input here would be incorrect.
        const hidden =
          tag === "input" &&
          node.attributes.properties.some(
            (attribute) =>
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(source) === "type" &&
              attribute.initializer &&
              ts.isStringLiteral(attribute.initializer) &&
              attribute.initializer.text === "hidden",
          );
        if (substitutes.has(tag) && !hidden) {
          violations.push(
            name +
              ":" +
              (source.getLineAndCharacterOfPosition(node.getStart(source))
                .line +
                1) +
              " <" +
              tag +
              ">",
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
