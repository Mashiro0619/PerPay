import { createPath, matchPath, parsePath, type Location, type Path, type To } from "react-router";
import { workspaceScope } from "./workspace-scope";
import type { OverlaySize } from "./overlay-context";

export const OVERLAY_PARAMETER = "overlay";
export const OVERLAY_HISTORY_KEY = "perpayOverlay";
export type OverlayRouteKind = "order" | "notification" | "ledger" | "evidence" | "audit" | "audit-status" | "site" | "site-summary" | "site-defaults" | "account" | "settings" | "password" | "admin-access" | "session" | "test-payment";
export type OverlayRoute = { kind: OverlayRouteKind; pattern: string; title: string; size: OverlaySize; parent: string };

const definitions: ReadonlyArray<{ pattern: string; kind: OverlayRouteKind; title: string; size: OverlaySize }> = [
  { pattern: "/orders/:orderId", kind: "order", title: "订单详情", size: "lg" },
  { pattern: "/sites/:clientId/orders/:orderId", kind: "order", title: "订单详情", size: "lg" },
  { pattern: "/notifications/:deliveryId", kind: "notification", title: "通知详情", size: "lg" },
  { pattern: "/sites/:clientId/notifications/:deliveryId", kind: "notification", title: "通知详情", size: "lg" },
  { pattern: "/reconciliation/transactions/:ledgerEntryId", kind: "ledger", title: "流水与对账详情", size: "xl" },
  { pattern: "/ledger/:ledgerEntryId", kind: "ledger", title: "流水与对账详情", size: "xl" },
  { pattern: "/reconciliation/:kind/:resourceId", kind: "evidence", title: "对账详情", size: "lg" },
  { pattern: "/sites/:clientId/reconciliation/:kind/:resourceId", kind: "evidence", title: "对账详情", size: "lg" },
  { pattern: "/audit/:source/:eventId", kind: "audit", title: "审计日志详情", size: "md" },
  { pattern: "/audit/status", kind: "audit-status", title: "审计记录状态", size: "md" },
];
export const overlayRouteDefinitions = definitions;

/** The registry names existing views; it never treats a workspace home as a record. */
export function overlayRoute(pathname: string): OverlayRoute | null {
  for (const definition of definitions) {
    const match = matchPath({ path: definition.pattern, caseSensitive: true, end: true }, pathname);
    if (!match) continue;
    if (Object.values(match.params).some(value => value !== undefined && (!value || value === "." || value === ".." || /[\\/\p{Cc}]/u.test(value)))) return null;
    if (definition.kind === "evidence" && !["matches", "exceptions", "candidates", "conflicts", "ledger"].includes(match.params.kind ?? "")) return null;
    if (definition.kind === "audit" && !["core", "activity"].includes(match.params.source ?? "")) return null;
    if (definition.kind === "settings" && ["accounts", "security"].includes(match.params.section ?? "")) continue;
    const scope = workspaceScope(pathname);
    let parent = "/";
    if (definition.kind === "order") parent = scope.base + "/orders";
    if (definition.kind === "notification") parent = scope.base + "/notifications";
    if (definition.kind === "ledger") parent = "/reconciliation?tab=transactions";
    if (definition.kind === "evidence") parent = scope.clientId ? scope.base + "/work-items" : "/reconciliation" + (["matches", "exceptions", "conflicts"].includes(match.params.kind ?? "") ? "?tab=" + match.params.kind : "");
    if (definition.kind === "audit" || definition.kind === "audit-status") parent = "/audit";
    if (definition.kind === "site" || definition.kind === "site-defaults" || definition.kind === "site-summary") parent = "/sites" + (scope.clientId ? "?selected_site=" + encodeURIComponent(scope.clientId) : "");
    if (definition.kind === "site" && scope.clientId) parent = scope.base + "/settings/basic";
    if (definition.kind === "account") parent = "/settings/accounts";
    if (definition.kind === "settings") parent = "/settings/" + match.params.section;
    if (["password", "admin-access", "session"].includes(definition.kind)) parent = "/settings/security";
    return { ...definition, parent };
  }
  return null;
}

export function parseOverlayTarget(value: To | null | undefined): Path | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : createPath(value);
  if (text.length > 8_192 || !text.startsWith("/") || text.startsWith("//") || /[\\\p{Cc}]/u.test(text)) return null;
  const parsed = parsePath(text);
  const pathname = parsed.pathname ?? "/";
  if (!overlayRoute(pathname) || new URLSearchParams(parsed.search).has(OVERLAY_PARAMETER)) return null;
  return { pathname, search: parsed.search ?? "", hash: parsed.hash ?? "" };
}

export function readOverlayTarget(search: string): Path | null {
  const values = new URLSearchParams(search).getAll(OVERLAY_PARAMETER);
  return values.length === 1 ? parseOverlayTarget(values[0]) : null;
}

/** Remove only presentation state, preserving the original encoding of every list filter. */
export function withoutOverlaySearch(search: string): string {
  const prefix = search.startsWith("?") ? "?" : "";
  const parts = search.slice(prefix.length).split("&");
  const remaining = parts.filter(part => {
    try { return decodeURIComponent(part.split("=", 1)[0]!.replace(/\+/g, " ")) !== OVERLAY_PARAMETER; }
    catch { return true; }
  });
  if (parts.length === remaining.length) return search;
  const result = remaining.join("&");
  return result ? prefix + result : "";
}

export function overlayBackground(location: Pick<Location, "pathname" | "search" | "hash">): Path {
  return { pathname: location.pathname, search: withoutOverlaySearch(location.search), hash: location.hash };
}

export function withOverlayTarget(background: Pick<Location, "pathname" | "search" | "hash">, target: Path): Path {
  const search = withoutOverlaySearch(background.search).replace(/^\?/, "");
  return { pathname: background.pathname, search: "?" + (search ? search + "&" : "") + OVERLAY_PARAMETER + "=" + encodeURIComponent(createPath(target)), hash: background.hash };
}

/** Query/pagination changes within one record do not replace its edit owner. */
export function overlayOwner(target: Pick<Path, "pathname">): string { return "overlay:" + target.pathname; }

export function isOverlayBackground(pathname: string): boolean {
  return !overlayRoute(pathname) && /^\/(?:$|orders\/?$|notifications\/?$|work-items\/?$|reconciliation\/?$|ledger\/?$|audit\/?$|system\/?$|sites\/?$|settings(?:\/onboarding(?:\/[^/]+)?|\/[^/]+)?\/?$|sites\/[^/]+(?:\/(?:orders|notifications|work-items|settings(?:\/[^/]+)?))?\/?$)/.test(pathname);
}

export type OverlayHistory = {
  version: 1;
  rootKey: string;
  rootUrl: string;
  depth: number;
  rootState: unknown;
  detailState: unknown;
  scrollY: number;
};

export function readOverlayHistory(state: unknown): OverlayHistory | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[OVERLAY_HISTORY_KEY];
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<OverlayHistory>;
  if (entry.version !== 1 || typeof entry.rootKey !== "string" || typeof entry.rootUrl !== "string" ||
    !Number.isSafeInteger(entry.depth) || entry.depth! < 1 || entry.depth! > 1_000 ||
    typeof entry.scrollY !== "number" || !Number.isFinite(entry.scrollY) || entry.scrollY < 0) return null;
  const root = parsePath(entry.rootUrl);
  if (!root.pathname || !isOverlayBackground(root.pathname) || new URLSearchParams(root.search).has(OVERLAY_PARAMETER)) return null;
  return entry as OverlayHistory;
}

export function stateRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : {};
}

export function legacyOverlayLocation(location: Pick<Location, "pathname" | "search" | "hash" | "state" | "key">): { to: Path; state: Record<string, unknown> } | null {
  const target = parseOverlayTarget(location);
  if (!target) return null;
  const definition = overlayRoute(target.pathname)!;
  const saved = stateRecord(stateRecord(location.state).listReturn);
  const savedPath = typeof saved.to === "string" ? parsePath(saved.to) : null;
  const parent = savedPath?.pathname && isOverlayBackground(savedPath.pathname) && !new URLSearchParams(savedPath.search).has(OVERLAY_PARAMETER)
    ? savedPath : parsePath(definition.parent);
  const background = { pathname: parent.pathname!, search: parent.search ?? "", hash: parent.hash ?? "" };
  const selection = new URLSearchParams(location.search).get("selected_site");
  if (selection && !new URLSearchParams(background.search).has("selected_site")) {
    const search = new URLSearchParams(background.search);
    search.set("selected_site", selection);
    background.search = "?" + search.toString();
  }
  return { to: withOverlayTarget(background, target), state: { ...stateRecord(saved.state), [OVERLAY_HISTORY_KEY]: {
    version: 1, rootKey: "direct:" + location.key, rootUrl: createPath(background), depth: 1,
    rootState: saved.state ?? null, detailState: location.state, scrollY: 0,
  } satisfies OverlayHistory } };
}
