import { useEffect, useState } from "react";
import { SiteOverviewList } from "@/components/site-overview-list";
import { SystemStatusBoundary } from "@/features/system-status";
import {
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { Link } from "@/navigation";
import { useOverview } from "@/features/overview/use-overview";
import { useWorkspace } from "@/workspace";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SystemStatus } from "@/api/client";
import {
  deferredInstance,
  isOnboardingDeferred,
  onboardingPath,
} from "@/lib/onboarding";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  DEFAULT_DASHBOARD_WORK_ITEMS_LAYOUT,
  normalizeDashboardSections,
  normalizeDashboardWorkItemsLayout,
  readCachedDashboardSections,
  readCachedDashboardWorkItemsLayout,
  writeCachedDashboardSections,
  writeCachedDashboardWorkItemsLayout,
} from "@/lib/dashboard-sections";
import { OverviewWorkItems } from "@/components/overview-work-items";
import { SectionCards } from "@/components/section-cards";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { RecentOrders } from "@/components/recent-orders";
import { ErrorNotice, QueryView, ReadPausedNotice } from "@/components/request-state";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
  CardDescription,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

function collectionReadinessReason(ledger: SystemStatus["ledger"]) {
  if (!ledger.enabled || ledger.state === "stopped")
    return "查账任务未运行";
  if (ledger.last_success_at === null)
    return "还没有成功查账，请检查支付宝账号";
  const age = ledger.last_success_age_milliseconds;
  const maximumAge = ledger.maximum_success_age_milliseconds;
  if (typeof age === "number" && typeof maximumAge === "number" && age > maximumAge)
    return "最近查账成功已超过有效时限";
  return "查账暂未就绪";
}

function OverviewRecordsLoading({ count }: { count: number }) {
  return <div role="status" data-overview-record-loading className="flex flex-col gap-3">
    <span className="sr-only">正在读取记录…</span>
    {Array.from({ length: count }, (_, index) => <div key={index} aria-hidden="true" className="flex min-w-0 flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-14" /></div>
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-1/2" />
    </div>)}
  </div>;
}

export default function Dashboard() {
  return (
    <SystemStatusBoundary>
      <DashboardContent />
    </SystemStatusBoundary>
  );
}
function DashboardContent() {
  const {
    clientId,
    range,
    analytics,
    settings,
    status,
    orders,
    work,
    workSummary,
    unavailable,
    checking,
    changeRange,
  } = useOverview();
  const { site } = useWorkspace();
  const mobile = useIsMobile();
  const [metricsAwaitingRefresh, setMetricsAwaitingRefresh] = useState(false);
  // Keep current KPIs unknown through the reconnect request. Retained snapshots
  // remain useful for the dated trend, but must not be relabelled as today.
  const metricsUnavailable = analytics.isError || analytics.isPaused ||
    (metricsAwaitingRefresh && analytics.isFetching);
  if (metricsAwaitingRefresh !== metricsUnavailable) {
    setMetricsAwaitingRefresh(metricsUnavailable);
  }
  const location = useLocation();
  const instanceId = status.data?.data.instance_id;
  if (
    !clientId && settings.data &&
    !settings.isError &&
    !settings.data.data.completion.complete &&
    instanceId &&
    deferredInstance(location.state) !== instanceId &&
    !isOnboardingDeferred(instanceId)
  )
    return <Navigate to={onboardingPath()} replace />;
  const state = status.data?.data;
  const blocked =
    state &&
    (state.status === "not_ready" ||
      !state.configured ||
      !state.database.ok ||
      !state.ledger.collection_ready ||
      !state.reconciliation.confirmation_ready);
  const reason = !state?.configured
    ? "收款配置未完成"
    : !state.database.ok
      ? "数据库暂不可用"
      : !state.ledger.collection_ready
        ? collectionReadinessReason(state.ledger)
        : !state.reconciliation.confirmation_ready
          ? "自动确认收款尚未就绪，请检查对账状态"
          : "服务尚未就绪";
  const data =
    analytics.isPlaceholderData
      ? undefined
      : analytics.data?.data;
  const workTotal = !checking && !unavailable
    ? clientId
      ? !workSummary.isError && !workSummary.isPlaceholderData
        ? workSummary.data?.data?.total
        : null
      : state?.work_items?.total
    : null;
  const workEmpty = workTotal === 0 && work.isSuccess && !work.isPlaceholderData &&
    !work.isPaused && work.data.data.length === 0;
  const firstOrder = orders.isSuccess && !orders.isPlaceholderData && orders.data.data.length === 0 &&
    data?.orders.created === 0 && data.confirmations.count === 0;
  const siteConfiguration = site?.data?.data.configuration;
  const collectionConfigured = settings.data?.data.completion.complete;
  const sitePaused = siteConfiguration?.accepting_orders === false;
  const siteNeedsAccount = !!siteConfiguration && !siteConfiguration.collection?.accounts.length;
  const firstOrderDescription = !collectionConfigured
    ? "先完成支付宝账号配置，再将收款账号分配给业务网站。"
    : !clientId
      ? "收款账号已配置，可以接入业务网站或创建测试订单。"
      : sitePaused
        ? "本站已暂停接单，请先在网站设置中允许新订单。"
        : siteNeedsAccount
          ? "本站尚未分配收款账号，请先选择支付宝账号。"
          : "本站已就绪，可以先发起一笔测试收款；正式接入时再配置 API 密钥与回调通知。";
  const serverSections = settings.data?.data.display?.dashboard_sections;
  const serverWorkItemsLayout = settings.data?.data.display?.dashboard_work_items_layout;
  useEffect(() => {
    if (serverSections) {
      writeCachedDashboardSections(normalizeDashboardSections(serverSections));
    }
  }, [serverSections]);
  useEffect(() => {
    if (serverWorkItemsLayout) {
      writeCachedDashboardWorkItemsLayout(normalizeDashboardWorkItemsLayout(serverWorkItemsLayout));
    }
  }, [serverWorkItemsLayout]);
  const visibleSections = serverSections
    ? normalizeDashboardSections(serverSections)
    : (readCachedDashboardSections() ?? DEFAULT_DASHBOARD_SECTIONS);
  const workItemsLayout = serverWorkItemsLayout
    ? normalizeDashboardWorkItemsLayout(serverWorkItemsLayout)
    : (readCachedDashboardWorkItemsLayout() ?? DEFAULT_DASHBOARD_WORK_ITEMS_LAYOUT);
  const showSummaryCards = visibleSections.summary_cards;
  const showTrend = visibleSections.trend;
  const showSites = !clientId && visibleSections.site_overview;
  const showWorkItems = visibleSections.work_items;
  const showRecentOrders = visibleSections.recent_orders;
  const hasVisibleSection = showSummaryCards || showTrend || showSites || showWorkItems || showRecentOrders;
  const hasAnalyticsNotice = analytics.isPaused || Boolean(analytics.error);
  const showTrendPanel = showTrend && (!firstOrder || hasAnalyticsNotice);
  const analyticsNotice = analytics.isPaused
    ? <ReadPausedNotice retainedData={data !== undefined} />
    : <ErrorNotice
        scope="page"
        error={analytics.error}
        retainedData={data !== undefined}
        retry={() => { void analytics.refetch(); }}
      />;
  const trend = showTrendPanel ? <div key="trend" className="overview-trend flex min-w-0 flex-col gap-6">
    {analyticsNotice}
    {!firstOrder && <ChartAreaInteractive
      scopeKey={clientId ?? "all"}
      analytics={data}
      chartType={settings.data?.data.display?.dashboard_chart_type ?? "AREA"}
      range={range}
      onRangeChange={changeRange}
      pending={!analytics.isPaused && (analytics.isPending || analytics.isPlaceholderData)}
    />}
  </div> : null;
  const sites = showSites ? <SiteOverviewList key="sites" range={range} /> : null;
  const records = (showWorkItems || showRecentOrders) ? <div
    key="records"
    className="overview-records"
    data-work-layout={workItemsLayout === "SIDE_BY_SIDE" ? "side-by-side" : "stacked"}
    data-work-empty={(showWorkItems && workEmpty) || undefined}
  >
    {showWorkItems && <Card size="sm" className="overview-record-panel overview-work-panel" role="region" aria-labelledby="overview-work-title">
      <CardHeader className="overview-records-header">
        <CardTitle id="overview-work-title" role="heading" aria-level={2} aria-label={clientId ? "本站待处理" : "全部待处理"} className="flex items-center gap-2">
          {clientId ? "本站待处理" : "全部待处理"}
          {!workEmpty && <Badge variant={workTotal != null && workTotal > 0 ? "warning" : "secondary"} aria-label={workTotal == null ? "待处理总数未知" : `共 ${workTotal} 条提醒待处理`}>
            {workTotal ?? "—"}
          </Badge>}
        </CardTitle>
        {workEmpty && <CardDescription>暂无待处理提醒</CardDescription>}
        <CardAction>
          <Link to="/work-items" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            查看全部<ArrowRight data-icon="inline-end" />
          </Link>
        </CardAction>
      </CardHeader>
      {!workEmpty && <CardContent className="overview-records-content">
        <QueryView query={work} loading={<OverviewRecordsLoading count={4} />}>
          {(page) => <OverviewWorkItems items={page.data} />}
        </QueryView>
      </CardContent>}
    </Card>}
    {showRecentOrders && <div className="overview-orders-container">
      <Card size="sm" className="overview-record-panel overview-orders-panel" role="region" aria-labelledby="overview-orders-title">
        <CardHeader className="overview-records-header">
          <CardTitle id="overview-orders-title" role="heading" aria-level={2}>最近订单</CardTitle>
          <CardAction>
            <Link to="/orders" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {clientId ? "本站订单" : "全部订单"}<ArrowRight data-icon="inline-end" />
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent className="overview-records-content">
          <QueryView query={orders} loading={<OverviewRecordsLoading count={5} />}>
            {(page) => <RecentOrders orders={page.data} />}
          </QueryView>
        </CardContent>
      </Card>
    </div>}
  </div> : null;
  const hero = (showTrendPanel || showSites) ? (
    <div key="hero" className="overview-hero">
      {trend}
      {sites}
    </div>
  ) : null;
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-4"
      data-overview-layout
    >
      <ErrorNotice
        scope="page"
        error={settings.error}
        retry={() => { void settings.refetch(); }}
      />
      {!checking && blocked && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{clientId ? "收款服务异常" : "已暂停接收新订单"}</AlertTitle>
          <AlertDescription>
            <p>{reason}</p>
            <Link
              to={
                settings.data && !settings.data.data.completion.complete
                  ? onboardingPath()
                  : "/system"
              }
            >
              {settings.data && !settings.data.data.completion.complete
                ? "继续配置"
                : "查看运行状态"}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {firstOrder && <Card>
        <CardHeader><CardTitle>开始第一笔收款</CardTitle><CardDescription>{firstOrderDescription}</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {!collectionConfigured
            ? <Link to={onboardingPath()} className={buttonVariants()}>继续配置收款</Link>
            : clientId && (sitePaused || siteNeedsAccount)
              ? <Link to={"/sites/" + encodeURIComponent(clientId) + "/settings/" + (sitePaused ? "basic" : "collection")} className={buttonVariants()}>{sitePaused ? "设置接单状态" : "分配收款账号"}</Link>
              : <><Link to="/test-payment" className={buttonVariants()}>测试收款</Link><Link to={clientId ? "/sites/" + encodeURIComponent(clientId) + "/settings/integration" : "/sites"} className={buttonVariants({ variant: "outline" })}>接入业务网站</Link></>}
        </CardContent>
      </Card>}
      {showSummaryCards && !showTrend && analyticsNotice}
      {showSummaryCards && <SectionCards
        analytics={metricsUnavailable ? undefined : data}
        clientId={clientId}
        range={range}
        workItems={workTotal}
        workBreakdown={!checking && !unavailable && !clientId ? state?.work_items : undefined}
        pending={!analytics.isPaused && (analytics.isPending || analytics.isPlaceholderData)}
      />}
      {clientId && (showSummaryCards || showWorkItems) && <ErrorNotice scope="page" error={workSummary.error} retry={() => { void workSummary.refetch(); }} />}
      {mobile ? [records, hero] : [hero, records]}
      {!hasVisibleSection && (
        <Card size="sm" data-overview-empty-sections>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>当前视角没有已开启的总览模块</CardTitle>
            <CardDescription>
              你目前仅开启了“各网站概览”，该模块仅在全部网站总览中展示。可以在界面显示设置中开启更多模块。
            </CardDescription>
            <CardAction>
              <Link to="/settings/display" className={buttonVariants({ variant: "outline", size: "sm" })}>
                界面显示设置
              </Link>
            </CardAction>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
