import { SystemStatusBoundary } from "@/features/system-status";
import {
  Component,
  useEffect,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useMutation } from "@tanstack/react-query";
import {
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  useLocation,
  useMatch,
} from "react-router";
import { api, result } from "@/api/client";
import { AuthBoundary, useSession } from "@/auth";
import { DraftProvider, useDraftGuard } from "@/drafts";
import { Link, NavigationContext, useNavigate } from "@/navigation";
import { OfficialUpdateNotice } from "@/updates";
import { deferOnboarding, deferredInstance } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { AppSidebar, navigation } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { TestPaymentProvider } from "@/components/test-payment-provider";
import TestPayment from "@/pages/TestPayment";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
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

function AppShell() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as CSSProperties
      }
    >
      <Workspace />
    </SidebarProvider>
  );
}
function Workspace() {
  const { setOpenMobile, toggleSidebar } = useSidebar();
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const { requestDiscard } = useDraftGuard();
  const logout = useMutation({
    mutationFn: () => result(api.logoutAdministratorSession({ body: {} })),
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
  const current = [...navigation]
    .reverse()
    .find((item) =>
      item.url === "/"
        ? location.pathname === "/"
        : location.pathname.startsWith(item.url),
    );
  const testPaymentPage = useMatch("/test-payment");
  const title = testPaymentPage
    ? "测试收款"
    : location.pathname.startsWith("/settings/onboarding")
      ? "配置向导"
      : (current?.title ?? "PerPay");
  const overview = location.pathname === "/";
  useEffect(() => {
    document.title = title + " · PerPay";
  }, [title]);
  return (
    <NavigationContext value={toggleSidebar}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:p-4"
      >
        跳转到主要内容
      </a>
      <AppSidebar
        variant="inset"
        pathname={location.pathname}
        username={session.username}
        logoutPending={logout.isPending}
        onLogout={() => requestDiscard(() => logout.mutate())}
      />
      <SidebarInset className="min-w-0">
        <SiteHeader title={title} overview={overview} />
        <div
          id="main-content"
          tabIndex={-1}
          className="@container/main flex min-w-0 flex-1 flex-col gap-2 outline-none"
        >
          <div
            className={cn(
              "flex min-w-0 flex-col gap-4 py-4 md:gap-6 md:py-6",
              !overview && "px-4 lg:px-6",
            )}
          >
            {(logout.error || session.error) && (
              <div
                className={cn(
                  "flex flex-col gap-4",
                  overview && "px-4 lg:px-6",
                )}
              >
                <ErrorNotice error={logout.error} />
                <ErrorNotice error={session.error} retry={session.retry} />
              </div>
            )}
            <OfficialUpdateNotice
              hidden={location.pathname === "/system"}
              className={overview ? "mx-4 w-auto lg:mx-6" : undefined}
            />
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </NavigationContext>
  );
}
export const appRoutes = createRoutesFromElements(
  <Route
    errorElement={<AppFailure />}
    hydrateFallbackElement={<Loading label="正在打开页面…" />}
    element={
      <AuthBoundary>
        <DraftProvider>
          <TestPaymentProvider>
            <SystemStatusBoundary><AppShell /></SystemStatusBoundary>
          </TestPaymentProvider>
        </DraftProvider>
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
      lazy={async () => ({
        Component: (await import("./pages/Orders")).OrderDetail,
      })}
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
      path="reconciliation/:kind/:resourceId"
      lazy={async () => ({
        Component: (await import("./pages/ReconciliationDetail")).default,
      })}
    />
    <Route
      path="notifications"
      lazy={async () => ({
        Component: (await import("./pages/Notifications")).default,
      })}
    />
    <Route
      path="notifications/:deliveryId"
      lazy={async () => ({
        Component: (await import("./pages/Notifications")).NotificationDetail,
      })}
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
    <Route
      path="system"
      lazy={async () => ({
        Component: (await import("./pages/System")).default,
      })}
    />
    <Route path="test-payment" element={<TestPayment />} />
    <Route path="login" element={<Navigate to="/" replace />} />
    <Route path="setup" element={<Navigate to="/settings" replace />} />
    <Route
      path="*"
      element={
        <Empty>
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={2}>
              找不到这个页面
            </EmptyTitle>
            <EmptyDescription>地址可能已变更。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link to="/" className={buttonVariants()}>
              返回收款概览
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
          <EmptyTitle role="heading" aria-level={2}>
            页面未能正常加载
          </EmptyTitle>
          <EmptyDescription>重新加载会丢失未保存内容。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => window.location.reload()}>重新加载页面</Button>
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
