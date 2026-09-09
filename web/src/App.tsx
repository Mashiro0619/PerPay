import { Component, useEffect, useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Bell, ClipboardList, LayoutDashboard, ListChecks, LogOut, ScanLine, Settings2, WalletCards, X } from "lucide-react";
import { createRoutesFromElements, Navigate, Outlet, Route, useLocation } from "react-router";

import { api, result } from "./api/client";
import { AuthBoundary, useSession } from "./auth";
import { Button, EmptyState, ErrorNotice, Loading, PageHeading } from "./components/ui";
import { RouteTransition } from "./components/RouteTransition";
import { SelectionIndicator } from "./components/SelectionIndicator";
import { DraftProvider, useDraftGuard } from "./drafts";
import { Link, NavLink, NavigationContext, useNavigate } from "./navigation";
import { ThemeControl } from "./theme";
import { OfficialUpdateNotice } from "./updates";
import { deferOnboarding, deferredInstance } from "./lib/onboarding";

const navigation = [
  { to: "/", label: "收款概览", icon: LayoutDashboard },
  { to: "/orders", label: "订单", icon: ClipboardList },
  { to: "/work-items", label: "待处理", icon: ListChecks },
  { to: "/reconciliation", label: "账本与对账", icon: WalletCards },
  { to: "/notifications", label: "业务通知", icon: Bell },
  { to: "/settings", label: "实例设置", icon: Settings2 },
  { to: "/system", label: "运行状态", icon: Activity },
];

function AppShell() {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const instance = deferredInstance(location.state);
    if (instance) {
      deferOnboarding(instance);
      const state = { ...location.state };
      delete state.deferOnboardingFor;
      void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state });
    }
  }, [location.key, location.state, location.pathname, location.search, location.hash, navigate]);
  const mobileNavigation = useRef<HTMLDialogElement>(null);
  const navigationTrigger = useRef<HTMLElement | null>(null);
  const { requestDiscard } = useDraftGuard();
  const logout = useMutation({ mutationFn: () => result(api.logoutAdministratorSession({ body: {} })), onSuccess: session.forget });
  function closeNavigation() {
    mobileNavigation.current?.close();
    navigationTrigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => { mobileNavigation.current?.close(); }, [location.key]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 851px)");
    const closeOnDesktop = () => { if (desktop.matches) mobileNavigation.current?.close(); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  const renderNavigation = () => <>
    <Link className="brand" to="/" onClick={closeNavigation}><span>PerPay</span><span className="brand-tag">控制台</span></Link>
    <nav className="main-nav" aria-label="主导航"><SelectionIndicator active={location.pathname} />{navigation.map((item, index) => <div key={item.to}>
      {index === 5 && <span className="nav-section">实例管理</span>}
      <NavLink to={item.to} end={item.to === "/"} className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`} onClick={closeNavigation}><item.icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span></NavLink>
    </div>)}</nav>
    <div className="sidebar-controls" role="group" aria-label="外观与账户操作"><ThemeControl /><Button className="sidebar-logout icon-button" variant="quiet" aria-label="退出登录" title="退出登录" pending={logout.isPending} onClick={() => {
        closeNavigation();
        requestDiscard(() => logout.mutate());
      }}>{!logout.isPending && <LogOut size={18} aria-hidden="true" />}</Button></div>
  </>;

  return <NavigationContext value={() => {
    navigationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mobileNavigation.current?.showModal();
  }}><div className="app-shell">
    <a className="skip-link" href="#main-content">跳转到主要内容</a>
    <aside className="sidebar">{renderNavigation()}</aside>
    <dialog className="mobile-navigation" ref={mobileNavigation} aria-label="导航菜单" onCancel={(event) => { event.preventDefault(); closeNavigation(); }} onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeNavigation();
    }}>
      <Button className="mobile-navigation-close icon-button" aria-label="关闭导航" onClick={closeNavigation}><X size={20} aria-hidden="true" /></Button>{renderNavigation()}
    </dialog>
    <div className="workspace">
    <main id="main-content" className="main-content" tabIndex={-1}>
      <ErrorNotice error={logout.error} />
      <ErrorNotice error={session.error} retry={session.retry} />
      <OfficialUpdateNotice hidden={location.pathname === "/system"} />
      <RouteTransition><Outlet /></RouteTransition>
    </main>
    </div>
  </div></NavigationContext>;
}

export function TestPaymentLink() {
  return <Link className="button button--primary" to="/test-payment"><ScanLine size={17} />测试收款<ArrowUpRight size={15} /></Link>;
}

export const appRoutes = createRoutesFromElements(<Route errorElement={<AppFailure />} hydrateFallbackElement={<Loading label="正在打开页面…" />} element={<AuthBoundary><DraftProvider><AppShell /></DraftProvider></AuthBoundary>}>
    <Route index lazy={async () => ({ Component: (await import("./pages/Dashboard")).default })} />
    <Route path="orders" lazy={async () => ({ Component: (await import("./pages/Orders")).default })} />
    <Route path="orders/:orderId" lazy={async () => ({ Component: (await import("./pages/Orders")).OrderDetail })} />
    <Route path="work-items" lazy={async () => ({ Component: (await import("./pages/WorkItems")).default })} />
    <Route path="reconciliation" lazy={async () => ({ Component: (await import("./pages/Reconciliation")).default })} />
    <Route path="reconciliation/:kind/:resourceId" lazy={async () => ({ Component: (await import("./pages/ReconciliationDetail")).default })} />
    <Route path="notifications" lazy={async () => ({ Component: (await import("./pages/Notifications")).default })} />
    <Route path="notifications/:deliveryId" lazy={async () => ({ Component: (await import("./pages/Notifications")).NotificationDetail })} />
    <Route path="settings/onboarding/:step?" lazy={async () => ({ Component: (await import("./pages/Onboarding")).default })} />
    <Route path="settings/:section?" lazy={async () => ({ Component: (await import("./pages/Settings")).default })} />
    <Route path="system" lazy={async () => ({ Component: (await import("./pages/System")).default })} />
    <Route path="test-payment" lazy={async () => ({ Component: (await import("./pages/TestPayment")).default })} />
    <Route path="login" element={<Navigate to="/" replace />} />
    <Route path="setup" element={<Navigate to="/settings" replace />} />
    <Route path="*" element={<><PageHeading title="找不到这个页面" /><EmptyState headingLevel={2} title="地址可能已变更"><Link to="/" className="button button--primary">返回收款概览</Link></EmptyState></>} />
  </Route>);

function AppFailure() {
  return <main className="auth-loading"><EmptyState title="页面未能正常加载" description="请重新加载页面；未提交的内容将不会保存。"><Button variant="primary" onClick={() => window.location.reload()}>重新加载页面</Button></EmptyState></main>;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (this.state.failed) return <AppFailure />;
    return this.props.children;
  }
}
