import type { RuntimeSettings } from "../api/client";

export const onboardingSteps = [
  { id: "application", title: "准备应用密钥", description: "生成并保管支付宝应用密钥" },
  { id: "provider", title: "配置支付宝接入", description: "在支付宝平台与 PerPay 之间完成接入" },
  { id: "collection", title: "设置经营码", description: "上传并核对实际收款的经营码" },
  { id: "api", title: "准备网站 API 密钥", description: "让业务网站安全调用 PerPay" },
  { id: "optional", title: "业务通知与备份", description: "可选，按需设置或稍后再配" },
  { id: "check", title: "检查收款就绪", description: "等待首次采集与自动确认准备完成" },
] as const;
export type OnboardingStep = typeof onboardingSteps[number]["id"];
export const onboardingPath = (step?: OnboardingStep) => "/settings/onboarding" + (step ? "/" + step : "");

export function nextRequiredStep(settings: RuntimeSettings): OnboardingStep {
  const steps = { GENERATE_APPLICATION_KEY: "application", CONFIGURE_PROVIDER: "provider", CONFIGURE_COLLECTION: "collection", GENERATE_API_KEY: "api" } as const;
  return settings.completion.next_step ? steps[settings.completion.next_step] : "check";
}

export function resolveOnboardingStep(settings: RuntimeSettings, requested?: string): OnboardingStep {
  const next = nextRequiredStep(settings);
  const index = onboardingSteps.findIndex(({ id }) => id === requested);
  const firstMissing = onboardingSteps.findIndex(({ id }) => id === next);
  return index < 0 || index > firstMissing ? next : onboardingSteps[index]!.id;
}

const prefix = "perpay:onboarding:deferred:";
const deferred = new Set<string>();
export function deferOnboarding(instanceId: string): void {
  deferred.add(instanceId);
  try { sessionStorage.setItem(prefix + instanceId, "1"); } catch { /* This tab still works if storage is unavailable. */ }
}
export function isOnboardingDeferred(instanceId: string): boolean {
  try { return deferred.has(instanceId) || sessionStorage.getItem(prefix + instanceId) === "1"; }
  catch { return deferred.has(instanceId); }
}
export function clearOnboardingDeferrals(): void {
  deferred.clear();
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch { /* No secrets or progress are stored here. */ }
}

export function deferredInstance(state: unknown): string | null {
  if (state && typeof state === "object" && "deferOnboardingFor" in state && typeof state.deferOnboardingFor === "string") return state.deferOnboardingFor;
  return null;
}
