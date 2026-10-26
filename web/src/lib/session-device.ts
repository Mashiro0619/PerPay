export type SessionDeviceKind = "computer" | "phone" | "tablet" | "unknown";

export interface SessionDevice {
  browser: string;
  operatingSystem: string;
  kind: SessionDeviceKind;
  label: string;
}

/** Identify the client from its login UA; this is a display hint, not a device ID. */
export function sessionDevice(userAgent: string | null): SessionDevice {
  const ua = userAgent ?? "";
  let browser = "未知浏览器";
  if (/SamsungBrowser\//i.test(ua)) browser = "Samsung Internet";
  else if (/(?:Edg|EdgA|EdgiOS)\//i.test(ua)) browser = "Edge";
  else if (/(?:OPR|Opera|OPiOS)(?:\/|\s)/i.test(ua)) browser = "Opera";
  else if (/(?:Firefox|FxiOS)\//i.test(ua)) browser = "Firefox";
  else if (/(?:Chrome|CriOS)\//i.test(ua)) browser = "Chrome";
  else if (/Version\/[\d.]+.*Safari\//i.test(ua)) browser = "Safari";

  let operatingSystem = "未知系统";
  if (/Windows (?:NT|Phone)/i.test(ua)) operatingSystem = "Windows";
  else if (/(?:iPhone|iPad|iPod)/i.test(ua)) operatingSystem = "iOS";
  else if (/Android/i.test(ua)) operatingSystem = "Android";
  else if (/CrOS/i.test(ua)) operatingSystem = "ChromeOS";
  else if (/(?:Macintosh|Mac OS X)/i.test(ua)) operatingSystem = "macOS";
  else if (/Linux/i.test(ua)) operatingSystem = "Linux";

  let kind: SessionDeviceKind = "unknown";
  if (/(?:iPad|Tablet)/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) kind = "tablet";
  else if (/(?:iPhone|iPod|Mobile|Windows Phone)/i.test(ua)) kind = "phone";
  else if (operatingSystem !== "未知系统") kind = "computer";

  return { browser, operatingSystem, kind, label: `${browser} · ${operatingSystem}` };
}

export function sessionActivity(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "未知";
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes === 0) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
