import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CheckoutInitial } from "../../shared/checkout-view.ts";
interface ManifestEntry {
  file: string;
  css?: string[];
  imports?: string[];
  isEntry?: boolean;
}
interface CheckoutAsset {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  etag: string;
}
const require = createRequire(import.meta.url);
const root = new URL("../../../web-dist/checkout/", import.meta.url);
export function loadCheckoutFrontend() {
  let manifest: Record<string, ManifestEntry>;
  try {
    manifest = JSON.parse(
      readFileSync(new URL(".vite/manifest.json", root), "utf8"),
    ) as Record<string, ManifestEntry>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const entry = Object.values(manifest).find((item) => item.isEntry);
  if (!entry) throw new Error("checkout client manifest has no entry");
  const assets = new Map<string, CheckoutAsset>();
  function add(file: string) {
    if (!/^assets\/[A-Za-z0-9._-]+\.(?:js|css|woff2)$/.test(file))
      throw new Error("unsafe checkout manifest path");
    const bytes = readFileSync(new URL(file, root));
    const url = "/assets/checkout/" + file;
    assets.set(url, {
      body: Uint8Array.from(bytes),
      contentType: file.endsWith(".css")
        ? "text/css; charset=utf-8"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/javascript; charset=utf-8",
      etag: '"' + createHash("sha256").update(bytes).digest("base64url") + '"',
    });
    return url;
  }
  const visited = new Set<string>();
  function collect(item: ManifestEntry) {
    if (visited.has(item.file)) return;
    visited.add(item.file);
    add(item.file);
    for (const css of item.css ?? []) add(css);
    for (const id of item.imports ?? []) {
      const dependency = manifest[id];
      if (!dependency) throw new Error("checkout manifest dependency missing");
      collect(dependency);
    }
  }
  collect(entry);
  const theme = readFileSync(new URL("theme.js", root));
  const themeUrl =
    "/assets/checkout/theme-" +
    createHash("sha256").update(theme).digest("hex").slice(0, 16) +
    ".js";
  assets.set(themeUrl, {
    body: Uint8Array.from(theme),
    contentType: "text/javascript; charset=utf-8",
    etag: '"' + createHash("sha256").update(theme).digest("base64url") + '"',
  });
  const script = "/assets/checkout/" + entry.file;
  const styles = (entry.css ?? []).map((file) => "/assets/checkout/" + file);
  let renderer: ((initial: CheckoutInitial) => string) | undefined;
  return {
    assets,
    script,
    styles,
    theme: themeUrl,
    render(initial: CheckoutInitial) {
      renderer ??= (
        require(
          fileURLToPath(
            new URL(
              "../../../web-dist/checkout-ssr/renderer.cjs",
              import.meta.url,
            ),
          ),
        ) as { renderCheckout: (value: CheckoutInitial) => string }
      ).renderCheckout;
      return renderer(initial);
    },
  };
}
export const checkoutFrontend = loadCheckoutFrontend();
