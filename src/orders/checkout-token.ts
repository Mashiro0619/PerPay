import { createHash, createHmac } from "node:crypto";

export const CHECKOUT_TOKEN_KEY_BYTES = 32;
export const CHECKOUT_TOKEN_PREFIX = "pct1_";
export const CHECKOUT_TOKEN_DERIVATION_VERSION = 1;

const CHECKOUT_TOKEN_BYTES = 32;
const CHECKOUT_TOKEN_PAYLOAD_CHARACTERS = 43;
const CHECKOUT_TOKEN_DERIVATION_DOMAIN = "perpay:checkout-token";
const CHECKOUT_TOKEN_DERIVATION_CONTEXT =
  `${CHECKOUT_TOKEN_DERIVATION_DOMAIN}:v${CHECKOUT_TOKEN_DERIVATION_VERSION}\0`;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checkoutTokenPattern = /^pct1_[A-Za-z0-9_-]{43}$/;

function assertCheckoutTokenKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array)) {
    throw new TypeError("Checkout token key must be a Uint8Array.");
  }
  if (key.byteLength !== CHECKOUT_TOKEN_KEY_BYTES) {
    throw new RangeError(
      `Checkout token key must contain exactly ${CHECKOUT_TOKEN_KEY_BYTES} bytes.`,
    );
  }
}

function assertCanonicalCheckoutId(checkoutId: string): void {
  if (typeof checkoutId !== "string" || !canonicalUuidPattern.test(checkoutId)) {
    throw new TypeError("Checkout ID must be a canonical lowercase UUID.");
  }
}

/**
 * Derives a stable public capability from an internal checkout ID.
 *
 * The versioned HMAC transcript is ASCII
 * `perpay:checkout-token:v1\0<canonical-checkout-uuid>`. The public prefix is
 * separately versioned so parsers can reject unknown token formats before lookup.
 */
export function deriveCheckoutToken(key: Uint8Array, checkoutId: string): string {
  assertCheckoutTokenKey(key);
  assertCanonicalCheckoutId(checkoutId);

  const payload = createHmac("sha256", key)
    .update(CHECKOUT_TOKEN_DERIVATION_CONTEXT, "ascii")
    .update(checkoutId, "ascii")
    .digest("base64url");
  return `${CHECKOUT_TOKEN_PREFIX}${payload}`;
}

export function isCanonicalCheckoutToken(token: unknown): token is string {
  if (typeof token !== "string" || !checkoutTokenPattern.test(token)) return false;

  const payload = token.slice(CHECKOUT_TOKEN_PREFIX.length);
  const decoded = Buffer.from(payload, "base64url");
  return (
    payload.length === CHECKOUT_TOKEN_PAYLOAD_CHARACTERS &&
    decoded.byteLength === CHECKOUT_TOKEN_BYTES &&
    decoded.toString("base64url") === payload
  );
}

/** Returns the canonical lowercase SHA-256 digest stored for public-token lookup. */
export function digestCheckoutToken(token: string): string {
  if (!isCanonicalCheckoutToken(token)) {
    throw new TypeError("Checkout token is not canonical.");
  }
  return createHash("sha256").update(token, "ascii").digest("hex");
}
