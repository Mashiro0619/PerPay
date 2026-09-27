import type { RuntimeSettings } from "../api/client";

export function applicationKeyState(settings: RuntimeSettings) {
  if (settings.application_public_key) return "configured";
  // The initial generate action must not be offered for incomplete historical configurations.
  if (
    settings.completion.application_key ||
    settings.secrets.provider_private_key.configured ||
    settings.provider !== null ||
    settings.provider_generations.length > 0
  )
    return "unavailable";
  return "missing";
}

export function canRegenerateApplicationKey(
  settings: RuntimeSettings,
): boolean {
  return Boolean(
    !settings.pending_application_key &&
      settings.application_public_key &&
      settings.application_key_fingerprint &&
      (settings.provider || settings.provider_generations.length === 0),
  );
}

export function alipayApplicationUrl(appId: string | null | undefined): string {
  const id = appId?.trim();
  if (!id) return "https://open.alipay.com/develop/manage";
  const url = new URL("https://open.alipay.com/develop/pm/sub/appinfo");
  url.searchParams.set("appId", id);
  return url.toString();
}
