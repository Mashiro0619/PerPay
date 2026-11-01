import { createContext, useContext, useId, useLayoutEffect, useRef } from "react";
import type { Location, Path, To } from "react-router";
import type { WorkspaceScope } from "./workspace-scope";
import { overlayOwner } from "./overlay-navigation";

export type OverlaySize = "md" | "lg" | "xl";
export type OverlayOpenOptions = { trigger?: HTMLElement; replace?: boolean; state?: unknown };
export interface OverlayNavigation {
  open(target: To, options?: OverlayOpenOptions): void;
  close(): void;
  back(): void;
  readonly target: Location | null;
  readonly background: Path;
}
export interface OverlayPresentation {
  readonly target: Location;
  readonly resourceScope: WorkspaceScope;
  readonly size: OverlaySize;
  requestClose(): void;
}

export const OverlayNavigationContext = createContext<OverlayNavigation | null>(null);
export const OverlayContext = createContext<OverlayPresentation | null>(null);
export const OverlayCloseGuardContext = createContext<((id: string, check: (() => boolean) | null) => void) | null>(null);
export const OverlayNavigationGuardContext = createContext<((id: string, check: (() => boolean) | null, owner: string) => void) | null>(null);
export const OverlayActionsContext = createContext<HTMLElement | null>(null);
export interface OverlaySteps {
  readonly portal: HTMLElement | null;
  readonly activeId: string | null;
  register(id: string, open: boolean, size?: OverlaySize): void;
  restoreFocus(target: () => HTMLElement | null): void;
}
export const OverlayStepsContext = createContext<OverlaySteps | null>(null);
export const OverlayNestedModalContext = createContext<((id: string, open: boolean) => void) | null>(null);

/** Null in ordinary pages and independently rendered component tests. */
export function useOverlayContext() { return useContext(OverlayContext); }
export function useOptionalOverlayNavigation() { return useContext(OverlayNavigationContext); }
export function useOverlayNavigation(): OverlayNavigation {
  const navigation = useOptionalOverlayNavigation();
  if (!navigation) throw new Error("Overlay navigation requires OverlayProvider");
  return navigation;
}

/** Keep the owning detail mounted, including on browser Back, while a command is being submitted. */
export function useOverlayCloseGuard(check: () => boolean) {
  const id = useId();
  const register = useContext(OverlayCloseGuardContext);
  const registerNavigation = useContext(OverlayNavigationGuardContext);
  const overlay = useOverlayContext();
  const owner = overlay ? overlayOwner(overlay.target) : null;
  const latest = useRef(check);
  latest.current = check;
  useLayoutEffect(() => {
    register?.(id, () => latest.current());
    if (owner) registerNavigation?.(id, () => latest.current(), owner);
    return () => {
      register?.(id, null);
      if (owner) registerNavigation?.(id, null, owner);
    };
  }, [id, register, registerNavigation, owner]);
}
