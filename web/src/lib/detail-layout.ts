import { workspaceScope } from "./workspace-scope";

/** Dense presentation belongs only to the three selected independent details. */
export function isDenseDetailPage(pathname: string): boolean {
  const scope = workspaceScope(pathname);
  const path = scope.clientId ? pathname.slice(scope.base.length) : pathname;
  return /^\/(?:notifications\/[^/]+|reconciliation\/matches\/[^/]+)\/?$/.test(path) ||
    (!scope.clientId && /^\/ledger\/[^/]+\/?$/.test(path));
}
