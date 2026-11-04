import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type Ref } from "react";

export type ToastDock = { bottom: number; maxHeight: number };
type RegisterFooter = (element: HTMLElement) => () => void;
export const ToastDockContext = createContext<RegisterFooter | null>(null);

const surfaceSelector = '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"]';
const inactiveSelector = '[hidden], [inert], [aria-hidden="true"], [data-closed], [data-ending-style]';
type FooterEntry = { element: HTMLElement; order: number; visible: boolean };

/** One registry chooses the foreground footer; a closing child cannot reset its parent's dock. */
function createDockRegistry(update: (dock: ToastDock | null) => void) {
  const footers = new Map<symbol, FooterEntry>();
  let sequence = 0;
  let refresh = () => {};

  const register: RegisterFooter = element => {
    const id = Symbol();
    footers.set(id, { element, order: ++sequence, visible: false });
    refresh();
    return () => {
      footers.delete(id);
      refresh();
    };
  };

  const connect = () => {
    const viewport = window.visualViewport;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      let selected: { entry: FooterEntry; surface: HTMLElement; rect: DOMRect } | null = null;
      for (const entry of footers.values()) {
        const { element } = entry;
        const surface = element.closest<HTMLElement>(surfaceSelector);
        const rect = element.getBoundingClientRect();
        const visible = element.isConnected && !!surface && rect.height > 0 && rect.width > 0
          && !element.closest(inactiveSelector) && !surface.hasAttribute("data-nested-dialog-open")
          && getComputedStyle(element).visibility !== "hidden";
        if (visible && !entry.visible) entry.order = ++sequence;
        entry.visible = visible;
        if (!visible || !surface) continue;
        const candidate = { entry, surface, rect };
        if (!selected || (selected.surface !== surface && selected.surface.contains(surface))
          || (selected.surface === surface && rect.top >= selected.rect.top)
          || (!surface.contains(selected.surface) && !selected.surface.contains(surface) && entry.order > selected.entry.order)) {
          selected = candidate;
        }
      }
      if (!selected) { update(null); return; }
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const bounds = selected.surface.getBoundingClientRect();
      const top = Math.max(bounds.top, viewportTop);
      const bottom = Math.min(bounds.bottom, viewportBottom);
      // A footer outside its scroll window starts reserving space as it enters view.
      const barTop = selected.rect.bottom <= top ? bottom : Math.min(selected.rect.top, bottom);
      const gap = Math.max(8, (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) * 0.75);
      update({
        bottom: Math.max(gap, window.innerHeight - barTop + gap),
        maxHeight: Math.max(48, barTop - top - 2 * gap),
      });
    };
    const schedule = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const changes = new MutationObserver(records => {
      if (records.some(record => record.type === "childList")) observe();
      schedule();
    });
    const observe = () => {
      resize.disconnect();
      changes.disconnect();
      const elements = new Set<HTMLElement>([document.documentElement]);
      const resizeElements = new Set<Element>(elements);
      for (const { element } of footers.values()) {
        // Scroll-container content can reflow without changing the footer's own size.
        const surface = element.closest(surfaceSelector);
        for (let parent: HTMLElement | null = element; parent && parent !== document.body; parent = parent.parentElement) {
          elements.add(parent);
          resizeElements.add(parent);
          if (surface?.contains(parent)) for (const child of parent.children) resizeElements.add(child);
        }
      }
      for (const element of resizeElements) resize.observe(element);
      for (const element of elements) {
        const surface = element.matches(surfaceSelector);
        changes.observe(element, {
          attributes: true,
          attributeFilter: ["hidden", "inert", "aria-hidden", "data-open", "data-closed", "data-ending-style", "data-nested-dialog-open", "class", "style"],
          ...(surface ? { childList: true, subtree: true, characterData: true } : {}),
        });
      }
    };
    refresh = () => { observe(); measure(); };
    refresh();
    // Capture covers independently scrolling popup bodies as well as the page.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("load", schedule, true);
    document.fonts?.addEventListener("loadingdone", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      disposed = true;
      refresh = () => {};
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("load", schedule, true);
      document.fonts?.removeEventListener("loadingdone", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  };
  return { register, connect };
}

export function useToastDockRegistry() {
  const [dock, setDock] = useState<ToastDock | null>(null);
  const registry = useMemo(() => createDockRegistry(next => {
    setDock(previous => previous?.bottom === next?.bottom && previous?.maxHeight === next?.maxHeight ? previous : next);
  }), []);
  useLayoutEffect(registry.connect, [registry]);
  return { dock, register: registry.register };
}

export function useToastFooterDock(footer: HTMLElement | null, active = true) {
  const register = useContext(ToastDockContext);
  useLayoutEffect(() => {
    if (active && footer && register) return register(footer);
  }, [footer, active, register]);
}

/** Preserve object refs and React callback-ref cleanup while registering a primitive footer. */
export function useToastFooterRef<T extends HTMLElement>(ref?: Ref<T>) {
  const [footer, setFooter] = useState<T | null>(null);
  useToastFooterDock(footer);
  return useCallback((element: T | null) => {
    setFooter(element);
    const cleanup = typeof ref === "function" ? ref(element) : undefined;
    if (ref && typeof ref !== "function") ref.current = element;
    return () => {
      setFooter(null);
      if (typeof cleanup === "function") cleanup();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
    };
  }, [ref]);
}
