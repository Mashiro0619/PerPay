export const DEFAULT_SYSTEM_NAME = "PerPay";
export const SYSTEM_NAME_MARKER = "__PERPAY_SYSTEM_NAME__";

export function escapeSystemName(name: string): string {
  return name.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
