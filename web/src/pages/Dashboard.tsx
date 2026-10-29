import { LedgerFreshness } from "@/components/ledger-freshness";
import { SiteOverviewList } from "@/components/site-overview-list";
import { SystemStatusBoundary } from "@/features/system-status";
import {
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { Link } from "@/navigation";
import { useOverview } from "@/features/overview/use-overview";
import type { SystemStatus } from "@/api/client";
import {
  deferredInstance,
  isOnboardingDeferred,
  onboardingPath,
} from "@/lib/onboarding";
import { OverviewWorkItems } from "@/components/overview-work-items";
import { SectionCards } from "@/components/section-cards";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { RecentOrders } from "@/components/recent-orders";
import { ErrorNotice, QueryView, ReadPausedNotice } from "@/components/request-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

function collectionReadinessReason(ledger: SystemStatus["ledger"]) {
  if (!ledger.enabled || ledger.state === "stopped")
    return "查账任务未运行，请查看运行状态";
  if (ledger.last_success_at === null)
    return "还没有成功查账，请检查支付宝账号";
  const age = ledger.last_success_age_milliseconds;
  const maximumAge = ledger.maximum_success_age_milliseconds;
  if (typeof age === "number" && typeof maximumAge === "number" && age > maximumAge)
    return "最近查账成功已超过有效时限，请查看运行状态";
  return "查账暂未就绪，请查看运行状态";
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
  const needsStatus = checking || blocked || settings.error;
  const workTotal = !checking && !unavailable
    ? clientId
      ? !workSummary.isError && !workSummary.isPlaceholderData
        ? workSummary.data?.data?.total
        : null
      : state?.work_items?.total
    : null;
  return (
    <div
      className="flex w-full min-w-0 flex-col gap-6"
      data-overview-layout
    >
      {needsStatus && (
        <div className="flex flex-col gap-4">
          <ErrorNotice
            error={settings.error}
            retry={() => {
              void settings.refetch();
            }}
          />
          {checking ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>
                {unavailable ? "暂时无法读取收款服务状态" : "正在检查收款服务状态…"}
              </AlertTitle>
              <AlertDescription>
                <div className="flex items-center gap-2">
                  {(status.isError || status.isPaused) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void status.refetch();
                      }}
                    >
                      重试
                    </Button>
                  )}
                  <Link to="/system">
                    运行状态
                  </Link>
                </div>
              </AlertDescription>
            </Alert>
          ) : blocked ? (
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
          ) : null}
        </div>
      )}
      <LedgerFreshness value={!checking && !unavailable ? state?.ledger.last_success_at : undefined} />
      <SectionCards
        analytics={data}
        clientId={clientId}
        workItems={workTotal}
        pending={!analytics.isPaused && (analytics.isPending || analytics.isPlaceholderData)}
      />
      {clientId && <ErrorNotice error={workSummary.error} retry={() => { void workSummary.refetch(); }} />}
      <div className="flex min-w-0 flex-col gap-6">
        {analytics.isPaused ? <ReadPausedNotice retainedData={data !== undefined} /> : <ErrorNotice
          error={analytics.error}
          retainedData={data !== undefined}
          retry={() => {
            void analytics.refetch();
          }}
        />}
        <ChartAreaInteractive
          scopeKey={clientId ?? "all"}
          analytics={data}
          chartType={
            settings.data?.data.display?.dashboard_chart_type ?? "AREA"
          }
          range={range}
          onRangeChange={changeRange}
          pending={!analytics.isPaused && (analytics.isPending || analytics.isPlaceholderData)}
        />
      </div>
      {!clientId && <SiteOverviewList range={range} />}
      <div className="overview-records">
        <Card size="sm" className="overview-record-panel overview-work-panel" role="region" aria-labelledby="overview-work-title">
          <CardHeader className="overview-records-header">
            <CardTitle id="overview-work-title" role="heading" aria-level={2} aria-label={clientId ? "本站待处理" : "全部待处理"} className="flex items-center gap-2">
              {clientId ? "本站待处理" : "全部待处理"}
              <Badge variant={workTotal != null && workTotal > 0 ? "warning" : "secondary"} aria-label={workTotal == null ? "待处理总数未知" : `共 ${workTotal} 条提醒待处理`}>
                {workTotal ?? "—"}
              </Badge>
            </CardTitle>
            <CardAction>
              <Link
                to={"/work-items"}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                查看全部
                <ArrowRight data-icon="inline-end" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="overview-records-content">
            <QueryView query={work} loading={<OverviewRecordsLoading count={4} />}>
              {(page) => <OverviewWorkItems items={page.data} />}
            </QueryView>
          </CardContent>
        </Card>
        <div className="overview-orders-container">
          <Card size="sm" className="overview-record-panel overview-orders-panel" role="region" aria-labelledby="overview-orders-title">
            <CardHeader className="overview-records-header">
              <CardTitle id="overview-orders-title" role="heading" aria-level={2}>
                最近订单
              </CardTitle>
              <CardAction>
                <Link
                  to={"/orders"}
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  {clientId ? "本站订单" : "全部订单"}
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent className="overview-records-content">
              <QueryView query={orders} loading={<OverviewRecordsLoading count={5} />}>
                {(page) => <RecentOrders orders={page.data} />}
              </QueryView>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
