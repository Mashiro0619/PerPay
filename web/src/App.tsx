import { WorkspaceProvider, WorkspaceNavigationProvider, WorkspaceOutlet, useWorkspace, adminRoutePathname, useWorkspaceNavigation } from "@/workspace";
import { workspaceScope } from "@/lib/workspace-scope";
import { isReadableDetailPage } from "@/lib/detail-layout";
import { prepareWorkspaceNavigation } from "@/lib/workspace-navigation";
import { OVERLAY_PARAMETER, readOverlayTarget } from "@/lib/overlay-navigation";
import { AdminContent, ContentWidthProvider } from "@/components/content-width";
import { PageHeaderActionsProvider } from "@/components/page-header-actions";
import { ListDensityProvider } from "@/components/list-density";
import { PageHeading, PageHeadingProvider, PageHeadingSlot } from "@/components/page-heading";
import { useSystemName } from "@/branding";
import { SystemStatusBoundary, useSystemStatus } from "@/features/system-status";
import {
  Component,
  useEffect,
  type ReactNode,
  type CSSProperties,
} from "react";
import { onlineManager, useMutation } from "@tanstack/react-query";
import {
  createRoutesFromElements,
  Navigate,
  Route,
  useLocation,
  useMatch,
} from "react-router";
import { api, result } from "@/api/client";
import { AuthBoundary, useSession } from "@/auth";
import { DraftProvider, useDraftGuard } from "@/drafts";
import { Link, NavigationContext, useNavigate } from "@/navigation";
import { OfficialUpdateDialog, OfficialUpdateProvider, useOfficialUpdateAvailable } from "@/updates";
import { deferOnboarding, deferredInstance } from "@/lib/onboarding";
import { AppSidebar } from "@/components/app-sidebar";
import { isGlobalNavigationPage, navigationSection, type NavigationSection } from "@/lib/navigation-selection";
import { SiteHeader } from "@/components/site-header";
import { TestPaymentProvider } from "@/components/test-payment-provider";
import { LegacyOverlayRedirect, OverlayHost, OverlayProvider } from "@/components/overlay-host";
import { ErrorNotice, Loading } from "@/components/request-state";
import { RequestNoticeProvider } from "@/lib/request-notices";
import { RequestNoticeBanner } from "@/components/request-notice-banner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toast";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from "@/components/ui/sidebar";

const globalPageTitles: Record<NavigationSection, string> = {
  overview: "总览",
  orders: "全部订单",
  "work-items": "全部待处理",
  notifications: "全部通知",
  settings: "系统设置",
  reconciliation: "对账",
  ledger: "支付宝流水",
  system: "运行状态",
  audit: "审计日志",
  sites: "业务网站",
};

function AppShell() {
  const location = useLocation();
  const { switching } = useWorkspaceNavigation();
  const backgroundInactive = !switching && new URLSearchParams(location.search).has(OVERLAY_PARAMETER);
  return (
    <RequestNoticeProvider>
    <Toaster timeout={4000}>
    <SidebarProvider
      data-admin-console
      data-overlay-background={backgroundInactive ? "inactive" : undefined}
      inert={backgroundInactive}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as CSSProperties
      }
    >
      <ContentWidthProvider>
        <ListDensityProvider>
        <PageHeaderActionsProvider>
          <Workspace />
        </PageHeaderActionsProvider>
        </ListDensityProvider>
      </ContentWidthProvider>
    </SidebarProvider>
    </Toaster>
    </RequestNoticeProvider>
  );
}
function Workspace() {
  const systemName = useSystemName();
  const updateAvailable = useOfficialUpdateAvailable();
  const scope = useWorkspace();
  const { switching } = useWorkspaceNavigation();
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const session = useSession();
  const health = useSystemStatus();
  const location = useLocation();
  const localPath = scope.clientId
    ? location.pathname.slice(scope.base.length) || "/"
    : location.pathname;
  const navigate = useNavigate();
  const { requestDiscard } = useDraftGuard();
  const logout = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: () => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，退出登录未提交。恢复连接后请重新退出。");
      return result(api.logoutAdministratorSession({ body: {} }));
    },
    onSuccess: session.forget,
  });
  useEffect(() => {
    const instance = deferredInstance(location.state);
    if (instance) {
      deferOnboarding(instance);
      const state = { ...location.state };
      delete state.deferOnboardingFor;
      void navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
        { replace: true, state },
      );
    }
  }, [
    location.key,
    location.state,
    location.pathname,
    location.search,
    location.hash,
    navigate,
  ]);
  useEffect(() => {
    setOpenMobile(false);
  }, [location.key, setOpenMobile]);
  const section = navigationSection(location.pathname);
  const globalPage = isGlobalNavigationPage(location.pathname);
  const testPaymentPage = useMatch("/test-payment");
  const title = testPaymentPage
    ? "测试收款"
    : location.pathname.startsWith("/settings/onboarding")
      ? "配置向导"
      : scope.clientId
        ? ({
            "/": "网站概览",
            "/orders": "本站订单",
            "/notifications": "本站通知",
            "/work-items": "本站待处理",
            "/settings": "网站设置",
            "/reconciliation": "本站对账",
          }["/" + (localPath.split("/")[1] ?? "")] ?? "网站后台")
        : (section ? globalPageTitles[section] : systemName);
  const overview = localPath === "/";
  useEffect(() => {
    document.title = [
      title,
      scope.clientId
        ? (scope.site?.data?.data.configuration.name ?? scope.clientId)
        : globalPage ? "全局" : "全部网站",
      systemName,
    ].join(" · ");
  }, [
    title,
    systemName,
    scope.clientId,
    scope.site?.data?.data.configuration.name,
    globalPage,
  ]);
  return (
    <NavigationContext value={toggleSidebar}>
      <OfficialUpdateDialog />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:p-4"
      >
        跳转到主要内容
      </a>
      <AppSidebar
        variant="inset"
        pathname={location.pathname}
        updateAvailable={updateAvailable}
        username={session.username}
        logoutPending={logout.isPending}
        onLogout={() => requestDiscard(() => logout.mutate())}
      />
      <SidebarInset className="min-w-0" aria-busy={switching}>
        <SiteHeader title={title} overview={overview} busy={switching} />
        <PageHeadingProvider routeKey={location.pathname}>
        <AdminContent busy={switching} layout={isReadableDetailPage(location.pathname) ? "detail" : "default"}>
          <PageHeadingSlot title={title} />
          <RequestNoticeBanner />
          <ErrorNotice error={logout.error} />
          <ErrorNotice scope="page" error={session.error} retry={session.retry} />
          <ErrorNotice scope="page" error={health.status.error} retry={() => { void health.status.refetch(); }} />
          <WorkspaceOutlet />
          <OverlayHost />
        </AdminContent>
        </PageHeadingProvider>
      </SidebarInset>
    </NavigationContext>
  );
}
export const appRoutes = createRoutesFromElements(
  <Route
    errorElement={<AppFailure />}
    loader={async ({ request }) => {
      const pathname = adminRoutePathname(new URL(request.url).pathname);
      const scope = workspaceScope(pathname);
      const localPath = scope.clientId ? pathname.slice(scope.base.length) || "/" : pathname;
      const target = readOverlayTarget(new URL(request.url).search);
      const reads = [prepareWorkspaceNavigation(request, scope.clientId, localPath)];
      if (target) {
        const resource = workspaceScope(target.pathname);
        if (resource.clientId && resource.clientId !== scope.clientId) {
          const url = new URL(request.url);
          url.pathname = target.pathname; url.search = target.search; url.hash = target.hash;
          reads.push(prepareWorkspaceNavigation(new Request(url, { signal: request.signal }), resource.clientId, target.pathname.slice(resource.base.length) || "/"));
        }
      }
      await Promise.all(reads);
      return null;
    }}
    shouldRevalidate={({ currentParams, nextParams, currentUrl, nextUrl }) => currentParams.clientId !== nextParams.clientId ||
      workspaceScope(readOverlayTarget(currentUrl.search)?.pathname ?? "/").clientId !== workspaceScope(readOverlayTarget(nextUrl.search)?.pathname ?? "/").clientId}
    hydrateFallbackElement={<main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 p-6"><PageHeading title="正在打开页面" /><Loading label="正在打开页面…" /></main>}
    element={
      <AuthBoundary>
        <OfficialUpdateProvider>
        <DraftProvider>
          <WorkspaceProvider>
            <WorkspaceNavigationProvider>
            <OverlayProvider>
            <TestPaymentProvider>
              <SystemStatusBoundary>
                <AppShell />
              </SystemStatusBoundary>
            </TestPaymentProvider>
            </OverlayProvider>
            </WorkspaceNavigationProvider>
          </WorkspaceProvider>
        </DraftProvider>
        </OfficialUpdateProvider>
      </AuthBoundary>
    }
  >
    <Route
      index
      lazy={async () => ({
        Component: (await import("./pages/Dashboard")).default,
      })}
    />
    <Route
      path="orders"
      lazy={async () => ({
        Component: (await import("./pages/Orders")).default,
      })}
    />
    <Route
      path="orders/:orderId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="work-items"
      lazy={async () => ({
        Component: (await import("./pages/WorkItems")).default,
      })}
    />
    <Route
      path="reconciliation"
      lazy={async () => ({
        Component: (await import("./pages/Reconciliation")).default,
      })}
    />
    <Route
      path="reconciliation/transactions/:ledgerEntryId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="reconciliation/:kind/:resourceId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="notifications"
      lazy={async () => ({
        Component: (await import("./pages/Notifications")).default,
      })}
    />
    <Route
      path="ledger"
      lazy={async () => ({
        Component: (await import("./pages/ReconciliationRedirect")).LedgerListRedirect,
      })}
    />
    <Route
      path="ledger/:ledgerEntryId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="notifications/:deliveryId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="sites"
      lazy={async () => ({
        Component: (await import("./pages/Sites")).default,
      })}
    />
    <Route
      path="sites/new"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="sites/defaults"
      element={<LegacyOverlayRedirect />}
    />
    <Route path="sites/:clientId">
      <Route
        index
        lazy={async () => ({
          Component: (await import("./pages/Dashboard")).default,
        })}
      />
      <Route
        path="orders"
        lazy={async () => ({
          Component: (await import("./pages/Orders")).default,
        })}
      />
      <Route
        path="orders/:orderId"
        element={<LegacyOverlayRedirect />}
      />
      <Route
        path="notifications"
        lazy={async () => ({
          Component: (await import("./pages/Notifications")).default,
        })}
      />
      <Route
        path="notifications/:deliveryId"
        element={<LegacyOverlayRedirect />}
      />
      <Route
        path="work-items"
        lazy={async () => ({
          Component: (await import("./pages/WorkItems")).default,
        })}
      />
      <Route
        path="reconciliation/:kind/:resourceId"
        element={<LegacyOverlayRedirect />}
      />
      <Route
        path="settings/:section?"
        lazy={async () => ({ Component: (await import("./pages/Sites")).SiteSettingsPage })}
      />
      <Route path="edit" element={<LegacyOverlayRedirect />} />
      <Route path="summary" element={<LegacyOverlayRedirect />} />
    </Route>
    <Route
      path="settings/accounts/:accountId"
      element={<LegacyOverlayRedirect />}
    />
    <Route
      path="settings/onboarding/:step?"
      lazy={async () => ({
        Component: (await import("./pages/Onboarding")).default,
      })}
    />
    <Route
      path="settings/:section?"
      lazy={async () => ({
        Component: (await import("./pages/Settings")).default,
      })}
    />
    <Route path="settings/:section/edit" element={<LegacyOverlayRedirect />} />
    <Route path="settings/security/password" element={<LegacyOverlayRedirect />} />
    <Route path="settings/security/access" element={<LegacyOverlayRedirect />} />
    <Route path="settings/security/sessions/:sessionId" element={<LegacyOverlayRedirect />} />
    <Route
      path="audit"
      lazy={async () => ({
        Component: (await import("./pages/Audit")).default,
      })}
    />
    <Route
      path="audit/:source/:eventId"
      element={<LegacyOverlayRedirect />}
    />
    <Route path="audit/status" element={<LegacyOverlayRedirect />} />
    <Route
      path="system"
      lazy={async () => ({
        Component: (await import("./pages/System")).default,
      })}
    />
    <Route path="test-payment" element={<LegacyOverlayRedirect />} />
    <Route path="login" element={<Navigate to="/" replace />} />
    <Route path="setup" element={<Navigate to="/settings" replace />} />
    <Route
      path="*"
      element={
        <Empty>
          <PageHeading title="找不到这个页面" />
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={2}>
              找不到这个页面
            </EmptyTitle>
            <EmptyDescription>地址可能已变更。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to="/" className={buttonVariants()}>
              返回总览
            </Link>
          </EmptyContent>
        </Empty>
      }
    />
  </Route>,
);

function AppFailure() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle role="heading" aria-level={1}>
            页面加载失败
          </EmptyTitle>
          <EmptyDescription>重新加载会丢失未保存内容。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <AppFailure /> : this.props.children;
  }
}
