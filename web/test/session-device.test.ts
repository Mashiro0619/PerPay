import { describe, expect, it } from "vitest";
import { sessionActivity, sessionDevice } from "../src/lib/session-device";

describe("login session device labels", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36", "Chrome", "Windows", "computer"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge", "Windows", "computer"],
    ["Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0", "Edge", "Android", "phone"],
    ["Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Safari/537.36 SamsungBrowser/27.0", "Samsung Internet", "Android", "tablet"],
    ["Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0", "Firefox", "Linux", "computer"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15", "Safari", "macOS", "computer"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile/15E148 Safari/604.1", "Chrome", "iOS", "phone"],
    ["Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) FxiOS/131.0 Mobile/15E148 Safari/605.1.15", "Firefox", "iOS", "tablet"],
    ["Mozilla/5.0 (X11; CrOS x86_64 16002.0.0) Chrome/130.0.0.0 Safari/537.36", "Chrome", "ChromeOS", "computer"],
    ["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 OPR/115.0", "Opera", "Windows", "computer"],
    [null, "未知浏览器", "未知系统", "unknown"],
    ["unrecognized-client", "未知浏览器", "未知系统", "unknown"],
  ] as const)("identifies %s without treating shared UA tokens as separate browsers", (ua, browser, operatingSystem, kind) => {
    expect(sessionDevice(ua)).toEqual({ browser, operatingSystem, kind, label: `${browser} · ${operatingSystem}` });
  });
});

describe("session activity descriptions", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it.each([
    [0, "刚刚"], [59_999, "刚刚"], [60_000, "1 分钟前"],
    [59 * 60_000, "59 分钟前"], [3_600_000, "1 小时前"],
    [23 * 3_600_000, "23 小时前"], [86_400_000, "1 天前"],
    [4 * 86_400_000, "4 天前"], [-60_000, "刚刚"],
  ])("formats an elapsed interval of %s ms", (elapsed, expected) => {
    expect(sessionActivity(new Date(now - elapsed).toISOString(), now)).toBe(expected);
  });
  it("shows an unknown label for an invalid timestamp", () => {
    expect(sessionActivity("invalid", now)).toBe("未知");
  });
});
