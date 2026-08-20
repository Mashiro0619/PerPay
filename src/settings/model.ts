import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  type KeyObject,
} from "node:crypto";

import { z } from "zod";

import { isValidWebhookDnsHostname } from "../infrastructure/network/public-address.ts";
import { MAX_COLLECTION_CODE_PAYLOAD_BYTES } from "../orders/collection-profile.ts";

export const API_CLIENT_ID = "default" as const;
export const PRODUCTION_PROVIDER_ENDPOINT = "https://openapi.alipay.com" as const;
export const SANDBOX_PROVIDER_ENDPOINT =
  "https://openapi-sandbox.dl.alipaydev.com" as const;
export const RUNTIME_SECRET_NAMES = [
  "api_secret",
  "provider_private_key",
  "provider_public_key",
  "webhook_secret",
] as const;

export type RuntimeSecretName = (typeof RUNTIME_SECRET_NAMES)[number];
export type ProviderEnvironment = "PRODUCTION" | "SANDBOX";

export const DEFAULT_CHECKOUT_KEY_ROTATION_DAYS = 90;
export const DEFAULT_CHECKOUT_TERMINAL_OBSERVATION_SECONDS = 86_400;

export interface CollectionSettings {
  readonly codePayload: string;
  readonly orderTtlSeconds: number;
  readonly amountOffsetMaximumCents: number;
}

export interface ProviderSettings {
  readonly environment: ProviderEnvironment;
  readonly endpoint: typeof PRODUCTION_PROVIDER_ENDPOINT | typeof SANDBOX_PROVIDER_ENDPOINT;
  readonly appId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly applicationKeyFingerprint: string;
  readonly platformKeyFingerprint: string;
  readonly timeoutMilliseconds: number;
  readonly scanIntervalMilliseconds: number;
  readonly safetyLagMilliseconds: number;
  readonly maximumSuccessAgeMilliseconds: number;
}

export interface ProviderApplicationKeyMaterial {
  readonly privateKey: KeyObject;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  /** Single-line SPKI Base64 accepted by the Alipay application-key form. */
  readonly uploadPublicKey: string;
  readonly fingerprint: string;
}

export interface WebhookSettings {
  readonly enabled: boolean;
  readonly allowedOrigin: string | null;
  readonly secret: string | null;
  readonly signingKeyFingerprint: string | null;
  readonly timeoutMilliseconds: number;
  readonly maximumAttempts: number;
  readonly retryBaseMilliseconds: number;
  readonly retryMaximumMilliseconds: number;
}

export interface AdvancedSettings {
  readonly checkoutKeyRotationDays: number;
  readonly checkoutTerminalObservationSeconds: number;
}

export interface RuntimeSettingsSnapshot {
  readonly revision: number;
  readonly paymentRevision: number;
  readonly updatedAt: number;
  readonly collection: CollectionSettings | null;
  readonly provider: ProviderSettings | null;
  readonly apiSecret: string | null;
  readonly apiSecretFingerprint: string | null;
  readonly webhook: WebhookSettings;
  readonly advanced: AdvancedSettings;
  readonly activeProviderAccountKey: string | null;
}

/**
 * API authentication material captured from the same SQLite snapshot.
 *
 * The active secret and its identity key generation must be consumed together:
 * rotating the API secret updates both records in one transaction, and callers
 * use the returned key version/fingerprint when claiming a nonce.
 */
export interface ApiCredentialSnapshot {
  readonly clientId: typeof API_CLIENT_ID;
  readonly keyVersion: number;
  readonly secretFingerprint: string;
  readonly secret: string;
}

export interface RuntimeSettingsStatus {
  readonly revision: number;
  readonly paymentRevision: number;
  readonly updatedAt: number;
  readonly complete: boolean;
  readonly collectionConfigured: boolean;
  readonly providerConfigured: boolean;
  readonly apiConfigured: boolean;
  readonly notificationConfigured: boolean;
  readonly activeProviderAccountKey: string | null;
}

export const collectionSettingsInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  code_payload: z.string()
    .refine((value) => value.isWellFormed() && Array.from(value).length >= 8, {
      message: "must contain at least 8 Unicode scalar values",
    })
    .refine((value) => value === value.trim(), {
      message: "must not contain leading or trailing whitespace",
    })
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "must not contain control characters",
    })
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_COLLECTION_CODE_PAYLOAD_BYTES, {
      message: `must contain at most ${MAX_COLLECTION_CODE_PAYLOAD_BYTES} UTF-8 bytes`,
    }),
  order_ttl_seconds: z.number().int().min(60).max(1_800),
  amount_offset_maximum_cents: z.number().int().min(1).max(99),
}).strict();

export const providerSettingsInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  environment: z.enum(["PRODUCTION", "SANDBOX"]),
  app_id: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/),
  private_key: z.string().min(1).max(16 * 1024).optional(),
  platform_public_key: z.string().min(1).max(16 * 1024).optional(),
  timeout_milliseconds: z.number().int().min(1_000).max(120_000),
  scan_interval_seconds: z.number().int().min(5).max(3_600),
  safety_lag_seconds: z.number().int().min(5).max(300),
  maximum_success_age_seconds: z.number().int().min(10).max(86_400),
}).strict().superRefine((input, context) => {
  if (input.maximum_success_age_seconds < input.scan_interval_seconds * 2) {
    context.addIssue({
      code: "custom",
      path: ["maximum_success_age_seconds"],
      message: "must be at least twice the scan interval",
    });
  }
  if (input.safety_lag_seconds > input.maximum_success_age_seconds) {
    context.addIssue({
      code: "custom",
      path: ["safety_lag_seconds"],
      message: "must not exceed the maximum success age",
    });
  }
});

export const webhookSettingsInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  allowed_origin: z.string().optional(),
  timeout_milliseconds: z.number().int().min(1_000).max(30_000),
  maximum_attempts: z.number().int().min(1).max(100),
  retry_base_seconds: z.number().int().min(1).max(3_600),
  retry_maximum_seconds: z.number().int().min(1).max(86_400),
}).strict().superRefine((input, context) => {
  if (input.retry_maximum_seconds < input.retry_base_seconds) {
    context.addIssue({
      code: "custom",
      path: ["retry_maximum_seconds"],
      message: "must not be less than the base retry delay",
    });
  }
  if (input.enabled && input.allowed_origin === undefined) {
    context.addIssue({
      code: "custom",
      path: ["allowed_origin"],
      message: "is required when notifications are enabled",
    });
  }
});

export const advancedSettingsInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  checkout_key_rotation_days: z.number().int().min(1).max(3_650),
  checkout_terminal_observation_seconds: z.number().int().min(60).max(604_800),
}).strict();

export type CollectionSettingsInput = z.infer<typeof collectionSettingsInputSchema>;
export type ProviderSettingsInput = z.infer<typeof providerSettingsInputSchema>;
export type WebhookSettingsInput = z.infer<typeof webhookSettingsInputSchema>;
export type AdvancedSettingsInput = z.infer<typeof advancedSettingsInputSchema>;

export function providerEndpoint(environment: ProviderEnvironment): ProviderSettings["endpoint"] {
  return environment === "PRODUCTION"
    ? PRODUCTION_PROVIDER_ENDPOINT
    : SANDBOX_PROVIDER_ENDPOINT;
}

export function parseProviderKeys(input: {
  readonly environment: ProviderEnvironment;
  readonly appId: string;
  readonly privateKey: string;
  readonly publicKey: string;
  readonly timeoutMilliseconds: number;
  readonly scanIntervalMilliseconds: number;
  readonly safetyLagMilliseconds: number;
  readonly maximumSuccessAgeMilliseconds: number;
}): ProviderSettings {
  const applicationKey = parseProviderApplicationPrivateKey(input.privateKey);
  const privateKeyPem = applicationKey.privateKeyPem;
  const publicKeyPem = normalizeProviderKey(input.publicKey, "public");
  const privateKey = applicationKey.privateKey;
  const publicKey = parseRsaKey(publicKeyPem, "public");
  const applicationKeyFingerprint = applicationKey.fingerprint;
  const platformKeyFingerprint = publicKeyFingerprint(publicKey);
  if (applicationKeyFingerprint === platformKeyFingerprint) {
    throw new RangeError("platform public key cannot be the application's public key");
  }
  return Object.freeze({
    environment: input.environment,
    endpoint: providerEndpoint(input.environment),
    appId: input.appId,
    privateKey,
    publicKey,
    privateKeyPem,
    publicKeyPem,
    applicationKeyFingerprint,
    platformKeyFingerprint,
    timeoutMilliseconds: input.timeoutMilliseconds,
    scanIntervalMilliseconds: input.scanIntervalMilliseconds,
    safetyLagMilliseconds: input.safetyLagMilliseconds,
    maximumSuccessAgeMilliseconds: input.maximumSuccessAgeMilliseconds,
  });
}

export function generateProviderApplicationKey(): Promise<ProviderApplicationKeyMaterial> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      { modulusLength: 2_048, publicExponent: 0x1_0001 },
      (error, publicKey, privateKey) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
          const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
          resolve(providerApplicationKeyMaterial(privateKeyPem, publicKeyPem, privateKey));
        } catch (conversionError) {
          reject(conversionError);
        }
      },
    );
  });
}

export function parseProviderApplicationPrivateKey(value: string): ProviderApplicationKeyMaterial {
  const privateKeyPem = normalizeProviderKey(value, "private");
  const privateKey = parseRsaKey(privateKeyPem, "private");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return providerApplicationKeyMaterial(privateKeyPem, publicKeyPem, privateKey);
}

export function parseWebhookOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("notification origin must be an absolute URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !isValidWebhookDnsHostname(url.hostname) ||
    url.port !== ""
  ) {
    throw new RangeError("notification origin must be a public HTTPS origin without a port");
  }
  return url.origin;
}

export function isCanonicalSecret(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

export function fingerprintSecret(secret: string, purpose: string): string {
  return createHash("sha256")
    .update(`perpay:${purpose}:v1\0`, "utf8")
    .update(Buffer.from(secret, "base64url"))
    .digest("hex");
}

function parseRsaKey(value: string, kind: "private" | "public"): KeyObject {
  let key: KeyObject;
  try {
    key = kind === "private" ? createPrivateKey(value) : createPublicKey(value);
  } catch (error) {
    throw new RangeError(`provider ${kind} key is not a valid RSA key`, { cause: error });
  }
  if (key.type !== kind || key.asymmetricKeyType !== "rsa") {
    throw new RangeError(`provider ${kind} key must be an RSA ${kind} key`);
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2_048) {
    throw new RangeError(`provider ${kind} key must use at least 2048-bit RSA`);
  }
  return key;
}

function normalizeProviderKey(value: string, kind: "private" | "public"): string {
  const trimmed = value.trim();
  if (kind === "public" && /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(trimmed)) {
    throw new RangeError("platform public key cannot contain a private key");
  }
  if (trimmed.includes("-----BEGIN")) return trimmed;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
    throw new RangeError(`provider ${kind} key format is invalid`);
  }
  const body = trimmed.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? "";
  const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function publicKeyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function providerApplicationKeyMaterial(
  privateKeyPem: string,
  publicKeyPem: string,
  parsedPrivateKey?: KeyObject,
): ProviderApplicationKeyMaterial {
  const privateKey = parsedPrivateKey ?? parseRsaKey(privateKeyPem, "private");
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new RangeError("provider application public key must be an RSA public key");
  }
  return Object.freeze({
    privateKey,
    privateKeyPem,
    publicKeyPem,
    uploadPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    fingerprint: publicKeyFingerprint(publicKey),
  });
}
