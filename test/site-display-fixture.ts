import type { SiteStore } from "../src/sites/store.ts";
import type { SitePolicy } from "../src/sites/model.ts";

export function setTestSiteDisplay(sites: SiteStore, clientId: string, display: Partial<SitePolicy["display"]>) {
  const current = sites.get(clientId)!;
  return sites.update(clientId, { revision: current.revision, configuration: {
    ...current.configuration, policy: { ...current.configuration.policy,
      display: { ...current.configuration.policy.display, ...display } },
  } }, { actorId: "admin" });
}
