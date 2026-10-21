import { workspaceScope } from "./workspace-scope";

/** Reading width belongs only to the selected independent details. */
export function isReadableDetailPage(pathname: string): boolean {
  const scope = workspaceScope(pathname);
  const path = scope.clientId ? pathname.slice(scope.base.length) : pathname;
  return /^\/(?:notifications\/[^/]+|reconciliation\/(?:matches|exceptions|transactions)\/[^/]+)\/?$/.test(path) ||
    (!scope.clientId && /^\/ledger\/[^/]+\/?$/.test(path));
}
