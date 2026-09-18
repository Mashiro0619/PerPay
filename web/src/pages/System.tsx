import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { Link } from "@/navigation";
import { api, result } from "@/api/client";
import { dateTime } from "@/lib/format";
import { notificationErrorName } from "@/lib/detail-summary";
import { QueryView } from "@/components/request-state";
import { RecordTools } from "@/components/detail/RecordTools";
import { OfficialUpdatePanel } from "@/updates";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemFooter,
  ItemGroup,
} from "@/components/ui/item";
export default function System() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    refetchInterval: 30000,
  });
  return (
    <>
      <div className="flex justify-end">
        <Button
          variant="outline"
          disabled={status.isFetching}
          onClick={() => {
            void status.refetch();
          }}
        >
          {status.isFetching ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新
        </Button>
      </div>
      <QueryView query={status}>
        {({ data }) => {
          const canReceive =
            data.status !== "not_ready" &&
            data.configured &&
            data.database.ok &&
            data.ledger.collection_ready &&
            data.reconciliation.confirmation_ready;
          const conflicts = data.ledger.conflicts?.open ?? 0;
          const exceptions = data.reconciliation.exceptions?.open ?? 0;
          const ledgerHealthy =
            data.ledger.collection_ready &&
            data.ledger.consecutive_failures === 0 &&
            conflicts === 0;
          const reconciliationHealthy =
            data.reconciliation.confirmation_ready &&
            data.reconciliation.consecutive_failures === 0 &&
            exceptions === 0;
          const webhookHealthy =
            data.webhook.consecutive_failures === 0 &&
            data.webhook.dead_letters === 0;
          const backupHealthy =
            data.backup.ok &&
            !data.backup.recovery_required &&
            !data.backup.configuration_mismatch &&
            !data.backup.clock_moved_backwards;
          const needsAttention =
            data.status === "degraded" ||
            !ledgerHealthy ||
            !reconciliationHealthy ||
            (data.webhook.enabled && !webhookHealthy) ||
            (data.backup.enabled && !backupHealthy) ||
            data.backup.recovery_required ||
            data.backup.configuration_mismatch ||
            data.backup.clock_moved_backwards;
          const explanation = status.isError
            ? "显示上次读取结果。"
            : !data.configured
              ? "收款配置未完成。"
              : !data.database.ok
                ? "数据库不可用，请检查服务器。"
                : !data.ledger.collection_ready
                  ? "账本采集尚未就绪。"
                  : !data.reconciliation.confirmation_ready
                    ? "自动确认尚未就绪。"
                    : needsAttention
                      ? "有运行告警"
                      : null;

          return (
            <>
              <Card>
                <CardHeader>
                  <CardTitle
                    className="flex items-center gap-2"
                    role="heading"
                    aria-level={2}
                  >
                    {canReceive && !status.isError ? (
                      <CheckCircle2 className="size-5" />
                    ) : (
                      <CircleAlert className="size-5" />
                    )}
                    {status.isError
                      ? "收款状态待刷新"
                      : canReceive
                        ? "可以收款"
                        : "暂不能收款"}
                  </CardTitle>
                  <CardDescription>
                    {explanation || (
                      <>
                        <span>v{data.version}</span> · 更新于{" "}
                        {dateTime(status.dataUpdatedAt)}
                      </>
                    )}
                  </CardDescription>
                  {!data.configured && (
                    <CardAction>
                      <Link
                        className={buttonVariants()}
                        to="/settings/onboarding"
                      >
                        继续配置
                      </Link>
                    </CardAction>
                  )}
                </CardHeader>
                {explanation && (
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      <span>v{data.version}</span> · 更新于{" "}
                      {dateTime(status.dataUpdatedAt)}
                    </p>
                  </CardContent>
                )}
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle role="heading" aria-level={2}>
                    运行环节
                  </CardTitle>
                  <CardDescription>以下统计包含已忽略记录。</CardDescription>
                </CardHeader>
                <CardContent>
                  <ItemGroup>
                    <ComponentStatus
                      title="账本采集"
                      enabled={data.ledger.enabled}
                      healthy={ledgerHealthy}
                      summary={
                        "最近成功 " + dateTime(data.ledger.last_success_at)
                      }
                      metrics={
                        "未处理冲突 " + (data.ledger.conflicts?.open ?? "—")
                      }
                      action={
                        <>
                          {(!data.ledger.collection_ready ||
                            data.ledger.consecutive_failures > 0) && (
                            <Link
                              className={buttonVariants({
                                variant: "outline",
                                size: "sm",
                              })}
                              to="/settings/provider"
                            >
                              支付宝接入
                            </Link>
                          )}
                          {conflicts > 0 && (
                            <Link
                              className={buttonVariants({
                                variant: "outline",
                                size: "sm",
                              })}
                              to="/reconciliation?tab=conflicts&status=ALL"
                            >
                              查看全部冲突记录
                            </Link>
                          )}
                        </>
                      }
                    >
                      {!data.ledger.collection_ready && (
                        <p>采集尚未就绪或已中断，新订单收款入口暂不可用。</p>
                      )}
                      {data.ledger.last_error_code && (
                        <p>
                          最近错误：{data.ledger.last_error_code} · 连续失败{" "}
                          {data.ledger.consecutive_failures} 次
                        </p>
                      )}
                    </ComponentStatus>
                    <ComponentStatus
                      title="自动确认"
                      enabled={data.reconciliation.enabled}
                      healthy={reconciliationHealthy}
                      summary={
                        "最近成功 " +
                        dateTime(data.reconciliation.last_success_at)
                      }
                      metrics={
                        "待核对订单 " +
                        data.reconciliation.pending_orders +
                        " · 未处理异常 " +
                        (data.reconciliation.exceptions?.open ?? "—")
                      }
                      action={
                        exceptions > 0 && (
                          <Link
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                            })}
                            to="/work-items?type=FINANCIAL_EXCEPTION"
                          >
                            查看未忽略提醒
                          </Link>
                        )
                      }
                    >
                      {!data.reconciliation.confirmation_ready && (
                        <p>自动确认尚未就绪。</p>
                      )}
                      {data.reconciliation.last_error_code && (
                        <p>
                          最近错误：{data.reconciliation.last_error_code} ·
                          连续失败 {data.reconciliation.consecutive_failures} 次
                        </p>
                      )}
                    </ComponentStatus>
                    <ComponentStatus
                      title="业务通知"
                      enabled={data.webhook.enabled}
                      healthy={webhookHealthy}
                      summary={
                        data.webhook.enabled
                          ? "最近成功 " + dateTime(data.webhook.last_success_at)
                          : "已关闭，业务网站需主动查单"
                      }
                      metrics={
                        <>
                          待投递 {data.webhook.pending_deliveries} · 投递失败{" "}
                          {data.webhook.dead_letters > 0 ? (
                            <Link to="/notifications?status=DEAD_LETTER">
                              {data.webhook.dead_letters}
                            </Link>
                          ) : (
                            0
                          )}
                        </>
                      }
                      action={
                        !webhookHealthy && (
                          <Link
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                            })}
                            to="/notifications"
                          >
                            查看投递
                          </Link>
                        )
                      }
                    >
                      {data.webhook.last_error_code && (
                        <p>
                          {notificationErrorName(data.webhook.last_error_code)}{" "}
                          · 连续失败 {data.webhook.consecutive_failures} 次
                        </p>
                      )}
                    </ComponentStatus>
                    <ComponentStatus
                      title="数据库"
                      enabled
                      healthy={data.database.ok}
                      summary="SQLite"
                    >
                      {!data.database.ok && <p>{data.database.result}</p>}
                    </ComponentStatus>
                    <ComponentStatus
                      title="自动备份"
                      enabled={data.backup.enabled}
                      healthy={backupHealthy}
                      summary={
                        "最近成功 " + dateTime(data.backup.last_success_at)
                      }
                      metrics={
                        data.backup.backup_in_progress
                          ? "正在备份"
                          : "保留 " + (data.backup.retained_count ?? 0) + " 份"
                      }
                      action={
                        <Link
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                          to="/settings/backup"
                        >
                          备份设置
                        </Link>
                      }
                    >
                      {data.backup.recovery_required && (
                        <p>
                          实例需要恢复。请按维护文档处理，不要覆盖运行中的数据库。
                        </p>
                      )}
                      {data.backup.configuration_mismatch && (
                        <p>备份配置与运行状态不一致，请检查服务器备份任务。</p>
                      )}
                      {data.backup.clock_moved_backwards && (
                        <p>系统时钟发生回退，请检查主机时间同步。</p>
                      )}
                      {data.backup.last_error_stage && (
                        <p>最近失败阶段：{data.backup.last_error_stage}</p>
                      )}
                      {!data.backup.backup_available && data.backup.enabled && (
                        <p>暂无可用备份。</p>
                      )}
                    </ComponentStatus>
                  </ItemGroup>
                </CardContent>
              </Card>
              <RecordTools
                label="运行技术信息"
                data={data}
                identifiers={[
                  ["实例编号", data.instance_id],
                  ["支付宝账户", data.provider_account_key],
                  ["备份文件", data.backup.backup_name],
                  ["备份 SHA-256", data.backup.backup_sha256],
                ]}
              />
            </>
          );
        }}
      </QueryView>
      <OfficialUpdatePanel />
    </>
  );
}
function ComponentStatus({
  title,
  enabled,
  healthy,
  summary,
  metrics,
  action,
  children,
}: {
  title: string;
  enabled: boolean;
  healthy: boolean;
  summary: string;
  metrics?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>
          {title}
          <Badge variant={enabled && !healthy ? "destructive" : "outline"}>
            {enabled ? (
              healthy ? (
                <CheckCircle2 data-icon="inline-start" />
              ) : (
                <CircleAlert data-icon="inline-start" />
              )
            ) : null}
            {!enabled ? "未启用" : healthy ? "正常" : "需关注"}
          </Badge>
        </ItemTitle>
        <ItemDescription>{summary}</ItemDescription>
        {metrics && <ItemDescription>{metrics}</ItemDescription>}
      </ItemContent>
      {action && <ItemActions className="flex-wrap">{action}</ItemActions>}
      {!healthy && (
        <ItemFooter>
          <div className="flex flex-col gap-2 text-sm">{children}</div>
        </ItemFooter>
      )}
    </Item>
  );
}
