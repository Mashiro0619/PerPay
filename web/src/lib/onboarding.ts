import type { RuntimeSettings, SystemStatus } from "../api/client";
import { presentSystemStatus } from "./system-status";
import { applicationKeyState } from "./application-key";

export const onboardingSteps = [
  {
    id: "application",
    title: "应用公钥",
    description: "首次使用时生成应用公钥，再复制到支付宝的接口加签设置。",
  },
  {
    id: "provider",
    title: "支付宝接入",
    description: "填写支付宝应用信息，建立账单查询连接。",
  },
  {
    id: "collection",
    title: "经营码",
    description: "使用接入账户的经营码，并确认订单有效期与金额规则。",
  },
  {
    id: "api",
    title: "业务系统接入",
    description: "在 PerPay 生成接入凭证，再复制到业务系统后端的 PerPay 配置。",
  },
  {
    id: "optional",
    title: "通知与备份",
    description: "按需开启付款通知和自动备份，不启用也可以继续。",
  },
  {
    id: "check",
    title: "收款检查",
    description: "检查配置与运行状态，通过后可进入控制台或进行小额真实测试。",
  },
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number]["id"];
export const onboardingPath = (step?: OnboardingStep) =>
  "/settings/onboarding" + (step ? "/" + step : "");

export function onboardingStepDescription(
  step: OnboardingStep,
  settings: RuntimeSettings,
): string {
  if (step === "application") {
    if (settings.pending_application_key)
      return "新应用公钥已生成。上传到支付宝后，下一步填写支付宝公钥并验证启用。";
    const state = applicationKeyState(settings);
    if (state === "configured")
      return "应用公钥已就绪。复制到支付宝的接口加签设置，已配置则直接下一步。";
    if (state === "unavailable")
      return "此实例已有密钥或支付宝接入记录，不能按首次接入重新生成。";
  }
  if (step === "provider" && settings.pending_application_key)
    return "填写上传后获取的支付宝公钥，验证并启用新密钥。";
  return onboardingSteps.find((item) => item.id === step)!.description;
}

export function nextRequiredStep(settings: RuntimeSettings): OnboardingStep {
  if (settings.pending_application_key) return "provider";
  const steps = {
    GENERATE_APPLICATION_KEY: "application",
    CONFIGURE_PROVIDER: "provider",
    CONFIGURE_COLLECTION: "collection",
    GENERATE_API_KEY: "api",
  } as const;
  return settings.completion.next_step
    ? steps[settings.completion.next_step]
    : "check";
}

export function resolveOnboardingStep(
  settings: RuntimeSettings,
  requested?: string,
): OnboardingStep {
  const next = nextRequiredStep(settings);
  const index = onboardingSteps.findIndex(({ id }) => id === requested);
  const firstMissing = onboardingSteps.findIndex(({ id }) => id === next);
  return index < 0 || index > firstMissing ? next : onboardingSteps[index]!.id;
}

const prefix = "perpay:onboarding:deferred:";
const deferred = new Set<string>();
export function deferOnboarding(instanceId: string): void {
  deferred.add(instanceId);
  try {
    sessionStorage.setItem(prefix + instanceId, "1");
  } catch {
    /* This tab still works if storage is unavailable. */
  }
}
export function isOnboardingDeferred(instanceId: string): boolean {
  try {
    return (
      deferred.has(instanceId) ||
      sessionStorage.getItem(prefix + instanceId) === "1"
    );
  } catch {
    return deferred.has(instanceId);
  }
}
export function clearOnboardingDeferrals(): void {
  deferred.clear();
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch {
    /* No secrets or progress are stored here. */
  }
}

export function deferredInstance(state: unknown): string | null {
  if (
    state &&
    typeof state === "object" &&
    "deferOnboardingFor" in state &&
    typeof state.deferOnboardingFor === "string"
  )
    return state.deferOnboardingFor;
  return null;
}

/** Operational notices only; never changes the payment readiness gate. */
export function onboardingRuntimeWarnings(data: SystemStatus): string[] {
  const health = presentSystemStatus(data);
  if (!health.runtimeWarning) return [];
  const warnings: string[] = [];
  for (const [name, worker, healthy] of [
    ["账本采集", data.ledger, health.ledgerHealthy],
    ["自动确认", data.reconciliation, health.reconciliationHealthy],
    ["业务通知", data.webhook, health.webhookHealthy],
  ] as const) {
    if (healthy) continue;
    if (worker.last_error_code)
      warnings.push(name + "最近运行异常：" + worker.last_error_code + "。");
    else if (worker.state === "catching_up")
      warnings.push(name + "正在补处理历史数据。");
    else if (worker.state === "stopped")
      warnings.push(name + "任务已停止，请检查运行状态。");
    else warnings.push(name + "任务尚未恢复正常，请检查运行状态。");
  }
  const backup = data.backup;
  if (backup.recovery_required)
    warnings.push("备份状态提示实例需要恢复，请先查看运行状态和维护说明。");
  if (backup.configuration_mismatch)
    warnings.push("自动备份配置与运行状态不一致。");
  if (backup.clock_moved_backwards)
    warnings.push("备份检测到服务器时间回拨，请检查系统时间。");
  if (
    backup.enabled &&
    !health.backupHealthy &&
    !backup.recovery_required &&
    !backup.configuration_mismatch &&
    !backup.clock_moved_backwards
  )
    warnings.push("自动备份尚未就绪，请检查备份任务及最近结果。");
  if (data.work_items === null)
    warnings.push("待处理事项统计暂不可用，暂时无法确认业务待办数量。");
  if (
    data.status === "degraded" &&
    (data.ledger.conflicts === null || data.reconciliation.exceptions === null)
  )
    warnings.push("部分业务状态统计暂不可用，请在运行状态页核对。");
  if (warnings.length === 0)
    warnings.push(
      "系统返回了运行告警，但未提供可定位的原因，请在运行状态页核对。",
    );
  return warnings;
}
