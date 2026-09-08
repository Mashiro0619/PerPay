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
  return createElement(RouterLink, { ...props, viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
}

export function NavLink({ viewTransition = true, ...props }: NavLinkProps & { ref?: Ref<HTMLAnchorElement> }) {
  const enabled = useRouteMotion();
  return createElement(RouterNavLink, { ...props, viewTransition: viewTransition && enabled && destinationAllowsMotion(props.to) });
}

export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate();
  const enabled = useRouteMotion();
  return useCallback(((destination: To | number, options?: NavigateOptions) => typeof destination === "number"
    ? navigate(destination)
    : navigate(destination, { ...options, viewTransition: options?.viewTransition !== false && enabled && destinationAllowsMotion(destination) })) as NavigateFunction, [navigate, enabled]);
}
