import {
  AlertCircle,
  ArrowRight,
  ChevronRight,
  ListChecks,
} from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { Link } from "@/navigation";
import { useOverview } from "@/features/overview/use-overview";
import {
  deferredInstance,
  isOnboardingDeferred,
  onboardingPath,
} from "@/lib/onboarding";
import { dateTime } from "@/lib/format";
import { workItemHref, workItemTitle } from "@/lib/labels";
import { SectionCards } from "@/components/section-cards";
import { ChartAreaInteractive } from "@/components/chart-area-interactive";
import { DataTable } from "@/components/data-table";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemSeparator,
} from "@/components/ui/item";
import { Fragment } from "react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export default function Dashboard() {
  const {
    range,
    analytics,
    settings,
    status,
    orders,
    work,
    unavailable,
    checking,
    changeRange,
  } = useOverview();
  const location = useLocation();
  const instanceId = status.data?.data.instance_id;
  if (
    settings.data &&
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
  const data = analytics.isPlaceholderData ? undefined : analytics.data?.data;
  const needsStatus =
    checking || blocked || state?.status === "degraded" || settings.error;
  return (
    <>
      {needsStatus && (
        <div className="flex flex-col gap-4 px-4 lg:px-6">
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
                  <Link to="/system" className="underline underline-offset-4">
                    运行状态
                  </Link>
                </div>
              </AlertDescription>
            </Alert>
          ) : blocked ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>当前暂停新收款</AlertTitle>
              <AlertDescription>
                <p>{reason}</p>
                <Link
                  to={
                    settings.data && !settings.data.data.completion.complete
                      ? onboardingPath()
                      : "/system"
                  }
                  className="underline underline-offset-4"
                >
                  {settings.data && !settings.data.data.completion.complete
                    ? "继续配置"
                    : "查看运行状态"}
                </Link>
              </AlertDescription>
            </Alert>
          ) : (
            state?.status === "degraded" && (
              <Alert>
                <AlertCircle />
                <AlertTitle>可以收款，有运行告警</AlertTitle>
                <AlertDescription>
                  <Link to="/system" className="underline underline-offset-4">
                    查看告警
                  </Link>
                </AlertDescription>
              </Alert>
            )
          )}
        </div>
      )}
      <SectionCards analytics={data} />
      <div className="flex min-w-0 flex-col gap-4 px-4 lg:px-6">
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
      <div className="grid min-w-0 items-start gap-4 px-4 lg:px-6 @5xl/main:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              最近订单
            </CardTitle>
            <CardAction>
              <Link
                to="/orders"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                全部订单
                <ArrowRight data-icon="inline-end" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            <QueryView query={orders}>
              {(page) => <DataTable data={page.data} />}
            </QueryView>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              待处理
            </CardTitle>
            <CardAction>
              <Link
                to="/work-items"
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                查看全部
                <ArrowRight data-icon="inline-end" />
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent>
            <QueryView query={work}>
              {(page) =>
                page.data.length ? (
                  <ItemGroup>
                    {page.data.map((item, index) => (
                      <Fragment key={item.type + item.resource_id}>
                        {index > 0 && <ItemSeparator />}
                        <Item
                          size="sm"
                          render={<Link to={workItemHref(item)} />}
                        >
                          <ItemContent>
                            <ItemTitle>{workItemTitle(item)}</ItemTitle>
                            <ItemDescription>
                              {dateTime(item.actionable_at)}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <ChevronRight />
                          </ItemActions>
                        </Item>
                      </Fragment>
                    ))}
                  </ItemGroup>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ListChecks />
                      </EmptyMedia>
                      <EmptyTitle>暂无待处理提醒</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )
              }
            </QueryView>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
