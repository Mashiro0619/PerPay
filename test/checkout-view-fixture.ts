import assert from "node:assert/strict";
import type { CheckoutInitial } from "../src/shared/checkout-view.ts";
export function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
export function readCheckoutInitial(html: string): CheckoutInitial {
  const encoded = /<div id="checkout-root" data-initial="([^"]+)"/.exec(
    html,
  )?.[1];
  assert.ok(
    encoded,
    "checkout must contain its escaped public bootstrap projection",
  );
  return JSON.parse(decodeHtml(encoded)) as CheckoutInitial;
}
export function checkoutText(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, ""));
}
