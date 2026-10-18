import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, Code2 } from "lucide-react";
import type { SystemStatus } from "@/api/client";
import { Link } from "@/navigation";
import {
  SystemStatusBoundary,
  useSystemStatus,
} from "@/features/system-status";
import { presentSystemStatus } from "@/lib/system-status";
import {
  BUSINESS_TIME_ZONE,
  count,
  dateTime,
  backupIntervalLabel,
} from "@/lib/format";
import { notificationErrorName } from "@/lib/detail-summary";
import { LedgerIngestionDiagnostics } from "@/components/ledger-ingestion-diagnostics";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading, QueryView } from "@/components/request-state";
import { TechnicalDetailsDialog } from "@/components/detail/DetailPrimitives";
import { OfficialUpdatePanel } from "@/updates";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
  TableCaption,
} from "@/components/ui/table";

const runtimeTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: BUSINESS_TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export default function System() {
  return (
    <SystemStatusBoundary>
      <SystemContent />
    </SystemStatusBoundary>
  );
}

function SystemContent() {
  const { status, checking, unavailable } = useSystemStatus();
  const refresh = () => {
    void status.refetch();
  };
  return (
    <div className="system-page">
      {checking ? (
        unavailable ? (
          <div className="flex flex-col gap-3">
            <Alert>
              <CircleAlert />
              <AlertTitle>暂时无法确认运行状态</AlertTitle>
            </Alert>
            <ErrorNotice error={status.error} retry={refresh} />
          </div>
        ) : (
          <Loading label="正在读取运行状态…" />
        )
      ) : (
        <QueryView query={status}>
          {({ data }) => (
            <SystemSnapshot
              data={data}
              updatedAt={status.dataUpdatedAt}
              refreshing={status.isFetching}
              refresh={refresh}
            />
          )}
        </QueryView>
      )}
      <OfficialUpdatePanel currentVersion={status.data?.data.version} />
    </div>
  );
}

function SystemSnapshot({
  data,
  updatedAt,
  refreshing,
  refresh,
}: {
  data: SystemStatus;
  updatedAt: number;
  refreshing: boolean;
  refresh: () => void;
}) {
  const state = presentSystemStatus(data);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnosticTrigger = useRef<HTMLButtonElement>(null);
  const openDiagnostics = (trigger: HTMLButtonElement) => { diagnosticTrigger.current = trigger; setDiagnosticsOpen(true); };
  const explanation = !data.configured
    ? "收款配置未完成，请先完成接入。"
    : !data.database.ok
      ? "数据库不可用，请检查服务器。"
      : !data.ledger.collection_ready
        ? "查账尚未就绪，新订单收款入口已暂停。"
        : !data.reconciliation.confirmation_ready
          ? "自动确认尚未就绪，请检查确认任务。"
          : "服务尚未就绪，请检查运行环节。";
  const unexplainedWarning =
    state.canReceive &&
    state.runtimeWarning &&
    state.ledgerHealthy &&
    state.reconciliationHealthy &&
    state.webhookHealthy &&
    state.backupHealthy &&
    data.work_items !== null;
  return (
    <section className="runtime-surface" aria-label="服务运行状态">
      <div className="runtime-toolbar">
        <p className="runtime-checked">
          更新于 <RuntimeTimestamp value={updatedAt} />
        </p>
        <div className="runtime-toolbar-actions">
          <Button
            ref={diagnosticTrigger}
            variant="ghost"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => setDiagnosticsOpen(true)}
          >
            <Code2 data-icon="inline-start" />
            运行诊断
          </Button>
          <RefreshButton size="icon-sm" busy={refreshing} onClick={refresh} />
        </div>
      </div>
      {!state.canReceive && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>收款已暂停</AlertTitle>
          <AlertDescription>
            <p>{explanation}</p>
            {!data.configured && (
              <Link to="/settings/onboarding">继续配置</Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      {unexplainedWarning && (
        <p role="status" className="text-sm text-muted-foreground">
          服务报告运行异常，请查看运行诊断。
        </p>
      )}
      {data.work_items === null && (
        <p role="status" className="text-sm text-muted-foreground">
          提醒统计暂不可用，请刷新重试。
        </p>
      )}
      <Table
        className="runtime-status-table"
        role="table"
        aria-label="运行环节"
      >
        <TableCaption className="sr-only">运行环节</TableCaption>
        <colgroup>
          <col className="runtime-col-service" />
          <col className="runtime-col-status" />
          <col className="runtime-col-time" />
          <col className="runtime-col-info" />
          <col className="runtime-col-actions" />
        </colgroup>
        <TableHeader role="rowgroup">
          <TableRow role="row">
            <TableHead scope="col" role="columnheader">
              服务
            </TableHead>
            <TableHead scope="col" role="columnheader">
              状态
            </TableHead>
            <TableHead scope="col" role="columnheader">
              最近成功
            </TableHead>
            <TableHead scope="col" role="columnheader">
              运行信息
            </TableHead>
            <TableHead
              scope="col"
              role="columnheader"
              className="runtime-actions-heading"
            >
              <span className="sr-only">操作</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody role="rowgroup">
          <RuntimeService
            onDiagnose={openDiagnostics}
            title="查账"
            enabled={data.ledger.enabled}
            healthy={state.ledgerHealthy}
            lastSuccess={data.ledger.last_success_at}
            metric={data.ledger.in_flight ? "正在查账" : undefined}
            action={
              (!data.ledger.collection_ready ||
                data.ledger.consecutive_failures > 0) && (
                <Link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  to="/settings/provider"
                >
                  支付宝接入
                </Link>
              )
            }
          >
            {!data.ledger.collection_ready && (
              <p>查账尚未就绪或已中断，新订单收款入口暂不可用。</p>
            )}
            {data.ledger.last_error_code &&
              data.ledger.diagnostics?.latest_failure?.error_code !==
                data.ledger.last_error_code && (
                <p>
                  最近错误：{data.ledger.last_error_code} · 连续失败{" "}
                  {data.ledger.consecutive_failures} 次
                </p>
              )}
            <LedgerIngestionDiagnostics diagnostics={data.ledger.diagnostics} />
          </RuntimeService>
          <RuntimeService
            onDiagnose={openDiagnostics}
            title="自动确认"
            enabled={data.reconciliation.enabled}
            healthy={state.reconciliationHealthy}
            lastSuccess={data.reconciliation.last_success_at}
            metric={
              data.reconciliation.pending_orders > 0
                ? "待核对订单 " + count(data.reconciliation.pending_orders)
                : data.reconciliation.in_flight
                  ? "正在核对"
                  : undefined
            }
          >
            {!data.reconciliation.confirmation_ready && (
              <p>自动确认尚未就绪。</p>
            )}
            {data.reconciliation.last_error_code && (
              <p>
                最近错误：{data.reconciliation.last_error_code} · 连续失败{" "}
                {data.reconciliation.consecutive_failures} 次
              </p>
            )}
          </RuntimeService>
          <RuntimeService
            onDiagnose={openDiagnostics}
            title="通知"
            enabled={data.webhook.enabled}
            healthy={state.webhookHealthy}
            lastSuccess={data.webhook.last_success_at}
            metric={
              !data.webhook.enabled
                ? "业务网站需主动查单"
                : data.webhook.pending_deliveries > 0
                  ? "待投递 " + count(data.webhook.pending_deliveries)
                  : data.webhook.in_flight
                    ? "正在投递"
                    : undefined
            }
            action={
              !state.webhookHealthy && (
                <Link
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  to="/notifications"
                >
                  查看投递
                </Link>
              )
            }
          >
            {data.webhook.last_error_code && (
              <p>
                {notificationErrorName(data.webhook.last_error_code)} · 连续失败{" "}
                {data.webhook.consecutive_failures} 次
              </p>
            )}
          </RuntimeService>
          <RuntimeService
            onDiagnose={openDiagnostics}
            title="数据库"
            enabled
            healthy={data.database.ok}
            metric="SQLite"
          >
            {!data.database.ok && <p>{data.database.result}</p>}
          </RuntimeService>
          <RuntimeService
            onDiagnose={openDiagnostics}
            title="自动备份"
            enabled={data.backup.enabled}
            healthy={state.backupHealthy}
            lastSuccess={data.backup.last_success_at}
            metric={
              data.backup.backup_in_progress
                ? "正在备份"
                : data.backup.enabled
                  ? "保留 " + count(data.backup.retained_count ?? 0) + " 份"
                  : undefined
            }
            action={
              <Link
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                to="/settings/backup"
              >
                备份设置
              </Link>
            }
            details={
              data.backup_policy ||
              !data.backup.enabled ||
              !data.backup.backup_available ||
              data.backup.configuration_mismatch ||
              data.backup.last_error_stage ? (
                <>
                  {data.backup_policy && (
                    <p>
                      策略：
                      {backupIntervalLabel(data.backup_policy.interval_seconds)}
                      ，保留 {count(data.backup_policy.keep_count)} 份
                    </p>
                  )}
                  {(!data.backup.enabled ||
                    !data.backup.backup_available ||
                    data.backup.configuration_mismatch) && (
                    <p>
                      <a
                        data-external-link
                        className="underline underline-offset-4"
                        href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#启用与验证备份"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        启用与验证备份
                      </a>
                      ；保存策略不等于已有可用备份。
                    </p>
                  )}
                  {data.backup.last_error_stage && (
                    <p>最近失败阶段：{data.backup.last_error_stage}</p>
                  )}
                </>
              ) : undefined
            }
          >
            {data.backup.recovery_required && (
              <p>实例需要恢复。请按维护文档处理，不要覆盖运行中的数据库。</p>
            )}
            {data.backup.configuration_mismatch && (
              <p>备份配置与运行状态不一致，请检查服务器备份任务。</p>
            )}
            {data.backup.clock_moved_backwards && (
              <p>系统时钟发生回退，请检查主机时间同步。</p>
            )}
            {!data.backup.backup_available && data.backup.enabled && (
              <p>暂无可用备份。</p>
            )}
          </RuntimeService>
        </TableBody>
      </Table>
      <TechnicalDetailsDialog
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
        finalFocus={() => diagnosticTrigger.current}
        data={data}
        identifiers={[
          ["实例编号", data.instance_id],
          ["查账来源标识", data.provider_account_key],
          ["备份文件", data.backup.backup_name],
          ["备份 SHA-256", data.backup.backup_sha256],
        ]}
      />
    </section>
  );
}

function RuntimeService({
  title,
  enabled,
  healthy,
  lastSuccess,
  metric,
  action,
  details,
  children,
  onDiagnose,
}: {
  title: string;
  enabled: boolean;
  healthy: boolean;
  lastSuccess?: number | null;
  metric?: ReactNode;
  action?: ReactNode;
  details?: ReactNode;
  children: ReactNode;
  onDiagnose: (trigger: HTMLButtonElement) => void;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const attention = !healthy;
  const hasActions = attention || !!action || !!details;
  return (
    <>
      <TableRow
        className="runtime-service-row"
        role="row"
        data-attention={attention || undefined}
      >
        <TableHead
          scope="row"
          role="rowheader"
          className="runtime-service-name"
        >
          {title}
        </TableHead>
        <TableCell role="cell" className="runtime-service-state">
          <Badge variant={attention ? "warning" : enabled ? "success" : "secondary"}>
            {attention ? "需关注" : enabled ? "正常" : "未启用"}
          </Badge>
        </TableCell>
        <TableCell
          role="cell"
          className="runtime-service-time"
          data-empty={lastSuccess == null || undefined}
        >
          <span className="runtime-mobile-label">最近成功</span>
          <RuntimeTimestamp value={lastSuccess} />
        </TableCell>
        <TableCell
          role="cell"
          className="runtime-service-info"
          data-empty={metric == null || undefined}
        >
          {metric ?? <span className="runtime-empty">—</span>}
        </TableCell>
        <TableCell
          role="cell"
          className="runtime-service-actions"
          data-empty={!hasActions || undefined}
        >
          {hasActions && (
            <div className="runtime-row-actions">
              {attention && <Button variant="ghost" size="sm" aria-label={title + "运行诊断"} onClick={event => onDiagnose(event.currentTarget)}>
                <Code2 data-icon="inline-start" />诊断
              </Button>}
              {action}
              {healthy && details && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  onClick={() => setExpanded((value) => !value)}
                >
                  备份详情
                  <ChevronDown data-icon="inline-end" />
                </Button>
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
      {(attention || details) && (
        <TableRow
          id={detailsId}
          className="runtime-detail-row"
          role="row"
          hidden={!attention && !expanded}
        >
          <TableCell role="cell" colSpan={5}>
            <div className="runtime-detail-content" role="group" aria-label={title + "诊断"}>
              {attention && children}
              {details}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function RuntimeTimestamp({ value }: { value?: number | null }) {
  if (value == null || !Number.isFinite(new Date(value).getTime()))
    return <span className="runtime-empty">—</span>;
  return (
    <time dateTime={new Date(value).toISOString()} title={dateTime(value)}>
      {runtimeTime.format(value)}
    </time>
  );
}
