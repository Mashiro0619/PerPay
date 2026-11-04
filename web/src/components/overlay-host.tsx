import { Component, Suspense, createContext, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, UNSAFE_NavigationContext, UNSAFE_RouteContext, createPath, useLocation, useNavigate, type Location, type NavigateOptions, type Navigator, type Path, type To } from "react-router";
import { ArrowLeft, XIcon } from "lucide-react";
import { OverlayActionsContext, OverlayCloseGuardContext, OverlayContext, OverlayNavigationContext, OverlayNestedModalContext, OverlayStepsContext, type OverlayNavigation, type OverlaySize } from "@/lib/overlay-context";
import { OVERLAY_HISTORY_KEY, OVERLAY_PARAMETER, isRecordDetailRoute, legacyOverlayLocation, overlayBackground, overlayRoute, overlayRouteDefinitions, parseOverlayTarget, readOverlayHistory, readOverlayTarget, stateRecord, withOverlayTarget, type OverlayHistory, type OverlayRouteKind } from "@/lib/overlay-navigation";
import { workspaceScope } from "@/lib/workspace-scope";
import { ResourceWorkspaceProvider } from "@/workspace";
import { useSession } from "@/auth";
import { PageHeadingProvider, PageHeadingSlot } from "@/components/page-heading";
import { InlinePageHeaderActions, PageHeaderActionsProvider, PageHeaderActionsSlot } from "@/components/page-header-actions";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/admin-dialog";
import { ErrorNotice, Loading } from "@/components/request-state";
import { RequestNoticeProvider } from "@/lib/request-notices";
import { RequestNoticeBanner } from "@/components/request-notice-banner";
import { Button } from "@/components/ui/button";
import { useToastFooterDock } from "@/lib/toast-layout";

type RootPosition = { trigger: HTMLElement | null; triggerId: string | null; y: number; canReturn: boolean };
type InternalNavigation = OverlayNavigation & {
  readonly hasOverlay: boolean;
  readonly canGoBack: boolean;
  navigateTarget(to: To, options?: NavigateOptions): void;
  blocked(): boolean;
  registerCloseGuard(id: string, check: (() => boolean) | null): void;
  restoreFocus(): HTMLElement | null;
};
const InternalOverlayContext = createContext<InternalNavigation | null>(null);

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
      const position = { trigger, triggerId: trigger?.id || null, y: Math.max(0, window.scrollY), canReturn: !options.replace };
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
    pendingTrigger.current = options.trigger ?? null;
    navigateTarget(to, { ...(options.replace !== undefined ? { replace: options.replace } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}) });
  }, [navigateTarget]);

  const close = useCallback(() => {
    if (blocked()) return;
    const history = readOverlayHistory(location.state);
    const background = overlayBackground(location);
    const root = history ? new URL(history.rootUrl, "https://perpay.invalid") : null;
    if (history && positions.current.get(history.rootKey)?.canReturn && root && sameBackground(background, root)) {
      void navigate(-history.depth);
    } else {
      const state = { ...stateRecord(history?.rootState ?? location.state) };
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
    const saved = root && sameBackground(background, root) && history
      ? positions.current.get(history.rootKey) ?? { trigger: null, triggerId: null, y: history.scrollY }
      : null;
    if (saved) requestAnimationFrame(() => window.scrollTo({ top: saved.y, left: 0, behavior: "instant" }));
    return saved?.trigger?.isConnected ? saved.trigger : saved?.triggerId ? document.getElementById(saved.triggerId) ?? document.getElementById("main-content") : document.getElementById("main-content");
  }, [background]);
  const virtualLocation: Location | null = target ? { ...target, state: readOverlayHistory(location.state)?.detailState ?? null,
    key: location.key, mask: undefined } : null;
  const first = history ? firstKnownDepth.current.get(history.rootKey) : undefined;
  const canGoBack = !!history && first !== undefined && history.depth > Math.max(1, first);
  const value = useMemo<InternalNavigation>(() => ({ open, close, back, background, target: virtualLocation, hasOverlay, canGoBack, navigateTarget, blocked, registerCloseGuard, restoreFocus }),
    [open, close, back, background, target?.pathname, target?.search, target?.hash, location.key, location.state, hasOverlay, canGoBack, navigateTarget, blocked, registerCloseGuard, restoreFocus]);
  return <OverlayNavigationContext value={value}><InternalOverlayContext value={value}>{children}</InternalOverlayContext></OverlayNavigationContext>;
}

const views = {
  order: lazy(() => import("@/pages/OrderDetail").then(module => ({ default: module.OrderDetail }))),
  notification: lazy(() => import("@/pages/Notifications").then(module => ({ default: module.NotificationDetail }))),
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

class OverlayFailure extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error("详情暂时无法显示") }; }
  render() { return this.state.error ? <ErrorNotice error={this.state.error} /> : this.props.children; }
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

/** Optional routes make the complete navigation contract testable without domain fixtures. */
export function OverlayHost({ routes }: { routes?: ReactNode }) {
  const session = useSession();
  const overlay = useContext(InternalOverlayContext);
  const overlayActive = useRef(overlay?.hasOverlay ?? false);
  overlayActive.current = overlay?.hasOverlay ?? false;
  const backgroundLocation = useLocation();
  const last = useRef<Location | null>(null);
  if (overlay?.target) last.current = overlay.target;
  const target = overlay?.target ?? last.current;
  const definition = target ? overlayRoute(target.pathname) : null;
  const [actionsTarget, setActionsTarget] = useState<HTMLElement | null>(null);
  const [stepPortal, setStepPortal] = useState<HTMLElement | null>(null);
  const [steps, setSteps] = useState<Array<{ id: string; size: OverlaySize }>>([]);
  const pendingStepFocus = useRef<(() => HTMLElement | null) | null>(null);
  const title = useRef<HTMLDivElement>(null);
  const nestedModals = useRef(new Set<string>());
  const registerNestedModal = useCallback((id: string, open: boolean) => {
    if (open) nestedModals.current.add(id);
    else nestedModals.current.delete(id);
  }, []);
  const registerStep = useCallback((id: string, open: boolean, size: OverlaySize = "md") => {
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
  useLayoutEffect(() => { if (overlay?.hasOverlay && !activeStep && !nestedModals.current.size) title.current?.focus({ preventScroll: true }); }, [target?.pathname, overlay?.hasOverlay]);
  if (!overlay) return null;
  const presentation = target && definition ? { target, resourceScope, size: definition.size, requestClose: overlay.close } : null;
  return <Dialog open={overlay.hasOverlay} onOpenChange={(open, event) => { if (!open) { event.cancel(); overlay.close(); } }}>
    <DialogContent kind="detail" size={activeStep?.size ?? definition?.size ?? "md"} data-overlay-content data-overlay-size={activeStep?.size ?? definition?.size ?? "md"}
      data-overlay-record={isRecordDetailRoute(definition) && !activeStep || undefined}
      role={activeStep ? "presentation" : "dialog"} aria-modal={activeStep ? false : true}
      initialFocus={() => nestedModals.current.size ? false : title.current} finalFocus={overlay.restoreFocus} showCloseButton={false}>
      <OverlayContext value={presentation}><OverlayCloseGuardContext value={overlay.registerCloseGuard}>
        <OverlayActionsContext value={actionsTarget}><OverlayStepsContext value={stepContext}><OverlayNestedModalContext value={registerNestedModal}>
          <PageHeadingProvider routeKey={target?.pathname ?? "invalid"}><InlinePageHeaderActions><PageHeaderActionsProvider presentation="inline">
            <div data-overlay-primary hidden={!!activeStep} inert={!!activeStep} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              <DialogHeader>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 sm:gap-2">
                  <DialogTitle className="min-w-0" render={<div ref={title} tabIndex={-1} data-overlay-heading />}><PageHeadingSlot title={definition?.title ?? "无法打开详情"} /></DialogTitle>
                  <PageHeaderActionsSlot className="max-w-full flex-wrap justify-end" />
                  <DialogClose className="col-start-3" render={<Button variant="ghost" size="icon" />}>
                    <XIcon />
                    <span className="sr-only">关闭对话框</span>
                  </DialogClose>
                </div>
                {overlay.canGoBack && <Button className="w-fit" size="sm" variant="ghost" onClick={overlay.back}><ArrowLeft data-icon="inline-start" />返回上一步</Button>}
              </DialogHeader>
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
              <div ref={setActionsTarget} data-overlay-footer className="shrink-0 empty:hidden" />
            </div>
            <div ref={setStepPortal} data-overlay-step-host className="flex min-h-0 flex-1 flex-col empty:hidden" />
          </PageHeaderActionsProvider></InlinePageHeaderActions></PageHeadingProvider>
        </OverlayNestedModalContext></OverlayStepsContext></OverlayActionsContext>
      </OverlayCloseGuardContext></OverlayContext>
    </DialogContent>
  </Dialog>;
}

export function LegacyOverlayRedirect() {
  const location = useLocation();
  const redirect = legacyOverlayLocation(location);
  return redirect ? <Navigate replace to={redirect.to} state={redirect.state} /> : <ErrorNotice error={new Error("详情地址无效，请返回列表重新选择。")} />;
}
