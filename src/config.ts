import { isIP } from "node:net";
import { resolve } from "node:path";

import { z } from "zod";

import {
  parseTrustedProxyPolicy,
  type TrustedProxyPolicy,
} from "./infrastructure/network/trusted-proxy.ts";
import { pathsOverlap } from "./infrastructure/storage/path-separation.ts";

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_HEX_LENGTH = MASTER_KEY_BYTES * 2;
const masterKeyHexPattern = /^[0-9a-fA-F]{64}$/;

const rawDeploymentConfigSchema = z.object({
  PERPAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  PERPAY_PORT: z.coerce.number().int().min(1).max(65535).default(6190),
  PERPAY_DATA_DIR: z.string().trim().min(1).default("./data"),
  PERPAY_BACKUP_DIR: z.string().trim().min(1).default("/backups"),
  PERPAY_MASTER_KEY: z.string().length(MASTER_KEY_HEX_LENGTH).regex(masterKeyHexPattern),
  PERPAY_PUBLIC_URL: z.string().trim().min(1).default("http://localhost:6190"),
  PERPAY_TRUSTED_PROXY_CIDRS: z.string().default(""),
  PERPAY_BACKUP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(60 * 60)
    .max(7 * 24 * 60 * 60)
    .default(24 * 60 * 60),
});

export interface DeploymentConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly backupDir: string;
  readonly databasePath: string;
  readonly masterKey: Buffer;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
  readonly trustedProxy: TrustedProxyPolicy;
  readonly backupIntervalMilliseconds: number;
}

/** Temporary name retained while callers migrate to DeploymentConfig. */
export type AppConfig = DeploymentConfig;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const parsed = rawDeploymentConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`configuration validation failed: ${z.prettifyError(parsed.error)}`);
  }

  if (isIP(parsed.data.PERPAY_HOST) === 0 && parsed.data.PERPAY_HOST !== "localhost") {
    throw new Error("configuration validation failed: PERPAY_HOST must be an IP address or localhost");
  }

  const publicUrl = parsePublicUrl(parsed.data.PERPAY_PUBLIC_URL);
  let trustedProxy: TrustedProxyPolicy;
  try {
    trustedProxy = parseTrustedProxyPolicy(parsed.data.PERPAY_TRUSTED_PROXY_CIDRS);
  } catch (error) {
    throw new Error(
      `configuration validation failed: ${
        error instanceof Error ? error.message : "PERPAY_TRUSTED_PROXY_CIDRS is invalid"
      }`,
      { cause: error },
    );
  }
  if (publicUrl.protocol === "https:" && trustedProxy.cidrs.length === 0) {
    throw new Error(
      "configuration validation failed: HTTPS deployments must declare their directly connected trusted proxy with PERPAY_TRUSTED_PROXY_CIDRS",
    );
  }

  const dataDir = resolve(parsed.data.PERPAY_DATA_DIR);
  const backupDir = resolve(parsed.data.PERPAY_BACKUP_DIR);
  if (pathsOverlap(dataDir, backupDir)) {
    throw new Error(
      "configuration validation failed: PERPAY_DATA_DIR and PERPAY_BACKUP_DIR must be separate",
    );
  }

  const masterKey = Buffer.from(parsed.data.PERPAY_MASTER_KEY, "hex");
  if (masterKey.byteLength !== MASTER_KEY_BYTES) {
    throw new Error("configuration validation failed: PERPAY_MASTER_KEY must encode exactly 32 bytes");
  }

  return Object.freeze({
    host: parsed.data.PERPAY_HOST,
    port: parsed.data.PERPAY_PORT,
    dataDir,
    backupDir,
    databasePath: resolve(dataDir, "perpay.sqlite3"),
    masterKey,
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    trustedProxy,
    backupIntervalMilliseconds: parsed.data.PERPAY_BACKUP_INTERVAL_SECONDS * 1_000,
  });
}

function parsePublicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("configuration validation failed: PERPAY_PUBLIC_URL must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("configuration validation failed: PERPAY_PUBLIC_URL must use HTTP or HTTPS");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "configuration validation failed: plain HTTP is only allowed for a loopback PERPAY_PUBLIC_URL",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "configuration validation failed: PERPAY_PUBLIC_URL must contain only an origin",
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  return family === 6 && address === "::1";
}
