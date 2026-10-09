import { workspaceScope, workspaceHref } from "./lib/workspace-scope";
import { withNavigationSelection } from "./lib/navigation-selection";
import { createContext, createElement, useCallback, useContext, type Ref } from "react";
import { Link as RouterLink, NavLink as RouterNavLink, useLocation, useNavigate as useRouterNavigate, type LinkProps, type NavLinkProps, type NavigateFunction, type NavigateOptions, type To } from "react-router";

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

type NavigationOptions = { global?: boolean; preserveSelectedSite?: boolean };

export function Link({ viewTransition = true, global = false, preserveSelectedSite = true, ...props }: LinkProps & NavigationOptions & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  const location = useLocation();
  const to = withNavigationSelection(
    global ? props.to : workspaceHref(workspaceScope(location.pathname), props.to),
    location,
    preserveSelectedSite,
  );
  return createElement(RouterLink, { ...props, to, state: props.state !== undefined ? props.state : detailNavigationState(to, location), viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
}

export function NavLink({ viewTransition = true, preserveSelectedSite = true, ...props }: NavLinkProps & Pick<NavigationOptions, "preserveSelectedSite"> & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  const location = useLocation();
  const to = withNavigationSelection(props.to, location, preserveSelectedSite);
  return createElement(RouterNavLink, { ...props, to, viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
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
      state: routerOptions.state !== undefined ? routerOptions.state : detailNavigationState(to, location),
      viewTransition: routerOptions.viewTransition !== false && enabled && destinationAllowsMotion(destination),
    });
  }) as WorkspaceNavigateFunction, [navigate, enabled, location]);
}

function localPath(path: string) { const scope = workspaceScope(path); return scope.clientId ? path.slice(scope.base.length) || "/" : path; }
const listLabels: Record<string, string> = { "/": "收款概览", "/orders": "订单列表", "/notifications": "业务通知", "/work-items": "待处理", "/reconciliation": "对账记录" };
type ListReturn = { to: string; label: string; state?: unknown };
function readListReturn(value: unknown): ListReturn | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ListReturn>;
  if (typeof item.to !== "string") return null;
  const pathname = item.to.split(/[?#]/)[0]!;
  return Object.hasOwn(listLabels, localPath(pathname)) ? { to: item.to, label: listLabels[localPath(pathname)]!, state: item.state } : null;
}
function detailNavigationState(destination: To, location: ReturnType<typeof useLocation>) {
  const pathname = typeof destination === "string" ? destination.split(/[?#]/)[0]! : destination.pathname ?? "";
  if (!["orders", "notifications", "reconciliation"].includes(localPath(pathname).split("/")[1] ?? "") || !localPath(pathname).split("/")[2]) return undefined;
  if (workspaceScope(pathname).clientId !== workspaceScope(location.pathname).clientId) return undefined;
  const inherited = readListReturn(location.state?.listReturn);
  const label = listLabels[localPath(location.pathname)];
  const listReturn = label ? { to: location.pathname + location.search, label, state: { pagination: location.state?.pagination } } : inherited;
  return listReturn ? { listReturn } : undefined;
}
export function useDetailBack(to: string, label: string): ListReturn {
  const location = useLocation(), scope = workspaceScope(location.pathname);
  const saved = readListReturn(location.state?.listReturn);
  return saved && workspaceScope(saved.to.split(/[?#]/)[0]!).clientId === scope.clientId ? saved : { to: workspaceHref(scope, to) as string, label: scope.clientId && to.startsWith("/reconciliation") ? "本站待办" : label };
}
