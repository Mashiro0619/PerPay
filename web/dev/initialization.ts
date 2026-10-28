import { DEFAULT_SYSTEM_NAME, SYSTEM_NAME_MARKER } from "../../src/shared/branding.ts";
import type { Plugin } from "vite";

const marker = "__PERPAY_INITIALIZED__";
const setupTokenMarker = "__PERPAY_SETUP_TOKEN_REQUIRED__";

export async function withBackendInitialization(
  html: string,
  backend: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const fallback = html.replaceAll(SYSTEM_NAME_MARKER, DEFAULT_SYSTEM_NAME);
  if (!html.includes(marker) && !html.includes(setupTokenMarker)) return fallback;
  try {
    const response = await request(new URL("/admin/", backend), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return fallback;
    const backendHtml = await response.text();
    const initialized = backendHtml.match(
      /<meta\b[^>]*\bname=["']perpay-initialized["'][^>]*\bcontent=["'](true|false)["']/,
    )?.[1];
    const setupTokenRequired = backendHtml.match(
      /<meta\b[^>]*\bname=["']perpay-setup-token-required["'][^>]*\bcontent=["'](true|false)["']/,
    )?.[1];
    // Unknown is not first-run: the auth screen will offer a retry instead.
    const encodedName = backendHtml.match(/<meta\b[^>]*\bname=["']perpay-system-name["'][^>]*\bcontent="([^"<>]*)"/)?.[1];
    const marked = /<html\b[^>]*data-perpay-demo="readonly"/.test(backendHtml) ? html.replace("<html", '<html data-perpay-demo="readonly"') : html;
    const branded = encodedName ? marked.replaceAll(SYSTEM_NAME_MARKER, () => encodedName) : marked.replaceAll(SYSTEM_NAME_MARKER, DEFAULT_SYSTEM_NAME);
    const resolved = initialized ? branded.replace(marker, initialized) : branded;
    return setupTokenRequired ? resolved.replace(setupTokenMarker, setupTokenRequired) : resolved;
  } catch {
    return fallback;
  }
}

export function adminInitialization(backend: string): Plugin {
  return {
    name: "perpay-admin-initialization",
    apply: "serve",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => withBackendInitialization(html, backend),
    },
  };
}
