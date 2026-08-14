import { isIP } from "node:net";
import { resolve } from "node:path";

import { z } from "zod";

const placeholderPattern = /(change[_-]?me|example)/i;

const rawConfigSchema = z.object({
  PERPAY_HOST: z.string().trim().min(1).default("0.0.0.0"),
  PERPAY_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PERPAY_DATA_DIR: z.string().trim().min(1).default("./data"),
  PERPAY_ADMIN_PASSWORD: z.string().min(12).max(1024),
  PERPAY_TIMEZONE: z.string().trim().min(1).default("Asia/Shanghai"),
  PERPAY_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly adminPassword: string;
  readonly timezone: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`配置校验失败: ${z.prettifyError(parsed.error)}`);
  }

  if (placeholderPattern.test(parsed.data.PERPAY_ADMIN_PASSWORD)) {
    throw new Error("配置校验失败: PERPAY_ADMIN_PASSWORD 不能使用示例值");
  }

  if (isIP(parsed.data.PERPAY_HOST) === 0 && parsed.data.PERPAY_HOST !== "localhost") {
    throw new Error("配置校验失败: PERPAY_HOST 必须是 IP 地址或 localhost");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.PERPAY_TIMEZONE });
  } catch {
    throw new Error("配置校验失败: PERPAY_TIMEZONE 不是有效的 IANA 时区");
  }

  const dataDir = resolve(parsed.data.PERPAY_DATA_DIR);
  return Object.freeze({
    host: parsed.data.PERPAY_HOST,
    port: parsed.data.PERPAY_PORT,
    dataDir,
    databasePath: resolve(dataDir, "perpay.sqlite3"),
    adminPassword: parsed.data.PERPAY_ADMIN_PASSWORD,
    timezone: parsed.data.PERPAY_TIMEZONE,
    logLevel: parsed.data.PERPAY_LOG_LEVEL,
  });
}
