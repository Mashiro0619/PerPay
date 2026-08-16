import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { z } from "zod";

import { isValidWebhookDnsHostname } from "./infrastructure/network/public-address.ts";

const placeholderPattern = /(change[_-]?me|example)/i;
const adminUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const apiClientIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumPasswordBytes = 1024;
const apiSecretBytes = 32;
const maximumCollectionCodeBytes = 4096;
const maximumProviderKeyBytes = 16 * 1024;
const maximumWebhookUrlBytes = 4096;
const productionProviderEndpoint = "https://openapi.alipay.com" as const;
const sandboxProviderEndpoint = "https://openapi-sandbox.dl.alipaydev.com" as const;

function isCanonicalApiSecret(value: string): boolean {
  if (!canonicalBase64UrlPattern.test(value)) return false;

  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === apiSecretBytes && decoded.toString("base64url") === value;
}

const rawConfigSchema = z.object({
  PERPAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  PERPAY_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PERPAY_DATA_DIR: z.string().trim().min(1).default("./data"),
  PERPAY_INITIAL_ADMIN_PASSWORD: z
    .string()
    .min(12)
    .refine((value) => hasOnlyUnicodeScalarValues(value), {
      message: "must contain only Unicode scalar values",
    })
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumPasswordBytes, {
      message: `must contain at most ${maximumPasswordBytes} UTF-8 bytes`,
    })
    .optional(),
  PERPAY_ADMIN_USERNAME: z.string().trim().regex(adminUsernamePattern).default("admin"),
  PERPAY_PUBLIC_URL: z.string().trim().min(1).default("http://localhost:8080"),
  PERPAY_API_CLIENT_ID: z.string().trim().regex(apiClientIdPattern).default("default"),
  PERPAY_API_SECRET: z
    .string()
    .refine(isCanonicalApiSecret, {
      message: "must be the canonical unpadded base64url encoding of exactly 32 bytes",
    }),
  PERPAY_COLLECTION_CODE_PAYLOAD: z
    .string()
    .refine((value) => hasOnlyUnicodeScalarValues(value) && Array.from(value).length >= 8, {
      message: "must contain at least 8 Unicode characters",
    })
    .refine((value) => value === value.trim(), {
      message: "must not contain leading or trailing whitespace",
    })
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "must not contain control characters",
    })
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumCollectionCodeBytes, {
      message: `must contain at most ${maximumCollectionCodeBytes} UTF-8 bytes`,
    }),
  PERPAY_ORDER_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
  PERPAY_AMOUNT_OFFSET_MAX_CENTS: z.coerce.number().int().min(1).max(99).default(99),
  PERPAY_ALIPAY_ENABLED: z.enum(["true", "false"]).default("false"),
  PERPAY_ALIPAY_APP_ID: z.string().trim().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
  PERPAY_ALIPAY_PRIVATE_KEY: z.string().min(1).max(maximumProviderKeyBytes).optional(),
  PERPAY_ALIPAY_PUBLIC_KEY: z.string().min(1).max(maximumProviderKeyBytes).optional(),
  PERPAY_ALIPAY_ENDPOINT: z
    .enum([productionProviderEndpoint, sandboxProviderEndpoint])
    .default(productionProviderEndpoint),
  PERPAY_ALIPAY_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1_000).max(120_000).default(8_000),
  PERPAY_ALIPAY_SCAN_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3_600).default(10),
  PERPAY_WEBHOOK_ENABLED: z.enum(["true", "false"]).default("false"),
  PERPAY_WEBHOOK_ALLOWED_ORIGIN: z.string().optional(),
  PERPAY_WEBHOOK_SECRET: z.string().optional(),
  PERPAY_WEBHOOK_TIMEOUT_MILLISECONDS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  PERPAY_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  PERPAY_WEBHOOK_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(5),
  PERPAY_WEBHOOK_RETRY_MAX_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3_600),
});

export type ProviderEndpoint = typeof productionProviderEndpoint | typeof sandboxProviderEndpoint;

export type AlipayRuntimeConfig =
  | {
      readonly enabled: false;
      readonly endpoint: ProviderEndpoint;
    }
  | {
      readonly enabled: true;
      readonly appId: string;
      readonly privateKey: KeyObject;
      readonly alipayPublicKey: KeyObject;
      readonly endpoint: ProviderEndpoint;
      readonly timeoutMilliseconds: number;
      readonly scanIntervalMilliseconds: number;
      readonly applicationKeyFingerprint: string;
      readonly alipayKeyFingerprint: string;
    };

export type WebhookRuntimeConfig =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly allowedOrigin: string;
      readonly allowedOriginFingerprint: string;
      readonly secret: string;
      readonly signingKeyFingerprint: string;
      readonly timeoutMilliseconds: number;
      readonly maximumAttempts: number;
      readonly retryBaseMilliseconds: number;
      readonly retryMaximumMilliseconds: number;
    };

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  /** Used only to create the administrator when the database has no administrator yet. */
  readonly adminPassword: string | null;
  readonly adminUsername: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly apiClientId: string;
  readonly apiSecret: string;
  readonly collectionCodePayload: string;
  readonly orderTtlSeconds: number;
  readonly amountOffsetMaximumCents: number;
  readonly alipay: AlipayRuntimeConfig;
  readonly webhook: WebhookRuntimeConfig;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`配置校验失败: ${z.prettifyError(parsed.error)}`);
  }

  if (
    parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD !== undefined &&
    placeholderPattern.test(parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD)
  ) {
    throw new Error("配置校验失败: PERPAY_INITIAL_ADMIN_PASSWORD 不能使用示例值");
  }

  if (placeholderPattern.test(parsed.data.PERPAY_API_SECRET)) {
    throw new Error("配置校验失败: PERPAY_API_SECRET 不能使用示例值");
  }

  if (placeholderPattern.test(parsed.data.PERPAY_COLLECTION_CODE_PAYLOAD)) {
    throw new Error("配置校验失败: PERPAY_COLLECTION_CODE_PAYLOAD 不能使用示例值");
  }

  if (
    parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD !== undefined &&
    parsed.data.PERPAY_API_SECRET === parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD
  ) {
    throw new Error("配置校验失败: PERPAY_API_SECRET 不能与 PERPAY_INITIAL_ADMIN_PASSWORD 相同");
  }

  if (isIP(parsed.data.PERPAY_HOST) === 0 && parsed.data.PERPAY_HOST !== "localhost") {
    throw new Error("配置校验失败: PERPAY_HOST 必须是 IP 地址或 localhost");
  }

  const publicUrl = parsePublicUrl(parsed.data.PERPAY_PUBLIC_URL);
  const alipay = loadAlipayConfig(parsed.data);
  const webhook = loadWebhookConfig(parsed.data, {
    adminPassword: parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD ?? null,
    apiSecret: parsed.data.PERPAY_API_SECRET,
  });

  const dataDir = resolve(parsed.data.PERPAY_DATA_DIR);
  return Object.freeze({
    host: parsed.data.PERPAY_HOST,
    port: parsed.data.PERPAY_PORT,
    dataDir,
    databasePath: resolve(dataDir, "perpay.sqlite3"),
    adminPassword: parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD ?? null,
    adminUsername: parsed.data.PERPAY_ADMIN_USERNAME,
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    apiClientId: parsed.data.PERPAY_API_CLIENT_ID,
    apiSecret: parsed.data.PERPAY_API_SECRET,
    collectionCodePayload: parsed.data.PERPAY_COLLECTION_CODE_PAYLOAD,
    orderTtlSeconds: parsed.data.PERPAY_ORDER_TTL_SECONDS,
    amountOffsetMaximumCents: parsed.data.PERPAY_AMOUNT_OFFSET_MAX_CENTS,
    alipay,
    webhook,
  });
}

function loadWebhookConfig(
  parsed: z.infer<typeof rawConfigSchema>,
  secrets: { readonly adminPassword: string | null; readonly apiSecret: string },
): WebhookRuntimeConfig {
  if (parsed.PERPAY_WEBHOOK_ENABLED === "false") {
    return Object.freeze({ enabled: false });
  }
  if (
    parsed.PERPAY_WEBHOOK_ALLOWED_ORIGIN === undefined ||
    parsed.PERPAY_WEBHOOK_SECRET === undefined
  ) {
    throw new Error(
      "配置校验失败: 启用通知时必须填写 PERPAY_WEBHOOK_ALLOWED_ORIGIN 和 PERPAY_WEBHOOK_SECRET",
    );
  }
  if (!isCanonicalApiSecret(parsed.PERPAY_WEBHOOK_SECRET)) {
    throw new Error(
      "配置校验失败: PERPAY_WEBHOOK_SECRET 必须是恰好 32 字节的规范无填充 base64url",
    );
  }
  if (placeholderPattern.test(parsed.PERPAY_WEBHOOK_SECRET)) {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_SECRET 不能使用示例值");
  }
  if (
    (secrets.adminPassword !== null && parsed.PERPAY_WEBHOOK_SECRET === secrets.adminPassword) ||
    parsed.PERPAY_WEBHOOK_SECRET === secrets.apiSecret
  ) {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_SECRET 不能复用管理员密码或 API 密钥");
  }
  if (parsed.PERPAY_WEBHOOK_RETRY_MAX_SECONDS < parsed.PERPAY_WEBHOOK_RETRY_BASE_SECONDS) {
    throw new Error(
      "配置校验失败: PERPAY_WEBHOOK_RETRY_MAX_SECONDS 不能小于 PERPAY_WEBHOOK_RETRY_BASE_SECONDS",
    );
  }

  const allowedOrigin = parseWebhookOrigin(parsed.PERPAY_WEBHOOK_ALLOWED_ORIGIN);
  return Object.freeze({
    enabled: true,
    allowedOrigin,
    allowedOriginFingerprint: createHash("sha256")
      .update(allowedOrigin, "utf8")
      .digest("hex"),
    secret: parsed.PERPAY_WEBHOOK_SECRET,
    signingKeyFingerprint: createHash("sha256")
      .update("perpay:webhook-signing-key:v1\0", "utf8")
      .update(Buffer.from(parsed.PERPAY_WEBHOOK_SECRET, "base64url"))
      .digest("hex"),
    timeoutMilliseconds: parsed.PERPAY_WEBHOOK_TIMEOUT_MILLISECONDS,
    maximumAttempts: parsed.PERPAY_WEBHOOK_MAX_ATTEMPTS,
    retryBaseMilliseconds: parsed.PERPAY_WEBHOOK_RETRY_BASE_SECONDS * 1_000,
    retryMaximumMilliseconds: parsed.PERPAY_WEBHOOK_RETRY_MAX_SECONDS * 1_000,
  });
}

function loadAlipayConfig(parsed: z.infer<typeof rawConfigSchema>): AlipayRuntimeConfig {
  const endpoint = parsed.PERPAY_ALIPAY_ENDPOINT;
  if (parsed.PERPAY_ALIPAY_ENABLED === "false") {
    return Object.freeze({ enabled: false, endpoint });
  }

  if (
    parsed.PERPAY_ALIPAY_APP_ID === undefined ||
    parsed.PERPAY_ALIPAY_PRIVATE_KEY === undefined ||
    parsed.PERPAY_ALIPAY_PUBLIC_KEY === undefined
  ) {
    throw new Error(
      "配置校验失败: 启用账务采集时必须填写 PERPAY_ALIPAY_APP_ID、PERPAY_ALIPAY_PRIVATE_KEY 和 PERPAY_ALIPAY_PUBLIC_KEY",
    );
  }
  if (placeholderPattern.test(parsed.PERPAY_ALIPAY_APP_ID)) {
    throw new Error("配置校验失败: PERPAY_ALIPAY_APP_ID 不能使用示例值");
  }

  const privateKey = parseRsaKey(parsed.PERPAY_ALIPAY_PRIVATE_KEY, "private");
  const alipayPublicKey = parseRsaKey(parsed.PERPAY_ALIPAY_PUBLIC_KEY, "public");
  const applicationKeyFingerprint = publicKeyFingerprint(createPublicKey(privateKey));
  const alipayKeyFingerprint = publicKeyFingerprint(alipayPublicKey);
  if (applicationKeyFingerprint === alipayKeyFingerprint) {
    throw new Error("配置校验失败: PERPAY_ALIPAY_PUBLIC_KEY 不能填写应用公钥");
  }
  return Object.freeze({
    enabled: true,
    appId: parsed.PERPAY_ALIPAY_APP_ID,
    privateKey,
    alipayPublicKey,
    endpoint,
    timeoutMilliseconds: parsed.PERPAY_ALIPAY_TIMEOUT_MILLISECONDS,
    scanIntervalMilliseconds: parsed.PERPAY_ALIPAY_SCAN_INTERVAL_SECONDS * 1_000,
    applicationKeyFingerprint,
    alipayKeyFingerprint,
  });
}

function parseRsaKey(value: string, kind: "private" | "public"): KeyObject {
  const normalized = normalizeProviderKey(value, kind);
  let key: KeyObject;
  try {
    key = kind === "private" ? createPrivateKey(normalized) : createPublicKey(normalized);
  } catch (error) {
    throw new Error(
      `配置校验失败: PERPAY_ALIPAY_${kind === "private" ? "PRIVATE" : "PUBLIC"}_KEY 不是有效的 RSA 密钥`,
      { cause: error },
    );
  }
  if (key.type !== kind || key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `配置校验失败: PERPAY_ALIPAY_${kind === "private" ? "PRIVATE" : "PUBLIC"}_KEY 必须是 RSA ${kind === "private" ? "私钥" : "公钥"}`,
    );
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2_048) {
    throw new Error(
      `配置校验失败: PERPAY_ALIPAY_${kind === "private" ? "PRIVATE" : "PUBLIC"}_KEY 至少需要 2048 位 RSA`,
    );
  }
  return key;
}

function normalizeProviderKey(value: string, kind: "private" | "public"): string {
  const trimmed = value.trim();
  if (kind === "public" && /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(trimmed)) {
    throw new Error("配置校验失败: PERPAY_ALIPAY_PUBLIC_KEY 不能包含私钥");
  }
  if (trimmed.includes("-----BEGIN")) return trimmed;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
    throw new Error(
      `配置校验失败: PERPAY_ALIPAY_${kind === "private" ? "PRIVATE" : "PUBLIC"}_KEY 格式无效`,
    );
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

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("配置校验失败: PERPAY_PUBLIC_URL 必须是有效的绝对 URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("配置校验失败: PERPAY_PUBLIC_URL 只支持 http 或 https");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("配置校验失败: PERPAY_PUBLIC_URL 只能包含 origin，不能包含凭据、路径、查询或片段");
  }
  if (placeholderPattern.test(url.hostname)) {
    throw new Error("配置校验失败: PERPAY_PUBLIC_URL 不能使用示例域名");
  }
  return url;
}

function parseWebhookOrigin(value: string): string {
  if (Buffer.byteLength(value, "utf8") > maximumWebhookUrlBytes) {
    throw new Error(
      `配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 最多允许 ${maximumWebhookUrlBytes} 个 UTF-8 字节`,
    );
  }
  if (value !== value.trim()) {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 不能包含首尾空白");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 必须是有效的绝对 URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 只支持 HTTPS");
  }
  if (
    value.includes("#") ||
    value.endsWith("?") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 只能包含 HTTPS origin",
    );
  }
  if (placeholderPattern.test(url.hostname)) {
    throw new Error("配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 不能使用示例域名");
  }
  if (!isValidWebhookDnsHostname(url.hostname)) {
    throw new Error(
      "配置校验失败: PERPAY_WEBHOOK_ALLOWED_ORIGIN 必须使用不带尾点的 DNS 域名",
    );
  }
  return url.origin;
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}
