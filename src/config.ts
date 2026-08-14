import { isIP } from "node:net";
import { resolve } from "node:path";

import { z } from "zod";

const placeholderPattern = /(change[_-]?me|example)/i;
const adminUsernamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const apiClientIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumPasswordBytes = 1024;
const apiSecretBytes = 32;

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
    .refine((value) => Buffer.byteLength(value, "utf8") <= maximumPasswordBytes, {
      message: `must contain at most ${maximumPasswordBytes} UTF-8 bytes`,
    }),
  PERPAY_ADMIN_USERNAME: z.string().trim().regex(adminUsernamePattern).default("admin"),
  PERPAY_PUBLIC_URL: z.string().trim().min(1).default("http://localhost:8080"),
  PERPAY_API_CLIENT_ID: z.string().trim().regex(apiClientIdPattern).default("default"),
  PERPAY_API_SECRET: z
    .string()
    .refine(isCanonicalApiSecret, {
      message: "must be the canonical unpadded base64url encoding of exactly 32 bytes",
    }),
  PERPAY_TIMEZONE: z.string().trim().min(1).default("Asia/Shanghai"),
  PERPAY_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  /** Used only to create the administrator when the database has no administrator yet. */
  readonly adminPassword: string;
  readonly adminUsername: string;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly apiClientId: string;
  readonly apiSecret: string;
  readonly timezone: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`配置校验失败: ${z.prettifyError(parsed.error)}`);
  }

  if (placeholderPattern.test(parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD)) {
    throw new Error("配置校验失败: PERPAY_INITIAL_ADMIN_PASSWORD 不能使用示例值");
  }

  if (placeholderPattern.test(parsed.data.PERPAY_API_SECRET)) {
    throw new Error("配置校验失败: PERPAY_API_SECRET 不能使用示例值");
  }

  if (parsed.data.PERPAY_API_SECRET === parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD) {
    throw new Error("配置校验失败: PERPAY_API_SECRET 不能与 PERPAY_INITIAL_ADMIN_PASSWORD 相同");
  }

  if (isIP(parsed.data.PERPAY_HOST) === 0 && parsed.data.PERPAY_HOST !== "localhost") {
    throw new Error("配置校验失败: PERPAY_HOST 必须是 IP 地址或 localhost");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.PERPAY_TIMEZONE });
  } catch {
    throw new Error("配置校验失败: PERPAY_TIMEZONE 不是有效的 IANA 时区");
  }

  const publicUrl = parsePublicUrl(parsed.data.PERPAY_PUBLIC_URL);

  const dataDir = resolve(parsed.data.PERPAY_DATA_DIR);
  return Object.freeze({
    host: parsed.data.PERPAY_HOST,
    port: parsed.data.PERPAY_PORT,
    dataDir,
    databasePath: resolve(dataDir, "perpay.sqlite3"),
    adminPassword: parsed.data.PERPAY_INITIAL_ADMIN_PASSWORD,
    adminUsername: parsed.data.PERPAY_ADMIN_USERNAME,
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    apiClientId: parsed.data.PERPAY_API_CLIENT_ID,
    apiSecret: parsed.data.PERPAY_API_SECRET,
    timezone: parsed.data.PERPAY_TIMEZONE,
    logLevel: parsed.data.PERPAY_LOG_LEVEL,
  });
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
