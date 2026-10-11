import { SiteOverviewList } from "@/components/site-overview-list";
import { SystemStatusBoundary } from "@/features/system-status";
import {
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { Link } from "@/navigation";
import { useOverview } from "@/features/overview/use-overview";
import {
  deferredInstance,
  isOnboardingDeferred,
  onboardingPath,
} from "@/lib/onboarding";
import { OverviewWorkItems } from "@/components/overview-work-items";
import { SectionCards } from "@/components/section-cards";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { RecentOrders } from "@/components/recent-orders";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
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
    ? "收款配置尚未完成"
    : !state.database.ok
      ? "数据库暂不可用"
      : !state.ledger.collection_ready
        ? "账本采集尚未就绪，请检查支付宝接入"
        : !state.reconciliation.confirmation_ready
          ? "自动确认尚未就绪，请检查对账状态"
          : "服务尚未就绪";
  const data =
    analytics.isPlaceholderData || analytics.isError
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
      className="flex w-full min-w-0 flex-col gap-4"
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
                {unavailable ? "暂时无法确认收款状态" : "正在检查收款状态…"}
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
              <AlertTitle>{clientId ? "实例共享收款引擎异常" : "当前暂停新收款"}</AlertTitle>
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
      <SectionCards
        analytics={data}
        clientId={clientId}
        workItems={workTotal}
        pending={analytics.isPending || analytics.isPlaceholderData}
      />
      {clientId && <ErrorNotice error={workSummary.error} retry={() => { void workSummary.refetch(); }} />}
      <div className="flex min-w-0 flex-col gap-4">
        <ErrorNotice
          error={analytics.error}
          retry={() => {
            void analytics.refetch();
          }}
        />
        <ChartAreaInteractive
          analytics={data}
          chartType={
            settings.data?.data.display?.dashboard_chart_type ?? "AREA"
          }
          range={range}
          onRangeChange={changeRange}
          pending={analytics.isPending || analytics.isPlaceholderData}
        />
      </div>
      {!clientId && <SiteOverviewList range={range} />}
      <div className="overview-records">
        <Card size="sm" className="overview-record-panel" role="region" aria-labelledby="overview-work-title">
          <CardHeader className="overview-records-header">
            <CardTitle id="overview-work-title" role="heading" aria-level={2} aria-label={clientId ? "本站待办" : "全局待办"} className="flex items-center gap-2">
              {clientId ? "本站待办" : "全局待办"}
              <Badge variant={workTotal != null && workTotal > 0 ? "warning" : "secondary"} aria-label={workTotal == null ? "待办总数未知" : `共 ${workTotal} 项待办`}>
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
            <QueryView query={work}>
              {(page) => <OverviewWorkItems items={page.data} />}
            </QueryView>
          </CardContent>
        </Card>
        <Card size="sm" className="overview-record-panel" role="region" aria-labelledby="overview-orders-title">
          <CardHeader className="overview-records-header">
            <CardTitle id="overview-orders-title" role="heading" aria-level={2}>
              最近订单
            </CardTitle>
            <CardDescription>最新 5 笔订单的收款与通知进展</CardDescription>
            <CardAction>
              <Link
                to={"/orders"}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                全部订单
                <ArrowRight data-icon="inline-end" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="overview-records-content">
            <QueryView query={orders}>
              {(page) => <RecentOrders orders={page.data} />}
            </QueryView>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
