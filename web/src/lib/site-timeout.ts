import { integerUnits } from "../../../src/shared/time-units";

export function siteTimeoutSeconds(milliseconds: number): string {
  return String(milliseconds / 1000);
}

export function siteTimeoutError(raw: string): string | null {
  if (raw === "") return "请输入通知超时。";
  const milliseconds = integerUnits(raw, 1000);
  if (milliseconds === null) return "通知超时最多 3 位小数。";
  if (milliseconds < 1000 || milliseconds > 30000)
    return "通知超时应为 1 至 30 秒。";
  return null;
}

export { integerUnits };
