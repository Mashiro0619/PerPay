export type SessionDeviceKind = "computer" | "phone" | "tablet" | "unknown";

export interface SessionDevice {
  browser: string;
  operatingSystem: string;
  kind: SessionDeviceKind;
  label: string;
}

/** Identify the client from its login UA or UA-CH hints; this is a display hint, not a device ID. */
export function sessionDevice(userAgent: string | null): SessionDevice {
  const ua = userAgent ?? "";
  let browser = "未知浏览器";
  if (/SamsungBrowser\/|"Samsung Internet"/i.test(ua)) browser = "Samsung Internet";
  else if (/(?:Edg|EdgA|EdgiOS)\/|"Microsoft Edge"/i.test(ua)) browser = "Edge";
  else if (/(?:OPR|Opera|OPiOS)(?:\/|\s)|"Opera"/i.test(ua)) browser = "Opera";
  else if (/(?:Firefox|FxiOS)\/|"Firefox"/i.test(ua)) browser = "Firefox";
  else if (/(?:Chrome|CriOS)\/|"Google Chrome"|"Chromium"/i.test(ua)) browser = "Chrome";
  else if (/Version\/[\d.]+.*Safari\/|"Safari"/i.test(ua)) browser = "Safari";

  let operatingSystem = "未知系统";
  if (/Windows (?:NT|Phone)|"Windows"/i.test(ua)) operatingSystem = "Windows";
  else if (/(?:iPhone|iPad|iPod)|"iOS"/i.test(ua)) operatingSystem = "iOS";
  else if (/Android|"Android"/i.test(ua)) operatingSystem = "Android";
  else if (/CrOS|"Chrome OS"/i.test(ua)) operatingSystem = "ChromeOS";
  else if (/(?:Macintosh|Mac OS X)|"macOS"/i.test(ua)) operatingSystem = "macOS";
  else if (/Linux|"Linux"/i.test(ua)) operatingSystem = "Linux";

  let kind: SessionDeviceKind = "unknown";
  if (/(?:iPad|Tablet)/i.test(ua) || (/Android/i.test(ua) && !/Mobile|\?1\b/i.test(ua))) kind = "tablet";
  else if (/(?:iPhone|iPod|Mobile|Windows Phone)|\?1\b/i.test(ua)) kind = "phone";
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
