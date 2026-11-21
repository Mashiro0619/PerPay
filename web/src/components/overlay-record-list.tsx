import { useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, type Path, type To } from "react-router";
import { withNavigationSelection } from "@/lib/navigation-selection";
import { OverlayRecordListRegistryContext, OverlayRecordListScopeContext } from "@/lib/overlay-context";
import { isRecordDetailRoute, overlayRoute, parseOverlayTarget } from "@/lib/overlay-navigation";
import { workspaceHref, workspaceScope } from "@/lib/workspace-scope";

/**
 * Registers a list's ordered record targets and optional pagination controls
 * with OverlayProvider so the detail drawer can step across rows and page
 * boundaries without scanning background DOM.
 */
export function OverlayRecordList({
  items,
  global = false,
  hasPrevious = false,
  hasNext = false,
  pending = false,
  failed = false,
  pageKey,
  onPreviousPage,
  onNextPage,
  children,
}: {
  items: readonly To[];
  /** Matches `<Link global>` on row links: resolves targets outside the active site workspace. */
  global?: boolean;
  hasPrevious?: boolean;
  hasNext?: boolean;
  pending?: boolean;
  failed?: boolean;
  pageKey?: string;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
  children: ReactNode;
}) {
  const listId = useId();
  const registry = useContext(OverlayRecordListRegistryContext);
  const location = useLocation();
  const scope = workspaceScope(location.pathname);
  const elements = useRef(new Map<string, HTMLAnchorElement>());
  const callbacks = useRef({ onPreviousPage, onNextPage });
  callbacks.current = { onPreviousPage, onNextPage };

  const registerRowElement = useCallback((pathname: string, element: HTMLAnchorElement | null, previous?: HTMLAnchorElement | null) => {
    if (element) {
      elements.current.set(pathname, element);
    } else if (!previous || elements.current.get(pathname) === previous) {
      elements.current.delete(pathname);
    }
  }, []);

  const scopeValue = useMemo(() => ({ listId, registerRowElement }), [listId, registerRowElement]);

  const resolved = useMemo(() => {
    const seen = new Set<string>();
    const targets: Path[] = [];
    for (const item of items) {
      const scoped = withNavigationSelection(global ? item : workspaceHref(scope, item), location, true);
      const target = parseOverlayTarget(scoped);
      if (!target || !isRecordDetailRoute(overlayRoute(target.pathname)) || seen.has(target.pathname)) continue;
      seen.add(target.pathname);
      targets.push(target);
    }
    return targets;
  }, [items, global, scope.base, location.pathname, location.search]);

  const signature = resolved.map(item => item.pathname + item.search + item.hash).join("\n");
  const canPrevious = !!(hasPrevious && onPreviousPage);
  const canNext = !!(hasNext && onNextPage);

  useLayoutEffect(() => {
    if (!registry) return;
    registry.registerList(listId, {
      items: resolved,
      hasPrevious: canPrevious,
      hasNext: canNext,
      pending,
      failed,
      ...(pageKey !== undefined ? { pageKey } : {}),
      ...(canPrevious ? { onPreviousPage: () => callbacks.current.onPreviousPage?.() } : {}),
      ...(canNext ? { onNextPage: () => callbacks.current.onNextPage?.() } : {}),
      getElement: pathname => {
        const element = elements.current.get(pathname) ?? null;
        return element?.isConnected ? element : null;
      },
    });
  }, [registry, listId, signature, canPrevious, canNext, pending, failed, pageKey]);

  useLayoutEffect(() => () => registry?.registerList(listId, null), [registry, listId]);

  return <OverlayRecordListScopeContext value={scopeValue}>{children}</OverlayRecordListScopeContext>;
}
