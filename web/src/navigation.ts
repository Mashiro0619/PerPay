import { workspaceScope, workspaceHref } from "./lib/workspace-scope";
import { actualPageAddress, isGlobalNavigationPage, navigationSelection, switchWorkspaceHref, withNavigationSelection } from "./lib/navigation-selection";
import { createContext, createElement, useCallback, useContext, useLayoutEffect, useRef, type Ref } from "react";
import { Link as RouterLink, NavLink as RouterNavLink, parsePath, useLocation, useNavigate as useRouterNavigate, type LinkProps, type NavLinkProps, type NavigateFunction, type NavigateOptions, type To } from "react-router";

import { useReducedMotion } from "./lib/motion";

export const NavigationContext = createContext<(() => void) | null>(null);
export const useNavigationMenu = () => useContext(NavigationContext);

export function isPrivateRoute(pathname: string) {
  return ["settings", "sites", "test-payment", "login", "setup"].includes(pathname.split("/")[1] ?? "");
}

function useRouteMotion() {
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  return !reduced && !isPrivateRoute(pathname) && typeof document.startViewTransition === "function";
}

function destinationAllowsMotion(destination: To) {
  return !isPrivateRoute(typeof destination === "string" ? destination.split(/[?#]/)[0]! : destination.pathname ?? "");
}

function selectionOnlyNavigation(destination: To, location: ReturnType<typeof useLocation>) {
  const target = typeof destination === "string" ? parsePath(destination) : destination;
  const next = { pathname: target.pathname || location.pathname, search: target.search ?? "" };
  return location.search !== next.search &&
    location.hash === (target.hash ?? "") &&
    actualPageAddress(location) === actualPageAddress(next);
}

type NavigationOptions = { global?: boolean; preserveSelectedSite?: boolean };

function navigationFeedback(to: To) {
  const path = typeof to === "string" ? to : to.pathname;
  let internal = !path || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path);
  if (!internal && typeof window !== "undefined") {
    try { internal = new URL(path!, window.location.href).origin === window.location.origin; }
    catch { /* Invalid or non-web destinations do not get internal navigation feedback. */ }
  }
  return { "data-internal-link": internal ? "" : undefined };
}

export function Link({ viewTransition = true, global = false, preserveSelectedSite = true, ...props }: LinkProps & NavigationOptions & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  const location = useLocation();
  const navigate = useRouterNavigate();
  const to = withNavigationSelection(
    global ? props.to : workspaceHref(workspaceScope(location.pathname), props.to),
    location,
    preserveSelectedSite,
  );
  const motion = viewTransition && enabled && destinationAllowsMotion(props.to) && !selectionOnlyNavigation(to, location);
  return createElement(RouterLink, { ...props, ...navigationFeedback(to), to,
    state: props.state !== undefined ? props.state : detailNavigationState(to, location), viewTransition: motion,
    onClick(event) {
      props.onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey ||
        props.reloadDocument || props.download || (props.target && props.target !== "_self") || props.state !== undefined || !isTransactionList(location.pathname, location.search)) return;
      const state = detailNavigationState(to, location, true);
      if (!state) return;
      event.preventDefault();
      void navigate(to, { state, replace: props.replace, relative: props.relative,
        preventScrollReset: props.preventScrollReset, viewTransition: motion });
    },
  });
}

export function NavLink({ viewTransition = true, preserveSelectedSite = true, ...props }: NavLinkProps & Pick<NavigationOptions, "preserveSelectedSite"> & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  const location = useLocation();
  const to = withNavigationSelection(props.to, location, preserveSelectedSite);
  return createElement(RouterNavLink, { ...props, ...navigationFeedback(to), to, viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) && !selectionOnlyNavigation(to, location) });
}

type WorkspaceNavigateFunction = {
  (to: To, options?: NavigateOptions & NavigationOptions): ReturnType<NavigateFunction>;
  (delta: number): ReturnType<NavigateFunction>;
};

export function useNavigate(): WorkspaceNavigateFunction {
  const navigate = useRouterNavigate();
  const location = useLocation();
  const enabled = useRouteMotion();
  return useCallback(((destination: To | number, options?: NavigateOptions & NavigationOptions) => {
    if (typeof destination === "number") return navigate(destination);
    const { global = false, preserveSelectedSite = true, ...routerOptions } = options ?? {};
    const to = withNavigationSelection(
      global ? destination : workspaceHref(workspaceScope(location.pathname), destination),
      location,
      preserveSelectedSite,
    );
    return navigate(to, {
      ...routerOptions,
      state: routerOptions.state !== undefined ? routerOptions.state : detailNavigationState(to, location, true),
      viewTransition: routerOptions.viewTransition !== false && enabled && destinationAllowsMotion(destination) && !selectionOnlyNavigation(to, location),
    });
  }) as WorkspaceNavigateFunction, [navigate, enabled, location]);
}

function localPath(path: string) { const scope = workspaceScope(path); return scope.clientId ? path.slice(scope.base.length) || "/" : path; }
function isTransactionList(pathname: string, search: string) {
  return pathname === "/ledger" || (pathname === "/reconciliation" && !["conflicts", "exceptions"].includes(new URLSearchParams(search).get("tab") ?? ""));
}
const listLabels: Record<string, string> = { "/": "总览", "/orders": "订单列表", "/notifications": "通知", "/work-items": "待处理", "/reconciliation": "对账", "/ledger": "支付宝流水" };
type ListReturn = { to: string; label: string; state?: unknown };
function readListReturn(value: unknown): ListReturn | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ListReturn>;
  if (typeof item.to !== "string") return null;
  const pathname = item.to.split(/[?#]/)[0]!;
  return Object.hasOwn(listLabels, localPath(pathname)) ? { to: item.to, label: listLabels[localPath(pathname)]!, state: item.state } : null;
}
function detailNavigationState(destination: To, location: ReturnType<typeof useLocation>, capturePosition = false) {
  const parts = typeof destination === "string" ? parsePath(destination) : destination;
  if (!parts.pathname && parts.hash) return location.state;
  const pathname = typeof destination === "string" ? destination.split(/[?#]/)[0]! : destination.pathname ?? "";
  if (!["orders", "notifications", "reconciliation", "ledger"].includes(localPath(pathname).split("/")[1] ?? "") || !localPath(pathname).split("/")[2]) return undefined;
  if (workspaceScope(pathname).clientId !== workspaceScope(location.pathname).clientId) return undefined;
  const inherited = readListReturn(location.state?.listReturn);
  const label = listLabels[localPath(location.pathname)];
  const position = capturePosition && isTransactionList(location.pathname, location.search) ? rememberLedgerPosition(location) : undefined;
  const listReturn = label ? { to: location.pathname + location.search, label,
    state: { pagination: location.state?.pagination, ...(position ? { ledgerPosition: position } : {}) } } : inherited;
  return listReturn ? { listReturn } : undefined;
}

type LedgerPosition = { scope: string; key: string; y: number };
const ledgerPositions = new Map<string, LedgerPosition>();
function rememberLedgerPosition(location: ReturnType<typeof useLocation>): LedgerPosition {
  const position = { scope: actualPageAddress(location), key: location.key, y: Math.max(0, window.scrollY) };
  ledgerPositions.delete(location.key);
  ledgerPositions.set(location.key, position);
  if (ledgerPositions.size > 100) ledgerPositions.delete(ledgerPositions.keys().next().value!);
  return position;
}
function readLedgerPosition(value: unknown): LedgerPosition | undefined {
  if (!value || typeof value !== "object") return;
  const position = value as Partial<LedgerPosition>;
  if (typeof position.scope !== "string" || typeof position.key !== "string" ||
    typeof position.y !== "number" || !Number.isFinite(position.y) || position.y < 0) return;
  return position as LedgerPosition;
}
/** Restore only after the requested page has rendered; site memory keeps the same position. */
export function useLedgerListPosition(ready: boolean) {
  const location = useLocation();
  const restored = useRef<LedgerPosition | null>(null);
  const position = readLedgerPosition(location.state?.ledgerPosition) ?? ledgerPositions.get(location.key);
  const scope = actualPageAddress(location);
  useLayoutEffect(() => {
    if (!ready || !position || position.scope !== scope ||
      (restored.current?.key === position.key && restored.current.scope === scope)) return;
    restored.current = position;
    window.scrollTo({ top: position.y, left: 0, behavior: "instant" });
    const frame = requestAnimationFrame(() => window.scrollTo({ top: position.y, left: 0, behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [ready, position, scope]);
}
export function useDetailBack(to: string, label: string): ListReturn {
  const location = useLocation(), scope = workspaceScope(location.pathname);
  const saved = readListReturn(location.state?.listReturn);
  if (saved && workspaceScope(saved.to.split(/[?#]/)[0]!).clientId === scope.clientId) {
    if (isTransactionList(saved.to.split(/[?#]/)[0]!, parsePath(saved.to).search ?? "") && isGlobalNavigationPage(location.pathname)) {
      const target = parsePath(saved.to);
      return { ...saved, to: switchWorkspaceHref({ ...target, pathname: target.pathname! }, navigationSelection(location).clientId) ?? saved.to };
    }
    return saved;
  }
  return { to: workspaceHref(scope, to) as string, label: scope.clientId && to.startsWith("/reconciliation") ? "本站待处理" : scope.clientId && to === "/orders" ? "本站订单" : label };
}
