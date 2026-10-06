import type { SiteStore } from "../src/sites/store.ts";
import type { SettingsAuditContext } from "../src/settings/store.ts";
import type { SitePolicy } from "../src/sites/model.ts";

/** Configure a specific test website through real key rotation and versioned writes. */
export function configureTestSiteNotifications(sites: SiteStore, clientId: string,
  input: Partial<SitePolicy["notification_delivery"]> & { enabled: boolean; allowed_origin?: string | null; return_origin?: string | null },
  audit: SettingsAuditContext = { actorId: "admin" }) {
  let site = sites.get(clientId)!;
  if (input.enabled && !sites.notificationSecret(clientId)) {
    site = sites.rotateSecret(clientId, "webhook_secret", site.revision, audit).site;
  }
  const { enabled, allowed_origin, return_origin, ...delivery } = input;
  return sites.update(clientId, { revision: site.revision, configuration: {
    ...site.configuration, notifications_enabled: enabled,
    notification_origin: allowed_origin === undefined ? site.configuration.notification_origin : allowed_origin,
    return_origin: return_origin === undefined ? site.configuration.return_origin : return_origin,
    policy: { ...site.configuration.policy,
      notification_delivery: { ...site.configuration.policy.notification_delivery, ...delivery } },
  } }, audit);
}
