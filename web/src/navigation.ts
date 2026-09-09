import { createContext, createElement, useCallback, useContext, type Ref } from "react";
import { Link as RouterLink, NavLink as RouterNavLink, useLocation, useNavigate as useRouterNavigate, type LinkProps, type NavLinkProps, type NavigateFunction, type NavigateOptions, type To } from "react-router";

import { useReducedMotion } from "./lib/motion";

export const NavigationContext = createContext<(() => void) | null>(null);
export const useNavigationMenu = () => useContext(NavigationContext);

export function isPrivateRoute(pathname: string) {
  return ["settings", "test-payment", "login", "setup"].includes(pathname.split("/")[1] ?? "");
}

function useRouteMotion() {
  const { pathname } = useLocation();
  const reduced = useReducedMotion();
  return !reduced && !isPrivateRoute(pathname) && typeof document.startViewTransition === "function";
}

function destinationAllowsMotion(destination: To) {
  return !isPrivateRoute(typeof destination === "string" ? destination.split(/[?#]/)[0]! : destination.pathname ?? "");
}

export function Link({ viewTransition = true, ...props }: LinkProps & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  const location = useLocation();
  return createElement(RouterLink, { ...props, state: props.state ?? detailNavigationState(props.to, location), viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
}

export function NavLink({ viewTransition = true, ...props }: NavLinkProps & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  return createElement(RouterNavLink, { ...props, viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
}

export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate();
  const location = useLocation();
  const enabled = useRouteMotion();
  return useCallback(((destination: To | number, options?: NavigateOptions) => typeof destination === "number"
    ? navigate(destination)
    : navigate(destination, { ...options, state: options?.state ?? detailNavigationState(destination, location), viewTransition: options?.viewTransition !== false && enabled && destinationAllowsMotion(destination) })) as NavigateFunction, [navigate, enabled, location]);
}

const listLabels: Record<string, string> = { "/": "收款概览", "/orders": "订单列表", "/notifications": "业务通知", "/work-items": "待处理", "/reconciliation": "对账记录" };
type ListReturn = { to: string; label: string; state?: unknown };
function readListReturn(value: unknown): ListReturn | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ListReturn>;
  if (typeof item.to !== "string") return null;
  const pathname = item.to.split(/[?#]/)[0]!;
  return Object.hasOwn(listLabels, pathname) ? { to: item.to, label: listLabels[pathname]!, state: item.state } : null;
}
function detailNavigationState(destination: To, location: ReturnType<typeof useLocation>) {
  const pathname = typeof destination === "string" ? destination.split(/[?#]/)[0]! : destination.pathname ?? "";
  if (!["orders", "notifications", "reconciliation"].includes(pathname.split("/")[1] ?? "") || !pathname.split("/")[2]) return undefined;
  const inherited = readListReturn(location.state?.listReturn);
  const label = listLabels[location.pathname];
  const listReturn = label ? { to: location.pathname + location.search, label, state: { pagination: location.state?.pagination } } : inherited;
  return listReturn ? { listReturn } : undefined;
}
export function useDetailBack(to: string, label: string): ListReturn {
  return readListReturn(useLocation().state?.listReturn) ?? { to, label };
}
