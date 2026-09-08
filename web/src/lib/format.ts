export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
});
const numberFormatter = new Intl.NumberFormat("zh-CN");
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "—" : moneyFormatter.format(cents / 100);
}

export function count(value: number): string {
  return numberFormatter.format(value);
}

export function dateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : timeFormatter.format(date);
}

export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function parseAmount(value: string, maximumCents = 10_000): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    throw new Error("请输入正确的人民币金额，最多保留两位小数。");
  }
  const [whole, fraction = ""] = value.trim().split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > maximumCents) {
    throw new Error(`金额须介于 ¥0.01 和 ${money(maximumCents)} 之间。`);
  }
  return cents;
}

export const MIN_ADMIN_PASSWORD_CHARACTERS = 6;

export function validatePassword(password: string): string | null {
  if (Array.from(password).length < MIN_ADMIN_PASSWORD_CHARACTERS) return `密码至少需要 ${MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。`;
  if (new TextEncoder().encode(password).length > 1024) return "密码不能超过 1024 个 UTF-8 字节。";
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(password)) {
    return "密码包含无效的 Unicode 字符。";
  }
  return null;
}

export const resourceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function safeCheckoutUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.origin);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      /^\/checkout\/pct1_[A-Za-z0-9_-]{43}$/.test(url.pathname) &&
      !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
