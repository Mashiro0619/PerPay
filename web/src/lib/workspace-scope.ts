import type { To } from "react-router";
export type WorkspaceScope = Readonly<{
  clientId: string | null;
  base: string;
}>;
export function workspaceScope(pathname: string): WorkspaceScope {
  const match = /^\/sites\/([^/]+)(?:\/|$)/.exec(pathname);
  const value = match?.[1];
  if (!value || ["new", "defaults"].includes(value))
    return { clientId: null, base: "" };
  let clientId: string;
  try {
    clientId = decodeURIComponent(value);
  } catch {
    clientId = value;
  }
  return { clientId, base: "/sites/" + encodeURIComponent(clientId) };
}
export function workspaceHref(scope: WorkspaceScope, to: To): To {
  const raw = typeof to === "string" ? to : to.pathname;
  if (
    !raw ||
    !scope.clientId ||
    !/^\/(?:$|[?#]|orders(?:[/?#]|$)|notifications(?:[/?#]|$)|work-items(?:[/?#]|$)|reconciliation(?:[/?#]|$))/.test(
      raw,
    )
  )
    return to;
  let target = raw === "/" ? scope.base : scope.base + raw;
  if (/^\/reconciliation(?:$|[?#])/.test(raw))
    target = scope.base + "/work-items";
  // Shared conflicts are never represented as site-owned evidence.
  if (raw.startsWith("/reconciliation/conflicts/")) target = raw;
  return typeof to === "string" ? target : { ...to, pathname: target };
}
export function legacyWorkspaceUrl(
  pathname: string,
  search: string,
): string | null {
  const values = new URLSearchParams(search),
    id = values.get("api_client_id");
  if (
    !id ||
    workspaceScope(pathname).clientId ||
    !/^\/(?:$|orders(?:\/|$)|notifications(?:\/|$)|work-items(?:\/|$))/.test(
      pathname,
    )
  )
    return null;
  values.delete("api_client_id");
  values.delete("cursor");
  values.delete("page");
  const tail = values.toString();
  return (
    "/sites/" +
    encodeURIComponent(id) +
    (pathname === "/" ? "" : pathname) +
    (tail ? "?" + tail : "")
  );
}
