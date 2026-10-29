import type { To } from "react-router";
import { workspaceScope, type WorkspaceScope } from "./workspace-scope";

export type NavigationSection =
  | "overview"
  | "orders"
  | "work-items"
  | "notifications"
  | "settings"
  | "reconciliation"
  | "ledger"
  | "system"
  | "sites";

type NavigationLocation = {
  pathname: string;
  search?: string;
  hash?: string;
};

const SELECTION_PARAMETER = "selected_site";
const SITE_SETTINGS_SECTIONS = ["basic", "collection", "orders", "integration", "display"];
const RECONCILIATION_SECTIONS = ["matches", "exceptions", "conflicts"];
const LIST_QUERY_PARAMETERS = ["q", "sort_by", "sort_order"];
const DATE_QUERY_PARAMETERS = ["created_from", "created_to"];
const SECTION_QUERY_PARAMETERS: Record<NavigationSection, readonly string[]> = {
  overview: ["range"],
  orders: ["payment", "checkout", "alipay_account_id", ...LIST_QUERY_PARAMETERS, ...DATE_QUERY_PARAMETERS],
  notifications: ["status", ...LIST_QUERY_PARAMETERS, ...DATE_QUERY_PARAMETERS],
  "work-items": ["type", "visibility", ...LIST_QUERY_PARAMETERS],
  reconciliation: ["tab", "status", "provider_account_key", "alipay_account_id", "direction", "state", "association_status", "has_reversals", "associated_from", "associated_to", "occurred_from", "occurred_to", "min_amount_cents", "max_amount_cents", ...LIST_QUERY_PARAMETERS],
  ledger: ["direction", "state", "alipay_account_id", "occurred_from", "occurred_to", "min_amount_cents", "max_amount_cents", ...LIST_QUERY_PARAMETERS],
  settings: [],
  system: [],
  sites: [],
};

function selectionScope(clientId: string | null): WorkspaceScope {
  return clientId
    ? workspaceScope("/sites/" + encodeURIComponent(clientId))
    : { clientId: null, base: "" };
}

/** Only these pages may remember a site without changing their global API scope. */
export function isGlobalNavigationPage(pathname: string): boolean {
  return /^\/(?:reconciliation(?:\/[^/]+\/[^/]+)?|ledger(?:\/[^/]+)?|system|sites(?:\/(?:new|defaults))?)\/?$/.test(pathname);
}

export function navigationSelection(location: NavigationLocation): WorkspaceScope {
  const actual = workspaceScope(location.pathname);
  if (actual.clientId || !isGlobalNavigationPage(location.pathname)) return actual;
  return selectionScope(new URLSearchParams(location.search).get(SELECTION_PARAMETER));
}

function localPath(pathname: string): string {
  const path = workspaceScope(pathname).clientId
    ? pathname.replace(/^\/sites\/[^/]+/, "")
    : pathname;
  return path.replace(/\/$/, "") || "/";
}

export function navigationSection(pathname: string): NavigationSection | null {
  const actual = workspaceScope(pathname);
  const path = localPath(pathname);
  if (path === "/") return "overview";
  const business = /^\/(orders|work-items|notifications|settings)(?:\/|$)/.exec(path);
  if (business) return business[1] as NavigationSection;
  if (actual.clientId) {
    return /^\/reconciliation(?:\/|$)/.test(path) ? "work-items" : null;
  }
  if (!isGlobalNavigationPage(pathname)) return null;
  if (path === "/system") return "system";
  if (/^\/ledger(?:\/|$)/.test(path)) return "reconciliation";
  return path.startsWith("/reconciliation") ? "reconciliation" : "sites";
}

function isSelectionParameter(part: string): boolean {
  const key = part.split("=", 1)[0]!.replace(/\+/g, " ");
  try {
    return decodeURIComponent(key) === SELECTION_PARAMETER;
  } catch {
    return false;
  }
}

/** Strip just the navigation field; do not normalize other query encodings or order. */
function withoutSelection(search: string): string {
  const prefix = search.startsWith("?") ? "?" : "";
  const parts = search.slice(prefix.length).split("&");
  const remaining = parts.filter((part) => !isSelectionParameter(part));
  if (remaining.length === parts.length) return search;
  const query = remaining.join("&");
  return query ? prefix + query : "";
}

function selectionSearch(search: string, clientId: string | null): string {
  const stripped = withoutSelection(search);
  if (!clientId) return stripped;
  const query = stripped.startsWith("?") ? stripped.slice(1) : stripped;
  return "?" + (query ? query + "&" : "") + SELECTION_PARAMETER + "=" + encodeURIComponent(clientId);
}

export function sidebarHref(section: NavigationSection, selection: WorkspaceScope): string {
  if (section === "reconciliation" || section === "ledger" || section === "system" || section === "sites") {
    return "/" + section + selectionSearch("", selection.clientId);
  }
  if (section === "overview") return selection.base || "/";
  if (section === "settings") return selection.clientId ? selection.base + "/settings/basic" : "/settings";
  return selection.base + "/" + section;
}

function compatibleSearch(search: string, section: NavigationSection): URLSearchParams {
  const result = new URLSearchParams();
  const allowed = SECTION_QUERY_PARAMETERS[section];
  for (const [key, value] of new URLSearchParams(search)) {
    if (allowed.includes(key) && !result.has(key)) result.append(key, value);
  }
  return result;
}

function querySuffix(search: URLSearchParams): string {
  const query = search.toString();
  return query ? "?" + query : "";
}

/** A scope change never carries a resource identity or its pagination into another site. */
export function switchWorkspaceHref(
  location: NavigationLocation,
  nextClientId: string | null,
): string | null {
  const next = selectionScope(nextClientId);
  if (navigationSelection(location).clientId === next.clientId) return null;

  const search = location.search ?? "";
  if (isGlobalNavigationPage(location.pathname)) {
    const detail = /^\/reconciliation\/([^/]+)\/[^/]+\/?$/.exec(location.pathname);
    if (detail && detail[1] !== "transactions") {
      const query = compatibleSearch(search, "reconciliation");
      if (RECONCILIATION_SECTIONS.includes(detail[1]!)) query.set("tab", detail[1]!);
      else if (!RECONCILIATION_SECTIONS.includes(query.get("tab") ?? "")) query.delete("tab");
      return "/reconciliation" + selectionSearch(querySuffix(query), next.clientId);
    }
    // The data and any open form still belong to the same global page.
    return location.pathname + selectionSearch(search, next.clientId) + (location.hash ?? "");
  }

  const section = navigationSection(location.pathname) ?? "overview";
  if (section === "settings") {
    const actual = workspaceScope(location.pathname);
    const setting = /^\/settings\/([^/]+)$/.exec(localPath(location.pathname))?.[1];
    if (actual.clientId && next.clientId && setting && SITE_SETTINGS_SECTIONS.includes(setting)) {
      return next.base + "/settings/" + setting;
    }
    return sidebarHref("settings", next);
  }

  const query = compatibleSearch(search, section);
  if (section === "overview" && !["7", "30", "90"].includes(query.get("range") ?? "")) query.delete("range");
  if (section === "work-items" && next.clientId && query.get("type") === "LEDGER_CONFLICT") query.delete("type");
  return sidebarHref(section, next) + querySuffix(query);
}

export function actualPageAddress(location: NavigationLocation): string {
  const search = location.search ?? "";
  return location.pathname + (isGlobalNavigationPage(location.pathname) ? withoutSelection(search) : search);
}

function destinationParts(to: string) {
  const hashAt = to.indexOf("#");
  const hash = hashAt < 0 ? "" : to.slice(hashAt);
  const beforeHash = hashAt < 0 ? to : to.slice(0, hashAt);
  const searchAt = beforeHash.indexOf("?");
  return {
    pathname: searchAt < 0 ? beforeHash : beforeHash.slice(0, searchAt),
    search: searchAt < 0 ? "" : beforeHash.slice(searchAt),
    hash,
  };
}

/** Call after actual workspace routing; this never retargets a business resource. */
export function withNavigationSelection(
  to: To,
  location: NavigationLocation,
  preserve = true,
): To {
  if (!preserve) return to;
  const parts = typeof to === "string" ? destinationParts(to) : to;
  if (parts.pathname && !parts.pathname.startsWith("/")) return to;
  if (!isGlobalNavigationPage(parts.pathname || location.pathname)) return to;
  if (new URLSearchParams(parts.search).has(SELECTION_PARAMETER)) return to;
  const selection = navigationSelection(location);
  if (!selection.clientId) return to;
  const search = selectionSearch(parts.search ?? "", selection.clientId);
  return typeof to === "string"
    ? (parts.pathname ?? "") + search + (parts.hash ?? "")
    : { ...to, search };
}
