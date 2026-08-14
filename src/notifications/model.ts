import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

import { parseStrictJson } from "../http/strict-json.ts";
import { isValidWebhookDnsHostname } from "../infrastructure/network/public-address.ts";
import { MAX_NOTIFY_URL_BYTES } from "../orders/model.ts";

export const WEBHOOK_PROTOCOL_VERSION = 1;
export const WEBHOOK_TARGET_FINGERPRINT_VERSION = 1;
export const WEBHOOK_DELIVERY_REQUEST_FINGERPRINT_VERSION = 1;
export const MAX_WEBHOOK_RESPONSE_BYTES = 16 * 1024;
export const MAX_WEBHOOK_REQUEST_BYTES = 128 * 1024;
export const MAX_WEBHOOK_REASON_CHARACTERS = 500;

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const controlCharacterPattern = /\p{Cc}/u;

export type WebhookTargetFormat = "NATIVE_JSON_V1";
export type WebhookDeliveryStatus =
  | "PENDING"
  | "LEASED"
  | "RETRY_WAIT"
  | "ACKNOWLEDGED"
  | "DEAD_LETTER";
export type WebhookAttemptOutcome =
  | "STARTED"
  | "ACKNOWLEDGED"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "OUTCOME_UNKNOWN";

export interface PreparedWebhookTarget {
  readonly format: WebhookTargetFormat;
  readonly url: string;
  readonly allowedOrigin: string;
  readonly urlFingerprint: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: typeof WEBHOOK_TARGET_FINGERPRINT_VERSION;
}

export interface WebhookEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly orderId: string;
  readonly orderVersion: number;
  readonly payloadJson: string;
  readonly payloadFingerprint: string;
  readonly createdAt: number;
}

export interface WebhookDelivery {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly predecessorDeliveryId: string | null;
  readonly requestKey: string;
  readonly requestedByType: "SYSTEM" | "ADMIN";
  readonly requestedByActorId: string | null;
  readonly reason: string | null;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly acknowledgedAt: number | null;
  readonly deadLetteredAt: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebhookAttempt {
  readonly attemptId: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  /** Internal lease token; never expose it through an HTTP projection. */
  readonly leaseToken: string;
  readonly keyVersion: number;
  readonly keyId: string;
  readonly requestTimestamp: number;
  readonly requestBodyFingerprint: string;
  readonly outcome: WebhookAttemptOutcome;
  readonly resolvedAddressesFingerprint: string | null;
  readonly connectedAddress: string | null;
  readonly httpStatus: number | null;
  readonly responseBytes: number | null;
  readonly responseFingerprint: string | null;
  readonly ackCode: string | null;
  readonly errorCode: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export const webhookReplayRequestSchema = z
  .object({
    redelivery_id: z.string().regex(uuidV4Pattern),
    reason: z
      .string()
      .refine((value) => value === value.trim(), {
        message: "must not contain leading or trailing whitespace",
      })
      .refine((value) => Array.from(value).length >= 1, {
        message: "must contain at least one Unicode character",
      })
      .refine((value) => Array.from(value).length <= MAX_WEBHOOK_REASON_CHARACTERS, {
        message: `must contain at most ${MAX_WEBHOOK_REASON_CHARACTERS} Unicode characters`,
      })
      .refine((value) => !controlCharacterPattern.test(value), {
        message: "must not contain control characters",
      })
      .refine((value) => hasOnlyUnicodeScalarValues(value), {
        message: "must contain only valid Unicode characters",
      }),
  })
  .strict();

export type WebhookReplayRequest = z.infer<typeof webhookReplayRequestSchema>;

export function isValidWebhookReason(value: string): boolean {
  const characters = Array.from(value).length;
  return value === value.trim() &&
    characters >= 1 &&
    characters <= MAX_WEBHOOK_REASON_CHARACTERS &&
    !controlCharacterPattern.test(value) &&
    hasOnlyUnicodeScalarValues(value);
}

export function prepareWebhookTarget(
  value: string,
  allowedOrigin: string,
): PreparedWebhookTarget {
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > MAX_NOTIFY_URL_BYTES ||
    controlCharacterPattern.test(value)
  ) {
    throw new WebhookTargetError("webhook_target_invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookTargetError("webhook_target_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    value.includes("#") ||
    value.endsWith("?") ||
    url.hash !== "" ||
    !isValidWebhookDnsHostname(url.hostname) ||
    url.origin !== allowedOrigin ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(`${url.pathname}${url.search}`)
  ) {
    throw new WebhookTargetError("webhook_target_not_allowed");
  }
  const normalized = url.toString();
  if (Buffer.byteLength(normalized, "utf8") > MAX_NOTIFY_URL_BYTES) {
    throw new WebhookTargetError("webhook_target_invalid");
  }
  const urlFingerprint = fingerprintTuple([
    "perpay:webhook-target-url",
    WEBHOOK_TARGET_FINGERPRINT_VERSION,
    normalized,
  ]);
  const requestFingerprint = fingerprintTuple([
    "perpay:webhook-target-request",
    WEBHOOK_TARGET_FINGERPRINT_VERSION,
    "NATIVE_JSON_V1",
    allowedOrigin,
    normalized,
  ]);
  return Object.freeze({
    format: "NATIVE_JSON_V1",
    url: normalized,
    allowedOrigin,
    urlFingerprint,
    requestFingerprint,
    requestFingerprintVersion: WEBHOOK_TARGET_FINGERPRINT_VERSION,
  });
}

export type WebhookTargetErrorCode =
  | "webhook_disabled"
  | "webhook_target_invalid"
  | "webhook_target_not_allowed";

export class WebhookTargetError extends Error {
  readonly code: WebhookTargetErrorCode;

  constructor(code: WebhookTargetErrorCode) {
    super(code);
    this.name = "WebhookTargetError";
    this.code = code;
  }
}

export function webhookSigningKeyFingerprint(secret: string): string {
  return createHash("sha256")
    .update("perpay:webhook-signing-key:v1\0", "utf8")
    .update(Buffer.from(secret, "base64url"))
    .digest("hex");
}

export function webhookDeliveryRequestFingerprint(input: {
  readonly eventId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly predecessorDeliveryId: string | null;
  readonly requestedByType: "SYSTEM" | "ADMIN";
  readonly requestedByActorId: string | null;
  readonly reason: string | null;
}): string {
  return fingerprintTuple([
    "perpay:webhook-delivery-request",
    WEBHOOK_DELIVERY_REQUEST_FINGERPRINT_VERSION,
    input.eventId,
    input.targetId,
    input.generation,
    input.predecessorDeliveryId,
    input.requestedByType,
    input.requestedByActorId,
    input.reason,
  ]);
}

export function webhookBodyFingerprint(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function webhookSignature(input: {
  readonly secret: string;
  readonly keyId: string;
  readonly timestamp: number;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly attemptNumber: number;
  readonly body: Uint8Array;
}): string {
  assertUuid(input.keyId, "webhook key ID");
  assertUuid(input.deliveryId, "webhook delivery ID");
  assertUuid(input.eventId, "webhook event ID");
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new RangeError("webhook signature timestamp is invalid");
  }
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new RangeError("webhook attempt number is invalid");
  }
  const bodyFingerprint = webhookBodyFingerprint(input.body);
  const canonical = [
    "perpay:webhook:v1",
    input.keyId,
    String(input.timestamp),
    input.deliveryId,
    input.eventId,
    String(input.attemptNumber),
    bodyFingerprint,
  ].join("\n");
  return `v1=${createHmac("sha256", Buffer.from(input.secret, "base64url"))
    .update(canonical, "utf8")
    .digest("hex")}`;
}

export interface WebhookAckResult {
  readonly acknowledged: boolean;
  readonly code: string;
}

const webhookAckSchema = z
  .object({
    schema: z.literal("perpay:webhook-ack:v1"),
    ack: z.literal(true),
    event_id: z.string().regex(uuidV4Pattern),
    delivery_id: z.string().regex(uuidV4Pattern),
  })
  .strict();

export function assessWebhookAck(input: {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentEncoding: string | null;
  readonly body: Uint8Array;
  readonly eventId: string;
  readonly deliveryId: string;
}): WebhookAckResult {
  if (input.status !== 200) return { acknowledged: false, code: "http_status_not_ack" };
  if (!isJsonUtf8ContentType(input.contentType)) {
    return { acknowledged: false, code: "ack_content_type_invalid" };
  }
  if (input.contentEncoding !== null && input.contentEncoding.toLowerCase() !== "identity") {
    return { acknowledged: false, code: "ack_content_encoding_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(input.body);
  } catch {
    return { acknowledged: false, code: "ack_json_invalid" };
  }
  const ack = webhookAckSchema.safeParse(parsed);
  if (!ack.success) return { acknowledged: false, code: "ack_shape_invalid" };
  if (ack.data.event_id !== input.eventId) {
    return { acknowledged: false, code: "ack_event_mismatch" };
  }
  if (ack.data.delivery_id !== input.deliveryId) {
    return { acknowledged: false, code: "ack_delivery_mismatch" };
  }
  return { acknowledged: true, code: "acknowledged" };
}

export function webhookRetryDelayMilliseconds(input: {
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly baseMilliseconds: number;
  readonly maximumMilliseconds: number;
}): number {
  assertUuid(input.deliveryId, "webhook delivery ID");
  for (const [name, value] of [
    ["attempt number", input.attemptNumber],
    ["retry base", input.baseMilliseconds],
    ["retry maximum", input.maximumMilliseconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`webhook ${name} is invalid`);
    }
  }
  if (input.maximumMilliseconds < input.baseMilliseconds) {
    throw new RangeError("webhook retry maximum is below its base");
  }
  const exponent = Math.min(input.attemptNumber - 1, 30);
  const unjittered = Math.min(
    input.maximumMilliseconds,
    input.baseMilliseconds * 2 ** exponent,
  );
  const entropy = createHash("sha256")
    .update(`${input.deliveryId}\0${input.attemptNumber}`, "ascii")
    .digest()
    .readUInt32BE(0) / 0xffffffff;
  const jittered = Math.floor(unjittered * (0.8 + entropy * 0.4));
  return Math.max(1, Math.min(input.maximumMilliseconds, jittered));
}

export function isCanonicalFingerprint(value: string): boolean {
  return fingerprintPattern.test(value);
}

function isJsonUtf8ContentType(value: string | null): boolean {
  if (value === null) return false;
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && parts[1] === "charset=utf-8";
}

function fingerprintTuple(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertUuid(value: string, label: string): void {
  if (!uuidV4Pattern.test(value)) throw new RangeError(`${label} is invalid`);
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}
