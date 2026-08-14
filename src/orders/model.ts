import { createHash } from "node:crypto";

import { z } from "zod";

export const MAX_REQUESTED_AMOUNT_CENTS = 9_999_999_998;
export const MAX_IDEMPOTENCY_KEY_BYTES = 256;
export const MAX_ORDER_DESCRIPTION_CHARACTERS = 200;
export const MAX_ORDER_DESCRIPTION_BYTES = MAX_ORDER_DESCRIPTION_CHARACTERS * 4;
export const IDEMPOTENCY_KEY_DIGEST_VERSION = 1;
export const CREATE_ORDER_REQUEST_FINGERPRINT_VERSION = 1;
export const MAX_ORDER_CLOCK_AHEAD_MILLISECONDS = 5 * 60 * 1000;

const merchantOrderNumberFirstCharacterPattern = /^[A-Za-z0-9]/;
const merchantOrderNumberInvalidCharacterPattern = /[^A-Za-z0-9._-]/;
const controlCharacterPattern = /\p{Cc}/u;

const idempotencyKeySchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: "must not contain leading or trailing whitespace",
  })
  .refine((value) => !controlCharacterPattern.test(value), {
    message: "must not contain control characters",
  })
  .refine((value) => hasOnlyUnicodeScalarValues(value), {
    message: "must contain only valid Unicode characters",
  })
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_IDEMPOTENCY_KEY_BYTES, {
    message: `must contain at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
  });

const orderDescriptionSchema = z
  .string()
  .refine((value) => hasOnlyUnicodeScalarValues(value), {
    message: "must contain only valid Unicode characters",
  })
  .refine((value) => unicodeCharacterCount(value) >= 1, {
    message: "must contain at least 1 Unicode character",
  })
  .refine((value) => unicodeCharacterCount(value) <= MAX_ORDER_DESCRIPTION_CHARACTERS, {
    message: `must contain at most ${MAX_ORDER_DESCRIPTION_CHARACTERS} Unicode characters`,
  })
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ORDER_DESCRIPTION_BYTES, {
    message: `must contain at most ${MAX_ORDER_DESCRIPTION_BYTES} UTF-8 bytes`,
  });

export const merchantOrderNumberSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      merchantOrderNumberFirstCharacterPattern.test(value) &&
      !merchantOrderNumberInvalidCharacterPattern.test(value),
    {
      message:
        "must start with an ASCII letter or digit and contain only A-Z, a-z, 0-9, ., _, or -",
    },
  );

export const createOrderRequestSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    merchant_order_no: merchantOrderNumberSchema,
    amount_cents: z.number().int().min(1).max(MAX_REQUESTED_AMOUNT_CENTS),
    description: orderDescriptionSchema.optional(),
  })
  .strict();

export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const currencySchema = z.literal("CNY");
export type Currency = z.infer<typeof currencySchema>;

export const checkoutStatusSchema = z.enum(["OPEN", "EXPIRED", "CLOSED"]);
export type CheckoutStatus = z.infer<typeof checkoutStatusSchema>;

export const paymentStatusSchema = z.enum([
  "UNPAID",
  "CONFIRMED",
  "DISPUTED",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const refundStatusSchema = z.enum(["NONE", "PARTIAL", "FULL"]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

export const paymentBasisSchema = z.enum(["NONE", "INFERRED", "MANUAL"]);
export type PaymentBasis = z.infer<typeof paymentBasisSchema>;

export interface PaymentOrder {
  readonly orderId: string;
  readonly apiClientId: string;
  readonly merchantOrderNo: string;
  readonly idempotencyKeyDigest: string;
  readonly idempotencyKeyDigestVersion: typeof IDEMPOTENCY_KEY_DIGEST_VERSION;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: typeof CREATE_ORDER_REQUEST_FINGERPRINT_VERSION;
  readonly requestedAmountCents: number;
  readonly payableAmountCents: number;
  readonly allocationOffsetMaximumCents: number;
  readonly receivedAmountCents: number | null;
  readonly currency: Currency;
  readonly description: string | null;
  readonly collectionProfileId: string;
  readonly checkoutStatus: CheckoutStatus;
  readonly paymentStatus: PaymentStatus;
  readonly refundStatus: RefundStatus;
  readonly paymentBasis: PaymentBasis;
  readonly eligibleFrom: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly closedAt: number | null;
  readonly updatedAt: number;
  readonly version: number;
}

export interface CheckoutSession {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly tokenDigest: string;
}

export interface CheckoutStateProjection {
  readonly status: CheckoutStatus;
  readonly expiresAt: number;
  readonly closedAt: number | null;
}

export interface PaymentStateProjection {
  readonly status: PaymentStatus;
  readonly basis: PaymentBasis;
  readonly receivedAmountCents: number | null;
}

export interface RefundStateProjection {
  readonly status: RefundStatus;
}

export interface PublicPaymentInstructions {
  readonly payableAmountCents: number;
  readonly currency: Currency;
  readonly collectionCodePayload: string;
}

/** Authenticated order data, including the deterministically reconstructed checkout reference. */
export interface OrderProjection {
  readonly orderId: string;
  readonly merchantOrderNo: string;
  readonly requestedAmountCents: number;
  readonly payableAmountCents: number;
  readonly receivedAmountCents: number | null;
  readonly currency: Currency;
  readonly description: string | null;
  readonly checkoutToken: string;
  readonly checkout: CheckoutStateProjection;
  readonly payment: PaymentStateProjection;
  readonly refund: RefundStateProjection;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

/** Public checkout data selected by a high-entropy token; it intentionally contains no token or internal IDs. */
export interface PublicCheckoutProjection {
  readonly merchantOrderNo: string;
  readonly requestedAmountCents: number;
  readonly currency: Currency;
  readonly description: string | null;
  readonly paymentInstructions: PublicPaymentInstructions | null;
  readonly checkout: CheckoutStateProjection;
  readonly payment: PaymentStateProjection;
  readonly refund: RefundStateProjection;
}

/**
 * Fingerprints a request after it has passed createOrderRequestSchema.
 * The fixed tuple layout is the versioned canonical format; changing it requires a new version.
 */
export function fingerprintCreateOrderRequest(request: CreateOrderRequest): string {
  const description = Object.hasOwn(request, "description")
    ? (["present", request.description] as const)
    : (["missing"] as const);
  const canonicalRequest = [
    "perpay:create-order-request",
    CREATE_ORDER_REQUEST_FINGERPRINT_VERSION,
    ["idempotency_key", request.idempotency_key],
    ["merchant_order_no", request.merchant_order_no],
    ["amount_cents", request.amount_cents],
    ["description", description],
  ] as const;

  return createHash("sha256").update(JSON.stringify(canonicalRequest), "utf8").digest("hex");
}

function unicodeCharacterCount(value: string): number {
  return Array.from(value).length;
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}
