export const onboardingPath = () => "/settings/onboarding";

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
