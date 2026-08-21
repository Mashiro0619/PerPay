import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface WebAsset {
  readonly body: string | Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly etag: string;
}

interface AssetSource {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string;
}

function generatedAsset(fileName: string, contentType: string): AssetSource {
  return {
    bytes: readFileSync(new URL(`../../../web-dist/${fileName}`, import.meta.url)),
    contentType,
    fileName,
  };
}

function staticAsset(fileName: string, contentType: string): AssetSource {
  return {
    bytes: readFileSync(new URL(`../../../static/app/${fileName}`, import.meta.url)),
    contentType,
    fileName,
  };
}

const sources = Object.freeze({
  adminScript: generatedAsset("admin.js", "text/javascript; charset=utf-8"),
  alipayIcon: staticAsset("alipay.png", "image/png"),
  checkoutStylesheet: staticAsset("checkout.css", "text/css; charset=utf-8"),
  checkoutScript: staticAsset("checkout.js", "text/javascript; charset=utf-8"),
  meddonFont: staticAsset("Meddon-Regular.woff2", "font/woff2"),
});

function contentAddress(source: AssetSource): string {
  const digest = createHash("sha256").update(source.bytes).digest("hex");
  return `/assets/app/${digest}/${source.fileName}`;
}

export const WEB_ASSET_URLS = Object.freeze({
  adminScript: contentAddress(sources.adminScript),
  alipayIcon: contentAddress(sources.alipayIcon),
  checkoutStylesheet: contentAddress(sources.checkoutStylesheet),
  checkoutScript: contentAddress(sources.checkoutScript),
  meddonFont: contentAddress(sources.meddonFont),
});

const assets = new Map<string, WebAsset>(
  (Object.keys(sources) as Array<keyof typeof sources>).map((key) => {
    const source = sources[key];
    const digest = createHash("sha256").update(source.bytes).digest("base64url");
    return [
      WEB_ASSET_URLS[key],
      Object.freeze({
        body: source.contentType.startsWith("text/")
          ? source.bytes.toString("utf8")
          : Uint8Array.from(source.bytes),
        contentType: source.contentType,
        etag: `"${digest}"`,
      }),
    ];
  }),
);

export const WEB_ASSET_PATHS = Object.freeze([...assets.keys()]);

export function webAsset(path: string): WebAsset | null {
  return assets.get(path) ?? null;
}
