import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface WebAsset {
  readonly body: string;
  readonly contentType: string;
  readonly etag: string;
}

interface AssetSource {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly fileName: string;
  readonly namespace: "app" | "vendor/usuzumi";
}

function vendorAsset(specifier: string, fileName: string, contentType: string): AssetSource {
  return {
    bytes: readFileSync(new URL(import.meta.resolve(specifier))),
    contentType,
    fileName,
    namespace: "vendor/usuzumi",
  };
}

function applicationAsset(fileName: string, contentType: string): AssetSource {
  return {
    bytes: readFileSync(new URL(`../../../static/app/${fileName}`, import.meta.url)),
    contentType,
    fileName,
    namespace: "app",
  };
}

const sources = Object.freeze({
  usuzumiStylesheet: vendorAsset(
    "usuzumi/usuzumi.min.css",
    "usuzumi.min.css",
    "text/css; charset=utf-8",
  ),
  usuzumiScript: vendorAsset(
    "usuzumi/usuzumi-core.min.js",
    "usuzumi-core.min.js",
    "text/javascript; charset=utf-8",
  ),
  adminStylesheet: applicationAsset("admin.css", "text/css; charset=utf-8"),
  adminScript: applicationAsset("admin.js", "text/javascript; charset=utf-8"),
  checkoutStylesheet: applicationAsset("checkout.css", "text/css; charset=utf-8"),
  checkoutScript: applicationAsset("checkout.js", "text/javascript; charset=utf-8"),
});

function contentAddress(source: AssetSource): string {
  const digest = createHash("sha256").update(source.bytes).digest("hex");
  return `/assets/${source.namespace}/${digest}/${source.fileName}`;
}

export const WEB_ASSET_URLS = Object.freeze({
  usuzumiStylesheet: contentAddress(sources.usuzumiStylesheet),
  usuzumiScript: contentAddress(sources.usuzumiScript),
  adminStylesheet: contentAddress(sources.adminStylesheet),
  adminScript: contentAddress(sources.adminScript),
  checkoutStylesheet: contentAddress(sources.checkoutStylesheet),
  checkoutScript: contentAddress(sources.checkoutScript),
});

const assets = new Map<string, WebAsset>(
  (Object.keys(sources) as Array<keyof typeof sources>).map((key) => {
    const source = sources[key];
    const digest = createHash("sha256").update(source.bytes).digest("base64url");
    return [
      WEB_ASSET_URLS[key],
      Object.freeze({
        body: source.bytes.toString("utf8"),
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
