import type { Plugin } from "vite";

const marker = "__PERPAY_INITIALIZED__";

export async function withBackendInitialization(
  html: string,
  backend: string,
  request: typeof fetch = fetch,
): Promise<string> {
  if (!html.includes(marker)) return html;
  try {
    const response = await request(new URL("/admin/", backend), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "text/html" },
    });
    if (!response.ok) return html;
    const backendHtml = await response.text();
    const initialized = backendHtml.match(
      /<meta\b[^>]*\bname=["']perpay-initialized["'][^>]*\bcontent=["'](true|false)["']/,
    )?.[1];
    // Unknown is not first-run: the auth screen will offer a retry instead.
    return initialized ? html.replace(marker, initialized) : html;
  } catch {
    return html;
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
