import { Component, Suspense, createContext, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, UNSAFE_NavigationContext, UNSAFE_RouteContext, createPath, useLocation, useNavigate, useParams, type Location, type NavigateOptions, type Navigator, type Path, type To } from "react-router";
import { ArrowLeft, ChevronDown, ChevronUp, XIcon } from "lucide-react";
import { OverlayActionsContext, OverlayCloseGuardContext, OverlayContext, OverlayNavigationContext, OverlayNestedModalContext, OverlayRecordListRegistryContext, OverlayStepsContext, OverlaySummaryContext, type OverlayNavigation, type OverlayRecordListEntry, type OverlayRecordListRegistry, type OverlaySize } from "@/lib/overlay-context";
import { OVERLAY_HISTORY_KEY, OVERLAY_PARAMETER, isRecordDetailRoute, legacyOverlayLocation, overlayBackground, overlayOwner, overlayRoute, overlayRouteDefinitions, parseOverlayTarget, readOverlayHistory, readOverlayTarget, stateRecord, withOverlayTarget, type OverlayHistory, type OverlayRouteKind } from "@/lib/overlay-navigation";
import { actualPageAddress } from "@/lib/navigation-selection";
import { workspaceScope } from "@/lib/workspace-scope";
import { ResourceWorkspaceProvider } from "@/workspace";
import { useSession } from "@/auth";
import { useDraftGuard } from "@/drafts";
import { PageHeadingProvider, PageHeadingSlot, usePageHeading } from "@/components/page-heading";
import { InlinePageHeaderActions, PageHeaderActionsProvider, PageHeaderActionsSlot } from "@/components/page-header-actions";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/admin-dialog";
import { ErrorNotice, Loading } from "@/components/request-state";
import { RequestNoticeProvider } from "@/lib/request-notices";
import { RequestNoticeBanner } from "@/components/request-notice-banner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { useToastFooterDock } from "@/lib/toast-layout";

type RootPosition = { trigger: HTMLElement | null; triggerId: string | null; y: number; canReturn: boolean; background: Path; stepped?: boolean };
type PendingPageStep = { listId: string; direction: "previous" | "next"; fromPageKey: string; fromPathname: string; approvedOwners: readonly string[] };
type InternalNavigation = OverlayNavigation & {
  readonly hasOverlay: boolean;
  readonly canGoBack: boolean;
  readonly listVersion: number;
  navigateTarget(to: To, options?: NavigateOptions): void;
  step(to: Path, trigger: HTMLAnchorElement | null, listId?: string): boolean;
  findRecordList(pathname: string): { id: string; list: OverlayRecordListEntry } | null;
  getRecordList(id: string): OverlayRecordListEntry | null;
  blocked(): boolean;
  registerCloseGuard(id: string, check: (() => boolean) | null): void;
  restoreFocus(): HTMLElement | null;
};
const InternalOverlayContext = createContext<InternalNavigation | null>(null);

function sameRecordListEntry(left: OverlayRecordListEntry | undefined, right: OverlayRecordListEntry | null) {
  if (!left || !right) return !left && !right;
  if (left.hasPrevious !== right.hasPrevious || left.hasNext !== right.hasNext ||
    left.pending !== right.pending || left.failed !== right.failed ||
    left.pageKey !== right.pageKey || left.items.length !== right.items.length) return false;
  for (let index = 0; index < left.items.length; index++) {
    const a = left.items[index]!, b = right.items[index]!;
    if (a.pathname !== b.pathname || a.search !== b.search || a.hash !== b.hash) return false;
  }
  return true;
}

function sameBackground(left: Path, right: Path) {
  const a = new URLSearchParams(left.search), b = new URLSearchParams(right.search);
  a.sort(); b.sort();
  return left.pathname === right.pathname && a.toString() === b.toString() && left.hash === right.hash;
}

export function OverlayProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const target = readOverlayTarget(location.search);
  const hasOverlay = new URLSearchParams(location.search).has(OVERLAY_PARAMETER);
  const positions = useRef(new Map<string, RootPosition>());
  // The first known foreground entry can be a direct/reloaded address with no root in history.
  const firstKnownDepth = useRef(new Map<string, number>());
  const background = useMemo(() => overlayBackground(location), [location.pathname, location.search, location.hash]);
  const history = readOverlayHistory(location.state);
  const lastOverlay = useRef<{ history: OverlayHistory | null; background: Path } | null>(null);
  if (hasOverlay) lastOverlay.current = { history, background };
  const lists = useRef(new Map<string, OverlayRecordListEntry>());
  const [listVersion, setListVersion] = useState(0);
  const activeListId = useRef<string | null>(null);
  const registerList = useCallback<OverlayRecordListRegistry["registerList"]>((id, entry) => {
    const previous = lists.current.get(id);
    if (entry) lists.current.set(id, entry);
    else lists.current.delete(id);
    if (!sameRecordListEntry(previous, entry)) setListVersion(version => version + 1);
  }, []);
  const findRecordList = useCallback((pathname: string) => {
    if (activeListId.current) {
      const preferred = lists.current.get(activeListId.current);
      return preferred && preferred.items.some(item => item.pathname === pathname)
        ? { id: activeListId.current, list: preferred }
        : null;
    }
    for (const [id, list] of lists.current) {
      if (list.items.some(item => item.pathname === pathname)) return { id, list };
    }
    return null;
  }, []);
  const getRecordList = useCallback((id: string) => lists.current.get(id) ?? null, []);
  const registry = useMemo<OverlayRecordListRegistry>(() => ({ registerList }), [registerList]);
  // A list keeps showing which record it opened last, so the place is not lost between records.
  const lastRecord = useRef<{ page: string; pathname: string } | null>(null);
  // Stepping between sibling rows moves the list mark only after navigation commits (e.g. after draft guards).
  const pendingStep = useRef<{ pathname: string; trigger: HTMLAnchorElement | null } | null>(null);
  // Related records visited inside the overlay do not take the mark from the row that was opened.
  const recordWasOpen = useRef(false);
  const committedStep = target && pendingStep.current?.pathname === target.pathname ? pendingStep.current : null;
  const nextRecord = !target
    ? (lastRecord.current?.page === location.pathname ? lastRecord.current : null)
    : committedStep || !recordWasOpen.current || !lastRecord.current
      ? { page: location.pathname, pathname: target.pathname }
      : lastRecord.current;
  const recordPath = nextRecord?.pathname ?? null;
  const recordOpen = !!target;
  useLayoutEffect(() => {
    lastRecord.current = nextRecord;
    recordWasOpen.current = !!target;
    if (!target) {
      pendingStep.current = null;
      activeListId.current = null;
      return;
    }
    if (!committedStep) return;
    pendingStep.current = null;
    const trigger = committedStep.trigger;
    if (history) {
      if (trigger?.isConnected) trigger.scrollIntoView?.({ block: "nearest" });
      const saved = positions.current.get(history.rootKey);
      positions.current.set(history.rootKey, saved
        ? { ...saved, trigger: trigger ?? null, triggerId: trigger?.id || null, background, stepped: true }
        : { trigger: trigger ?? null, triggerId: trigger?.id || null, y: history.scrollY, canReturn: false, background, stepped: true });
    }
  }, [location.pathname, location.search, target?.pathname, history?.rootKey]);
  const closeGuards = useRef(new Map<string, () => boolean>());
  const pendingTrigger = useRef<HTMLElement | null>(null);
  const registerCloseGuard = useCallback((id: string, check: (() => boolean) | null) => {
    if (check) closeGuards.current.set(id, check);
    else closeGuards.current.delete(id);
  }, []);
  const blocked = useCallback(() => [...closeGuards.current.values()].some(check => check()), []);

  const navigateTarget = useCallback((to: To, options: NavigateOptions = {}) => {
    const next = parseOverlayTarget(to);
    if (!next) { void navigate(to, options); return; }
    const previous = readOverlayHistory(location.state);
    const alreadyOpen = new URLSearchParams(location.search).has(OVERLAY_PARAMETER);
    const source = stateRecord(location.state);
    let history: OverlayHistory;
    if (alreadyOpen && previous) {
      if (!firstKnownDepth.current.has(previous.rootKey)) firstKnownDepth.current.set(previous.rootKey, previous.depth);
      history = { ...previous, depth: options.replace ? previous.depth : previous.depth + 1,
        detailState: options.state !== undefined ? options.state : previous.detailState };
    } else {
      const trigger = pendingTrigger.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      const position = { trigger, triggerId: trigger?.id || null, y: Math.max(0, window.scrollY), canReturn: !options.replace, background };
      const rootKey = alreadyOpen ? "direct:" + location.key : location.key;
      if (!alreadyOpen) {
        positions.current.set(rootKey, position);
        if (positions.current.size > 100) positions.current.delete(positions.current.keys().next().value!);
      }
      firstKnownDepth.current.set(rootKey, alreadyOpen || options.replace ? 1 : 0);
      history = { version: 1, rootKey, rootUrl: createPath(background), depth: alreadyOpen && !options.replace ? 2 : 1, rootState: source, scrollY: position.y,
        detailState: options.state ?? { listReturn: { to: createPath(background), state: source } } };
    }
    if (firstKnownDepth.current.size > 100) firstKnownDepth.current.delete(firstKnownDepth.current.keys().next().value!);
    pendingTrigger.current = null;
    void navigate(withOverlayTarget(background, next), { ...options, preventScrollReset: true, viewTransition: false,
      state: { ...source, [OVERLAY_HISTORY_KEY]: history } });
  }, [background, location, navigate]);

  const open = useCallback<OverlayNavigation["open"]>((to, options = {}) => {
    pendingStep.current = null;
    pendingTrigger.current = options.trigger ?? null;
    if (!hasOverlay || options.listId !== undefined) activeListId.current = options.listId ?? null;
    navigateTarget(to, { ...(options.replace !== undefined ? { replace: options.replace } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}) });
  }, [hasOverlay, navigateTarget]);

  const step = useCallback((to: Path, trigger: HTMLAnchorElement | null, listId?: string) => {
    if (blocked()) return false;
    if (listId !== undefined) activeListId.current = listId;
    pendingStep.current = { pathname: to.pathname, trigger };
    navigateTarget(to, { replace: true });
    return true;
  }, [blocked, navigateTarget]);

  const close = useCallback(() => {
    if (blocked()) return;
    const history = readOverlayHistory(location.state);
    const background = overlayBackground(location);
    const root = history ? new URL(history.rootUrl, "https://perpay.invalid") : null;
    const sameRoot = !!(root && sameBackground(background, root));
    if (history && positions.current.get(history.rootKey)?.canReturn && sameRoot) {
      void navigate(-history.depth);
    } else {
      const state = { ...stateRecord(sameRoot ? (history?.rootState ?? location.state) : location.state) };
      delete state[OVERLAY_HISTORY_KEY];
      void navigate(background, { replace: true, state, preventScrollReset: true, viewTransition: false });
    }
  }, [blocked, location, navigate]);
  const back = useCallback(() => {
    if (blocked()) return;
    const history = readOverlayHistory(location.state);
    const first = history ? firstKnownDepth.current.get(history.rootKey) : undefined;
    if (history && first !== undefined && history.depth > Math.max(1, first)) void navigate(-1);
    else close();
  }, [blocked, close, location.state, navigate]);
  const restoreFocus = useCallback(() => {
    const active = lastOverlay.current;
    const history = active?.history;
    const root = history ? new URL(history.rootUrl, "https://perpay.invalid") : active?.background;
    const stored = history ? positions.current.get(history.rootKey) : undefined;
    const saved = stored && sameBackground(background, stored.background)
      ? stored
      : root && sameBackground(background, root) && history
        ? { trigger: null, triggerId: null, y: history.scrollY, stepped: false }
        : null;
    const trigger = saved?.trigger?.isConnected
      ? saved.trigger
      : saved?.triggerId ? document.getElementById(saved.triggerId) : null;
    if (saved) {
      if (saved.stepped) {
        if (trigger) requestAnimationFrame(() => trigger.scrollIntoView?.({ block: "nearest" }));
      } else {
        requestAnimationFrame(() => window.scrollTo({ top: saved.y, left: 0, behavior: "instant" }));
      }
    }
    return trigger ?? document.getElementById("main-content");
  }, [background]);
  const virtualLocation: Location | null = target ? { ...target, state: readOverlayHistory(location.state)?.detailState ?? null,
    key: location.key, mask: undefined } : null;
  const first = history ? firstKnownDepth.current.get(history.rootKey) : undefined;
  const canGoBack = !!history && first !== undefined && history.depth > Math.max(1, first);
  const value = useMemo<InternalNavigation>(() => ({ open, close, back, background, target: virtualLocation, hasOverlay, canGoBack, listVersion, navigateTarget, step, findRecordList, getRecordList, blocked, registerCloseGuard, restoreFocus,
    record: recordPath === null ? null : { pathname: recordPath, open: recordOpen } }),
    [open, close, back, background, recordPath, recordOpen, target?.pathname, target?.search, target?.hash, location.key, location.state, hasOverlay, canGoBack, listVersion, navigateTarget, step, findRecordList, getRecordList, blocked, registerCloseGuard, restoreFocus]);
  return <OverlayNavigationContext value={value}><InternalOverlayContext value={value}><OverlayRecordListRegistryContext value={registry}>{children}</OverlayRecordListRegistryContext></InternalOverlayContext></OverlayNavigationContext>;
}

const views = {
  order: lazy(() => import("@/pages/OrderDetail").then(module => ({ default: module.OrderDetail }))),
  notification: lazy(() => import("@/pages/NotificationDetail")),
  ledger: lazy(() => import("@/pages/LedgerDetail")),
  evidence: lazy(() => import("@/pages/ReconciliationDetail")),
  audit: lazy(() => import("@/pages/AuditDetail")),
  "audit-status": lazy(() => import("@/pages/AuditStatus")),
  site: lazy(() => import("@/pages/Sites").then(module => ({ default: module.SiteEditorPage }))),
  "site-summary": lazy(() => import("@/pages/Sites").then(module => ({ default: module.SiteSummaryOverlay }))),
  "site-defaults": lazy(() => import("@/pages/Sites").then(module => ({ default: module.SiteDefaultsPage }))),
  account: lazy(() => import("@/pages/AlipayAccounts")),
  settings: lazy(() => import("@/pages/Settings").then(module => ({ default: module.SettingsEditorOverlay }))),
  password: lazy(() => import("@/pages/SecuritySettings").then(module => ({ default: module.PasswordEditorPage }))),
  "admin-access": lazy(() => import("@/pages/AdminAccessSettings").then(module => ({ default: module.AdminAccessEditorPage }))),
  session: lazy(() => import("@/components/administrator-sessions").then(module => ({ default: module.AdministratorSessionDetailOverlay }))),
  "test-payment": lazy(() => import("@/pages/TestPayment").then(module => ({ default: module.TestPaymentOverlay }))),
} satisfies Record<OverlayRouteKind, React.LazyExoticComponent<React.ComponentType>>;

const ReconciliationRecovery = lazy(() => import("@/pages/ReconciliationDetail").then(module => ({ default: module.ReconciliationRecovery })));

class OverlayFailure extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error("详情暂时无法显示") }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>详情加载失败</EmptyTitle>
          <EmptyDescription>重新加载会丢失未保存内容。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" onClick={() => window.location.reload()}>重新加载页面</Button>
        </EmptyContent>
      </Empty>
    );
  }
}

/** A scoped declarative route keeps existing params/search hooks without creating another Router. */
function OverlayRoutes({ location, children }: { location: Location; children?: ReactNode }) {
  const parentNavigation = useContext(UNSAFE_NavigationContext)!;
  const overlay = useContext(InternalOverlayContext)!;
  const navigator = useMemo<Navigator>(() => ({ ...parentNavigation.navigator,
    push: (to, state, options) => overlay.navigateTarget(to, { ...options, state }),
    replace: (to, state, options) => overlay.navigateTarget(to, { ...options, state, replace: true }),
    go: delta => parentNavigation.navigator.go(delta),
  }), [parentNavigation.navigator, overlay.navigateTarget]);
  return <UNSAFE_NavigationContext value={{ ...parentNavigation, navigator }}>
    <UNSAFE_RouteContext value={{ matches: [], outlet: null, isDataRoute: false }}>
      <Routes location={location}>{children ?? overlayRouteDefinitions.map(definition => {
        const View = views[definition.kind];
        return <Route key={definition.pattern} path={definition.pattern} element={<View />} />;
      })}</Routes>
    </UNSAFE_RouteContext>
  </UNSAFE_NavigationContext>;
}

/**
 * The line above a record's title: what kind of record this is and what it
 * belongs to. It keeps its place while the record loads, so the title below
 * does not move when the data arrives.
 */
function OverlayEyebrow({ type }: { type: string }) {
  const heading = usePageHeading();
  const repeated = !heading || (heading.title === type && !heading.eyebrow);
  return <p data-overlay-eyebrow-text aria-hidden={repeated || undefined} className={cn("min-w-0 truncate text-xs leading-5 font-medium text-muted-foreground", repeated && "invisible")}>
    {type}{heading?.eyebrow ? " · " + heading.eyebrow : ""}
  </p>;
}

/** Optional routes make the complete navigation contract testable without domain fixtures. */
export function OverlayHost({ routes }: { routes?: ReactNode }) {
  const session = useSession();
  const drafts = useDraftGuard();
  const overlay = useContext(InternalOverlayContext);
  const overlayActive = useRef(overlay?.hasOverlay ?? false);
  overlayActive.current = overlay?.hasOverlay ?? false;
  const backgroundLocation = useLocation();
  const last = useRef<Location | null>(null);
  if (overlay?.target) last.current = overlay.target;
  const target = overlay?.target ?? last.current;
  const definition = target ? overlayRoute(target.pathname) : null;
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [summaryTarget, setSummaryTarget] = useState<HTMLElement | null>(null);
  const [stepPortal, setStepPortal] = useState<HTMLElement | null>(null);
  const [steps, setSteps] = useState<Array<{ id: string; size: OverlaySize }>>([]);
  const pendingStepFocus = useRef<(() => HTMLElement | null) | null>(null);
  const title = useRef<HTMLDivElement>(null);
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const pendingPagerFocus = useRef<{ direction: "previous" | "next"; pathname: string } | null>(null);
  const [pendingPageStep, setPendingPageStep] = useState<PendingPageStep | null>(null);
  const nestedModals = useRef(new Set<string>());
  const registerNestedModal = useCallback((id: string, open: boolean) => {
    if (open) nestedModals.current.add(id);
    else nestedModals.current.delete(id);
  }, []);
  const registerStep = useCallback((id: string, open: boolean, size: OverlaySize = "md") => {
    const focused = document.activeElement;
    const shell = title.current?.closest<HTMLElement>("[data-overlay-content]");
    if (focused instanceof HTMLElement && shell?.contains(focused)) {
      const region = focused.closest<HTMLElement>("[data-overlay-primary], [data-overlay-step]");
      const leavingRegion = region && (open ? region.dataset.overlayStep !== id : region.dataset.overlayStep === id);
      // Keep focus on the visible shell while its current region is hidden or removed.
      if (leavingRegion) shell.focus({ preventScroll: true });
    }
    setSteps(previous => {
      const existing = previous.find(step => step.id === id);
      if (open) return existing ? existing.size === size ? previous : previous.map(step => step.id === id ? { id, size } : step) : [...previous, { id, size }];
      return existing ? previous.filter(step => step.id !== id) : previous;
    });
  }, []);
  const activeStep = steps.at(-1) ?? null;
  useToastFooterDock(actionsTarget, overlay?.hasOverlay ?? false);
  const restoreStepFocus = useCallback(() => {
    if (!overlayActive.current || !pendingStepFocus.current) { pendingStepFocus.current = null; return; }
    let target = pendingStepFocus.current();
    const shell = title.current?.closest("[data-overlay-content]");
    // Completed actions may disappear or still return the old full-page landmark.
    if (!target?.isConnected || (shell && !shell.contains(target)) || target.matches(":disabled")) target = title.current;
    if (!target?.isConnected) { pendingStepFocus.current = null; return; }
    // A conditional form unmounts before the host reveals its parent footer.
    if (target.closest("[hidden], [inert]")) return;
    pendingStepFocus.current = null;
    target.focus({ preventScroll: true });
  }, []);
  const requestStepFocus = useCallback((target: () => HTMLElement | null) => {
    pendingStepFocus.current = target;
    requestAnimationFrame(restoreStepFocus);
  }, [restoreStepFocus]);
  useLayoutEffect(() => {
    if (overlay?.hasOverlay) restoreStepFocus();
    else pendingStepFocus.current = null;
  }, [activeStep?.id, overlay?.hasOverlay, restoreStepFocus]);
  const stepContext = useMemo(() => ({ portal: stepPortal, activeId: activeStep?.id ?? null, register: registerStep, restoreFocus: requestStepFocus }), [stepPortal, activeStep?.id, registerStep, requestStepFocus]);
  const resourceScope = useMemo(() => workspaceScope(definition?.kind === "test-payment" ? backgroundLocation.pathname : target?.pathname ?? "/"), [definition?.kind, backgroundLocation.pathname, target?.pathname]);
  const priorTitle = useRef<string | null>(null);
  useEffect(() => {
    if (overlay?.hasOverlay) { priorTitle.current ??= document.title; return; }
    if (priorTitle.current !== null) { document.title = priorTitle.current; priorTitle.current = null; }
  }, [overlay?.hasOverlay]);
  // Records open as a drawer beside the list they came from and keep one width
  // through their steps. Editors stay centred and follow the step's size.
  const drawer = isRecordDetailRoute(definition);
  const pagerActive = !!(drawer && overlay?.hasOverlay && target && !overlay.canGoBack);
  const pager = useMemo(() => {
    if (!pagerActive || !overlay || !target) return null;
    if (pendingPageStep) {
      return { listId: pendingPageStep.listId, previous: null, next: null, busy: true };
    }
    const active = overlay.findRecordList(target.pathname);
    if (!active) return null;
    const { id, list } = active;
    const index = list.items.findIndex(item => item.pathname === target.pathname);
    if (index < 0) return null;
    const previous = index > 0
      ? { kind: "item" as const, to: list.items[index - 1]! }
      : list.hasPrevious && list.onPreviousPage
        ? { kind: "page" as const }
        : null;
    const next = index < list.items.length - 1
      ? { kind: "item" as const, to: list.items[index + 1]! }
      : list.hasNext && list.onNextPage
        ? { kind: "page" as const }
        : null;
    if (!previous && !next) return null;
    return { listId: id, previous, next, busy: !!list.pending };
  }, [pagerActive, overlay, target?.pathname, overlay?.listVersion, pendingPageStep]);
  // A different record is read from its top. One that is already in memory replaces the previous
  // content at full height in one commit, so the box that scrolls would keep the offset the last
  // record was left at. Which box that is depends on the drawer's height, so all three start over.
  useLayoutEffect(() => {
    if (!drawer) return;
    const shell = title.current?.closest("[data-overlay-content]");
    for (const box of shell?.querySelectorAll<HTMLElement>("[data-overlay-primary], [data-overlay-body], [data-overlay-detail]") ?? []) box.scrollTop = 0;
  }, [target?.pathname]);
  useLayoutEffect(() => {
    if (!pendingPageStep) return;
    if (!pagerActive || !overlay?.hasOverlay || target?.pathname !== pendingPageStep.fromPathname) {
      setPendingPageStep(null);
      drafts.revokeApprovedOwners(pendingPageStep.approvedOwners);
      return;
    }
    const abort = () => {
      setPendingPageStep(null);
      drafts.revokeApprovedOwners(pendingPageStep.approvedOwners);
      const shell = title.current?.closest("[data-overlay-content]");
      const active = document.activeElement;
      if (title.current && shell && (!(active instanceof HTMLElement) || !shell.contains(active) || active.matches(":disabled"))) {
        title.current.focus({ preventScroll: true });
      }
    };
    const list = overlay.getRecordList(pendingPageStep.listId);
    if (!list || list.failed) {
      abort();
      return;
    }
    if (list.pending) return;
    const currentIndex = list.items.findIndex(item => item.pathname === pendingPageStep.fromPathname);
    let nextTarget: Path | null = null;
    if (currentIndex >= 0) {
      // Infinite-append lists keep the current record and append more rows after it.
      const hasMore = pendingPageStep.direction === "next" ? !!list.hasNext : !!list.hasPrevious;
      if (pendingPageStep.direction === "next" && currentIndex < list.items.length - 1) {
        nextTarget = list.items[currentIndex + 1]!;
      } else if (pendingPageStep.direction === "previous" && currentIndex > 0) {
        nextTarget = list.items[currentIndex - 1]!;
      } else if ((list.pageKey ?? "") !== pendingPageStep.fromPageKey || !hasMore) {
        abort();
        return;
      } else {
        return;
      }
    } else if ((list.pageKey ?? "") !== pendingPageStep.fromPageKey) {
      // Cursor-paginated lists replace the page's rows.
      nextTarget = list.items.length > 0
        ? (pendingPageStep.direction === "next" ? list.items[0]! : list.items[list.items.length - 1]!)
        : null;
    } else {
      return;
    }
    if (!nextTarget) {
      abort();
      return;
    }
    setPendingPageStep(null);
    if (overlay.step(nextTarget, list.getElement(nextTarget.pathname), pendingPageStep.listId)) {
      pendingPagerFocus.current = { direction: pendingPageStep.direction, pathname: nextTarget.pathname };
    }
  }, [pendingPageStep, pagerActive, overlay, overlay?.hasOverlay, overlay?.listVersion, target?.pathname, drafts]);
  useLayoutEffect(() => {
    if (!overlay?.hasOverlay || activeStep || nestedModals.current.size) return;
    const pending = pendingPagerFocus.current;
    pendingPagerFocus.current = null;
    if (pending && pending.pathname === target?.pathname) {
      const targetButton = pending.direction === "previous"
        ? (pager?.previous && !pager.busy ? prevButton.current : null)
        : (pager?.next && !pager.busy ? nextButton.current : null);
      if (targetButton) { targetButton.focus({ preventScroll: true }); return; }
    }
    title.current?.focus({ preventScroll: true });
  }, [target?.pathname, overlay?.hasOverlay, pagerActive]);
  if (!overlay) return null;
  const presentation = target && definition ? { target, resourceScope, size: definition.size, requestClose: overlay.close } : null;
  const size = drawer ? definition!.size : activeStep?.size ?? definition?.size ?? "md";
  const stepNeighbor = (direction: "previous" | "next") => {
    if (!pager || pager.busy || !target || overlay.blocked()) return;
    const action = direction === "previous" ? pager.previous : pager.next;
    if (!action) return;
    const list = overlay.getRecordList(pager.listId);
    if (!list) return;
    if (action.kind === "item") {
      if (overlay.step(action.to, list.getElement(action.to.pathname), pager.listId)) {
        pendingPagerFocus.current = { direction, pathname: action.to.pathname };
      }
      return;
    }
    const turnPage = direction === "previous" ? list.onPreviousPage : list.onNextPage;
    if (!turnPage) return;
    const owners = [overlayOwner(target), "page:" + actualPageAddress(overlay.background)];
    drafts.requestLeaveOwners(owners, () => {
      if (overlay.blocked()) {
        drafts.revokeApprovedOwners(owners);
        return;
      }
      const latest = overlay.getRecordList(pager.listId);
      const go = direction === "previous" ? latest?.onPreviousPage : latest?.onNextPage;
      if (!latest || !go) {
        drafts.revokeApprovedOwners(owners);
        return;
      }
      setPendingPageStep({
        listId: pager.listId,
        direction,
        fromPageKey: latest.pageKey ?? "",
        fromPathname: target.pathname,
        approvedOwners: owners,
      });
      go();
    });
  };
  return <Dialog open={overlay.hasOverlay} onOpenChange={(open, event) => { if (!open) { event.cancel(); overlay.close(); } }}>
    <DialogContent kind="detail" size={size} data-overlay-content data-overlay-size={size}
      data-overlay-presentation={drawer ? "drawer" : undefined} backdropProps={drawer ? { className: "overlay-drawer-backdrop" } : undefined}
      data-overlay-record={drawer && !activeStep || undefined}
      role={activeStep ? "presentation" : "dialog"} aria-modal={activeStep ? false : true}
      initialFocus={() => nestedModals.current.size ? false : title.current} finalFocus={overlay.restoreFocus} showCloseButton={false}>
      <OverlayContext value={presentation}><OverlayCloseGuardContext value={overlay.registerCloseGuard}>
        <OverlayActionsContext value={actionsTarget}><OverlaySummaryContext value={summaryTarget}><OverlayStepsContext value={stepContext}><OverlayNestedModalContext value={registerNestedModal}>
          <PageHeadingProvider routeKey={target?.pathname ?? "invalid"}><InlinePageHeaderActions><PageHeaderActionsProvider presentation="inline">
            <div data-overlay-primary hidden={!!activeStep} inert={!!activeStep} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              <DialogHeader>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 sm:gap-2">
                  {drawer && <div data-overlay-eyebrow className="flex min-w-0 items-center gap-1">
                    {overlay.canGoBack && <Tooltip>
                      <TooltipTrigger render={<Button className="-ml-1.5" size="icon-sm" variant="ghost" aria-label="返回上一步" onClick={overlay.back} />}><ArrowLeft /></TooltipTrigger>
                      <TooltipContent>返回上一步</TooltipContent>
                    </Tooltip>}
                    <OverlayEyebrow type={definition!.title} />
                  </div>}
                  <DialogTitle className="min-w-0" render={<div ref={title} tabIndex={-1} data-overlay-heading />}><PageHeadingSlot title={definition?.title ?? "无法打开详情"} /></DialogTitle>
                  <div className="col-start-2 flex items-center justify-end gap-1">
                    {pagerActive && pager && <div data-overlay-record-pager aria-busy={pager.busy || undefined} className="flex items-center gap-0.5" role="group" aria-label="切换记录">
                      <Tooltip>
                        <TooltipTrigger render={<Button ref={prevButton} variant="ghost" size="icon" disabled={!pager.previous || pager.busy} aria-label="上一条" onClick={() => stepNeighbor("previous")} />}><ChevronUp /></TooltipTrigger>
                        <TooltipContent>上一条</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger render={<Button ref={nextButton} variant="ghost" size="icon" disabled={!pager.next || pager.busy} aria-label="下一条" onClick={() => stepNeighbor("next")} />}><ChevronDown /></TooltipTrigger>
                        <TooltipContent>下一条</TooltipContent>
                      </Tooltip>
                    </div>}
                    <PageHeaderActionsSlot className="max-w-full flex-wrap justify-end" />
                  </div>
                  <DialogClose className="col-start-3" render={<Button variant="ghost" size="icon" />}>
                    <XIcon />
                    <span className="sr-only">关闭对话框</span>
                  </DialogClose>
                </div>
                {!drawer && overlay.canGoBack && <Button className="w-fit" size="sm" variant="ghost" onClick={overlay.back}><ArrowLeft data-icon="inline-start" />返回上一步</Button>}
              </DialogHeader>
              {/* Laid out as if absent. A record's drawer that is too short for a fixed summary scrolls this box instead of the detail. */}
              <div data-overlay-body className="contents">
              <div ref={setSummaryTarget} data-overlay-summary className="shrink-0 empty:hidden" />
              <div data-overlay-detail className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {target && definition ? <RequestNoticeProvider key={target.pathname}>
                  <RequestNoticeBanner showRuntimeLink={false} />
                  <ErrorNotice scope="page" error={session.error} retry={session.retry} retainedData />
                  <ResourceWorkspaceProvider scope={resourceScope}>
                    <OverlayFailure><Suspense fallback={<Loading label="正在读取详情…" />}>
                      <OverlayRoutes location={target}>{routes}</OverlayRoutes>
                    </Suspense></OverlayFailure>
                  </ResourceWorkspaceProvider>
                </RequestNoticeProvider> : <ErrorNotice error={new Error("详情地址无效，请关闭后重新选择记录。 ")} />}
              </div>
              </div>
              <div ref={setActionsTarget} data-overlay-footer className="shrink-0 empty:hidden" />
            </div>
            <div ref={setStepPortal} data-overlay-step-host className="flex min-h-0 flex-1 flex-col empty:hidden" />
          </PageHeaderActionsProvider></InlinePageHeaderActions></PageHeadingProvider>
        </OverlayNestedModalContext></OverlayStepsContext></OverlaySummaryContext></OverlayActionsContext>
      </OverlayCloseGuardContext></OverlayContext>
    </DialogContent>
  </Dialog>;
}

export function LegacyOverlayRedirect() {
  const location = useLocation();
  const { kind } = useParams();
  const redirect = legacyOverlayLocation(location);
  if (redirect) return <Navigate replace to={redirect.to} state={redirect.state} />;
  if (kind !== undefined) return <Suspense fallback={<Loading />}><ReconciliationRecovery /></Suspense>;
  return <ErrorNotice error={new Error("详情地址无效，请返回列表重新选择。")} />;
}
