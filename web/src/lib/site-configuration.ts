import type { SiteConfiguration } from "@/api/client";

// These are the fields editable in each website settings group. Merge only local
// changes in that group; every other value must come from the latest snapshot.
const fields = [
  ["basic", "name", "网站名称"],
  ["basic", "accepting_orders", "允许新订单"],
  ["orders", "policy.orders.order_ttl_seconds", "订单有效期（秒）"],
  ["orders", "policy.orders.amount_offset_maximum_cents", "最大尾差（分）"],
  ["orders", "policy.orders.amount_reuse_cooldown_seconds", "金额复用冷却（秒）"],
  ["orders", "policy.orders.pending_order_limit", "待付款订单上限"],
  ["integration", "notifications_enabled", "开启通知"],
  ["integration", "notification_origin", "通知来源"],
  ["integration", "return_origin", "返回来源"],
  ["integration", "policy.notification_delivery.timeout_milliseconds", "通知超时（毫秒）"],
  ["integration", "policy.notification_delivery.maximum_attempts", "最大投递次数"],
  ["integration", "policy.notification_delivery.retry_base_seconds", "基础重试间隔（秒）"],
  ["integration", "policy.notification_delivery.retry_maximum_seconds", "最大重试间隔（秒）"],
  ["display", "policy.display.checkout_name", "收银台名称"],
  ["display", "policy.display.checkout_help_url", "帮助链接"],
  ["display", "policy.display.checkout_show_product_name", "显示商品名称"],
] as const;

type FieldPath = (typeof fields)[number][1];
type FieldValue = string | number | boolean | null;
export type SiteFieldConflict = {
  path: FieldPath;
  label: string;
  before: FieldValue;
  local: FieldValue;
  remote: FieldValue;
};
export type SiteConflictChoices = Partial<Record<FieldPath, "local" | "remote">>;

function fieldLocation(configuration: SiteConfiguration, path: FieldPath) {
  const parts = path.split(".");
  const key = parts.pop()!;
  let target = configuration as unknown as Record<string, unknown>;
  for (const part of parts) target = target[part] as Record<string, unknown>;
  return { target, key };
}

function read(configuration: SiteConfiguration, path: FieldPath): FieldValue {
  const { target, key } = fieldLocation(configuration, path);
  return target[key] as FieldValue;
}

export function mergeSiteConfiguration(
  base: SiteConfiguration,
  draft: SiteConfiguration,
  remote: SiteConfiguration,
  section: string,
) {
  const configuration = structuredClone(remote);
  const conflicts: SiteFieldConflict[] = [];
  for (const [group, path, label] of fields) {
    if (section !== group) continue;
    const before = read(base, path), local = read(draft, path), latest = read(remote, path);
    if (Object.is(local, before)) continue;
    if (!Object.is(latest, before) && !Object.is(latest, local)) {
      conflicts.push({ path, label, before, local, remote: latest });
      continue;
    }
    const { target, key } = fieldLocation(configuration, path);
    target[key] = local;
  }
  return { configuration, conflicts };
}

export function resolveSiteConflicts(
  configuration: SiteConfiguration,
  conflicts: SiteFieldConflict[],
  choices: SiteConflictChoices,
): SiteConfiguration | null {
  if (conflicts.some(conflict => !choices[conflict.path])) return null;
  const resolved = structuredClone(configuration);
  for (const conflict of conflicts) {
    const { target, key } = fieldLocation(resolved, conflict.path);
    target[key] = choices[conflict.path] === "local" ? conflict.local : conflict.remote;
  }
  return resolved;
}

export function siteFieldValue(value: FieldValue): string {
  if (value === null || value === "") return "未设置";
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return String(value);
}
