import { DEFAULT_SYSTEM_NAME, SYSTEM_NAME_MARKER, escapeSystemName } from "../../shared/branding.ts";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import type { WebAsset } from "./assets.ts";

export interface AdminFrontend {
  readonly render: (initialized: boolean, systemName?: string, setupTokenEnabled?: boolean, cspNonce?: string) => string;
  readonly assets: ReadonlyMap<string, WebAsset>;
}

const CSP_NONCE_MARKER = "__PERPAY_CSP_NONCE__";
const THEME_SCRIPT_MARKER = "__PERPAY_THEME_SCRIPT__";

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function loadAdminFrontend(root = new URL("../../../web-dist/admin/", import.meta.url)): AdminFrontend | null {
  let template: string;
  try {
    template = readFileSync(new URL("index.html", root), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const themeInline = readFileSync(new URL("theme.js", root), "utf8").trim();
  // Reserve the static theme.js slot and stamp nonce placeholders only on build-time Vite
  // script/modulepreload tags before any runtime values (such as systemName) are interpolated.
  const preparedTemplate = template
    .replace('<script src="/admin/theme.js"></script>', THEME_SCRIPT_MARKER)
    .replaceAll("<script ", `<script nonce="${CSP_NONCE_MARKER}" `)
    .replaceAll('<link rel="modulepreload" ', `<link rel="modulepreload" nonce="${CSP_NONCE_MARKER}" `);
  const assets = new Map<string, WebAsset>();
  const files = ["theme.js", ...readdirSync(new URL("assets/", root)).map((file) => `assets/${file}`)];
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
    render: (initialized, systemName = DEFAULT_SYSTEM_NAME, setupTokenEnabled = false, cspNonce) => preparedTemplate
      .replace(THEME_SCRIPT_MARKER, () =>
        cspNonce
          ? `<script nonce="${escapeHtmlAttribute(cspNonce)}">${themeInline}</script>`
          : '<script src="/admin/theme.js"></script>',
      )
      .replaceAll(` nonce="${CSP_NONCE_MARKER}"`, () => (cspNonce ? ` nonce="${escapeHtmlAttribute(cspNonce)}"` : ""))
      .replace("__PERPAY_INITIALIZED__", String(initialized))
      .replace("__PERPAY_SETUP_TOKEN_REQUIRED__", String(!initialized && setupTokenEnabled))
      .replaceAll(SYSTEM_NAME_MARKER, () => escapeSystemName(systemName)),
    assets,
  };
}
