import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import type { WebAsset } from "./assets.ts";

export interface AdminFrontend {
  readonly render: (initialized: boolean) => string;
  readonly assets: ReadonlyMap<string, WebAsset>;
}

export function loadAdminFrontend(root = new URL("../../../web-dist/admin/", import.meta.url)): AdminFrontend | null {
  let template: string;
  try {
    template = readFileSync(new URL("index.html", root), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const assets = new Map<string, WebAsset>();
  const files = ["favicon.svg", "theme.js", ...readdirSync(new URL("assets/", root)).map((file) => `assets/${file}`)];
  for (const file of files) {
    const extension = file.split(".").at(-1);
    const contentType = extension === "js" ? "text/javascript; charset=utf-8"
      : extension === "css" ? "text/css; charset=utf-8"
      : extension === "svg" ? "image/svg+xml"
      : extension === "woff2" ? "font/woff2"
      : null;
    if (contentType === null || !/^(?:assets\/)?[A-Za-z0-9._-]+$/.test(file)) continue;
    const bytes = readFileSync(new URL(file, root));
    assets.set(`/admin/${file}`, Object.freeze({
      body: Uint8Array.from(bytes),
      contentType,
      etag: `"${createHash("sha256").update(bytes).digest("base64url")}"`,
    }));
  }
  return {
    render: (initialized) => template.replace("__PERPAY_INITIALIZED__", String(initialized)),
    assets,
  };
}
