import type { AuditActorType, AuditChange, AuditEventItem, AuditJsonValue, AuditSource } from "../../../src/shared/audit";
import { sessionDevice } from "./session-device";

export const AUDIT_ACTOR_LABELS: Readonly<Record<AuditActorType, string>> = {
  ADMIN: "管理员", API_CLIENT: "业务网站", SYSTEM: "系统", ANONYMOUS: "未登录访问",
};
export const AUDIT_SOURCE_LABELS: Readonly<Record<AuditSource, string>> = {
  core: "核心审计", activity: "活动记录",
};
export const AUDIT_RECORD_LABELS: Readonly<Record<AuditEventItem["source_type"], string>> = {
  CORE: "核心审计", HTTP: "接口访问", BACKGROUND: "后台任务", MAINTENANCE: "维护与备份", INTERNAL: "系统活动",
};

const actions: Readonly<Record<string, string>> = {
  "admin.initialized": "初始化管理员", "admin.login": "管理员登录", "admin.logout": "退出登录",
  "admin.password_changed": "修改管理员密码", "admin.password_recover": "恢复管理员密码",
  "admin.allowlist_disabled": "恢复管理员访问", "admin.session_revoked": "撤销登录会话",
  "admin.sessions_revoke_all": "注销全部会话", "admin.sessions_revoke_others": "退出其他会话",
  "api_client.initialized": "初始化调用凭据", "api_client.rotated": "轮换调用凭据",
  "site.created": "创建业务网站", "site.updated": "更新业务网站", "site.deleted": "删除业务网站",
  "site.secret_rotated": "轮换网站密钥", "site.secret_viewed": "查看网站密钥", "site_defaults.updated": "更新网站默认设置",
  "alipay_account.created": "添加收款账号", "alipay_account.updated": "更新收款账号", "alipay_account.deleted": "删除收款账号",
  "alipay_account.checked": "检查收款账号",
  "alipay_account.application_key_generated": "生成账号应用密钥", "alipay_account.application_key_regenerated": "重新生成账号应用密钥",
  "alipay_account.application_key_prepared": "准备账号应用密钥", "alipay_account.application_key_activated": "启用账号应用密钥",
  "alipay_account.application_key_discarded": "放弃账号待用密钥",
  "settings.admin_access_updated": "更新管理员访问规则", "settings.advanced_updated": "更新高级设置",
  "settings.backup_updated": "更新备份设置", "settings.collection_code_updated": "更新收款码",
  "settings.collection_policy_updated": "更新查账策略", "settings.collection_updated": "更新收款设置",
  "settings.display_updated": "更新显示设置", "settings.notifications_updated": "更新通知设置",
  "settings.provider_updated": "更新支付宝配置", "settings.secret_revealed": "查看密钥",
  "settings.webhook_secret_rotated": "轮换通知密钥", "settings.provider_application_key_generated": "生成应用密钥",
  "settings.provider_application_key_regenerated": "重新生成应用密钥", "settings.provider_application_key_prepared": "准备应用密钥",
  "settings.provider_application_key_activated": "启用应用密钥", "settings.provider_application_key_discarded": "放弃待用密钥",
  "orders.created": "创建订单", "orders.checkout_closed": "关闭收银台", "orders.checkout_expired": "收银台到期",
  "orders.export_generated": "导出订单", "orders.refund_mark": "更新退款标记",
  "financial.auto_settlement": "自动确认收款", "financial.manual_settlement": "人工确认收款",
  "financial.reverse_settlement": "撤销收款关联", "financial.supersede_candidate": "更新待确认的收款关联",
  "work_items.ignore_all": "批量忽略提醒", "work_items.ignore": "忽略提醒", "work_items.restore": "恢复提醒",
  "webhook.delivery_redelivered": "重新投递通知", "webhook.signing_key_initialized": "初始化通知签名密钥",
  "webhook.signing_key_rotated": "轮换通知签名密钥", "webhook.delivery": "投递通知", "webhook.dispatch": "通知调度",
  "http.request": "接口请求", "http.read": "接口查询", "audit.export": "导出审计日志", "audit.export_generated": "导出审计日志",
  "ledger.scan": "扫描支付宝流水", "reconciliation.sweep": "执行对账扫描", "activity.capture_gap": "活动日志采集缺口",
  "backup.scheduler": "备份调度", "backup.run_once": "立即备份", "backup.health": "检查备份状态",
  "backup.restore": "恢复备份", "backup.delete": "删除备份", "backup.lock.clear": "清理备份锁",
  "backup.list": "查看备份列表", "backup.files.list": "查看备份文件", "backup.lock.inspect": "检查备份锁",
  "backup.command.invalid": "无效备份命令", "backup.cycle": "执行备份任务", "backup.retention": "清理过期备份",
  "maintenance.publication_lock.clear": "清理发布锁", "maintenance.lock.clear": "清理维护锁",
  "maintenance.quarantine.delete": "删除隔离数据", "maintenance.quarantine.prune": "清理隔离数据",
  "maintenance.restore": "执行数据恢复", "maintenance.backups.list": "查看维护备份",
  "maintenance.quarantine.list": "查看隔离列表", "maintenance.lock.inspect": "检查维护锁",
  "maintenance.publication_lock.inspect": "检查发布锁", "maintenance.command.invalid": "无效维护命令",
  "reconciliation_scheduler_startup_failed": "对账调度器启动失败", "webhook_scheduler_startup_failed": "通知调度器启动失败",
  "reconciliation_sweep_trigger_failed": "触发对账扫描失败", "ledger_scheduler_failed": "流水调度失败",
  "webhook_delivery_trigger_failed": "触发通知投递失败", "reconciliation_entry_failed": "流水对账失败",
  "reconciliation_order_failed": "订单对账失败", "webhook_scheduler_failed": "通知调度失败",
  "system.started": "系统启动", "system.stopping": "系统正在停止", "system.stopped": "系统停止",
  "system.start_failed": "系统启动失败", "system.failed": "系统运行异常",
};
export function auditActionLabel(action: string): string { return actions[action] ?? action; }

const timestamp = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
export function auditDateTime(value: string | null): string {
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未记录" : timestamp.format(date);
}
export function auditDuration(value: number | null): string {
  if (value === null) return "未记录";
  if (value < 1000) return `${Number(value.toFixed(2))} ms`;
  return `${Number((value / 1000).toFixed(3))} 秒`;
}

type AuditRequestContext = Pick<AuditEventItem, "context_recorded" | "source_type" | "http_method" | "route" | "request_id">;

export function auditContextUnavailable(event: AuditRequestContext): string {
  const http = event.source_type === "HTTP" || event.http_method || event.route || (event.source_type === "CORE" && event.request_id);
  if (!http && (event.source_type === "BACKGROUND" || event.source_type === "MAINTENANCE" || event.source_type === "INTERNAL")) return "不适用";
  return event.context_recorded ? "未记录" : "当时未记录";
}

export function auditClientLabel(event: AuditRequestContext & Pick<AuditEventItem, "user_agent">): string {
  if (!event.user_agent) return auditContextUnavailable(event);
  const device = sessionDevice(event.user_agent);
  if (device.browser !== "未知浏览器" || device.operatingSystem !== "未知系统") return device.label;
  const program = /^(curl|Wget|PostmanRuntime|node-fetch|undici|python-requests|python-httpx|Go-http-client)(?:\/|\s|$)/i.exec(event.user_agent)?.[1];
  return program ? `${program} 客户端` : "其他客户端";
}

export function auditValue(value: AuditJsonValue | undefined): string {
  if (value === undefined) return "未记录";
  if (value === null) return "未设置";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "string" ? (value || "空字符串") : JSON.stringify(value, null, 2);
}

export function auditChangeValues(change: AuditChange): readonly [string, string] {
  if (change.kind === "value") return [auditValue(change.before), auditValue(change.after)];
  const before = change.configured_before === undefined ? "原值未记录" : change.configured_before ? "已配置" : "未配置";
  const after = change.configured_after === undefined ? "已变更（值不记录）"
    : change.configured_after ? change.configured_before ? "已更换（值不记录）" : "已配置（值不记录）" : "已清除";
  return [before, after];
}

export function auditEventHref(event: Pick<AuditEventItem, "source" | "event_id">): string {
  return `/audit/${event.source}/${encodeURIComponent(event.event_id)}`;
}
