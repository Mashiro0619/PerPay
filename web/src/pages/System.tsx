import { Children, isValidElement, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  Code2,
  Database,
  HardDrive,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { SystemStatus } from "@/api/client";
import { Link } from "@/navigation";
import {
  SystemStatusBoundary,
  useSystemStatus,
} from "@/features/system-status";
import { presentSystemStatus } from "@/lib/system-status";
import { backupFailureStageName, runtimeErrorMessage } from "@/lib/runtime-copy";
import {
  BUSINESS_TIME_ZONE,
  count,
  dateTime,
  backupIntervalLabel,
} from "@/lib/format";
import { LedgerIngestionDiagnostics } from "@/components/ledger-ingestion-diagnostics";
import { AlipayAccountStatus } from "@/components/alipay-account-status";
import { RefreshButton } from "@/components/refresh-button";
import { ErrorNotice, Loading, QueryView, ReadPausedNotice } from "@/components/request-state";
import { useRequestConnectionOnline } from "@/lib/request-notices";
import { TechnicalDetailsDialog } from "@/components/detail/DetailPrimitives";
import { FieldList } from "@/components/record/FieldList";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/admin-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CopyValue } from "@/components/copy-value";
import { accountHealth, accountState } from "@/lib/alipay-accounts";
import { OfficialUpdatePanel } from "@/updates";
import { useManualLedgerScan } from "@/features/manual-ledger-scan";
import { manualScanSource } from "@/lib/manual-ledger-scan";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  const online = useRequestConnectionOnline();
  const manualScan = useManualLedgerScan(status.data?.data);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [ledgerDiagnosticsOpen, setLedgerDiagnosticsOpen] = useState(false);
  const diagnosticTrigger = useRef<HTMLButtonElement>(null);
  const refresh = () => {
    void status.refetch();
  };
  const snapshot = !checking && !status.isPending ? status.data?.data : undefined;
  const openDiagnostics = (trigger: HTMLButtonElement) => {
    diagnosticTrigger.current = trigger;
    setDiagnosticsOpen(true);
  };
  const openLedgerDiagnostics = (trigger: HTMLButtonElement) => {
    diagnosticTrigger.current = trigger;
    setLedgerDiagnosticsOpen(true);
  };

  return (
    <div className="system-page">
      {checking ? (
        unavailable ? (
          !online || status.isPaused ? <ReadPausedNotice />
            : status.error ? <ErrorNotice scope="page" error={status.error} retry={refresh} />
              : <p className="text-sm text-muted-foreground">暂时无法确认运行状态</p>
        ) : (
          <Loading label="正在读取运行状态…" />
        )
      ) : (
        <QueryView query={status}>
          {({ data }) => (
            <SystemHealthBanner
              data={data}
              updatedAt={status.dataUpdatedAt}
              refreshing={status.isFetching}
              refresh={refresh}
              diagnosticTrigger={diagnosticTrigger}
              onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            />
          )}
        </QueryView>
      )}
      <div className="system-workspace-grid" data-has-snapshot={snapshot ? "true" : undefined}>
        {snapshot && (
          <div key="primary" className="system-primary-column">
            <RuntimeServicesCard
              data={snapshot}
              manualScan={manualScan}
              onDiagnose={openDiagnostics}
              onLedgerDiagnose={openLedgerDiagnostics}
            />
            {snapshot.alipay_accounts && <AlipayAccountStatus accounts={snapshot.alipay_accounts} source={manualScanSource(snapshot)} snapshotUpdatedAt={status.dataUpdatedAt} />}
          </div>
        )}
        <div key="updates" className="system-secondary-column">
          <OfficialUpdatePanel currentVersion={status.data?.data.version} />
        </div>
      </div>
      {snapshot && (
        <>
          <TechnicalDetailsDialog
            open={diagnosticsOpen}
            onOpenChange={setDiagnosticsOpen}
            finalFocus={() => diagnosticTrigger.current}
            data={snapshot}
            identifiers={[
              ["实例编号", snapshot.instance_id],
              ["查账来源标识", snapshot.provider_account_key],
              ["备份文件", snapshot.backup.backup_name],
              ["备份摘要（SHA-256）", snapshot.backup.backup_sha256],
            ]}
          />
          <LedgerDiagnosis
            data={snapshot}
            open={ledgerDiagnosticsOpen}
            onOpenChange={setLedgerDiagnosticsOpen}
            finalFocus={() => diagnosticTrigger.current}
          />
        </>
      )}
    </div>
  );
}

function SystemHealthBanner({
  data,
  updatedAt,
  refreshing,
  refresh,
  diagnosticTrigger,
  onOpenDiagnostics,
}: {
  data: SystemStatus;
  updatedAt: number;
  refreshing: boolean;
  refresh: () => void;
  diagnosticTrigger: RefObject<HTMLButtonElement | null>;
  onOpenDiagnostics: () => void;
}) {
  const state = presentSystemStatus(data);
  const serviceHealth = [
    state.ledgerHealthy,
    state.reconciliationHealthy,
    state.webhookHealthy,
    data.database.ok,
    state.backupHealthy,
  ];
  const attentionCount = serviceHealth.filter(healthy => !healthy).length;
  const healthyCount = serviceHealth.length - attentionCount;
  const healthTone = !state.canReceive ? "blocked" : attentionCount > 0 ? "attention" : "healthy";
  const explanation = !data.configured
    ? "收款配置未完成，请先完成接入。"
    : !data.database.ok
      ? "数据库不可用，请检查服务器。"
      : !data.ledger.collection_ready
        ? "查账尚未就绪，新订单收款入口已暂停。"
        : !data.reconciliation.confirmation_ready
          ? "自动确认收款尚未就绪，请检查确认任务。"
          : "服务尚未就绪，请检查运行环节。";
  const unexplainedWarning =
    state.canReceive &&
    state.runtimeWarning &&
    state.ledgerHealthy &&
    state.reconciliationHealthy &&
    state.webhookHealthy &&
    state.backupHealthy &&
    data.work_items !== null;
  const hasNotices = !state.canReceive || unexplainedWarning || data.work_items === null;

  return (
    <section className="runtime-surface" aria-label="服务运行状态">
      <Card size="sm" className="runtime-hero-card" data-health={healthTone}>
        <CardContent className="runtime-hero-body">
          <div className="runtime-hero-main" data-system-health-summary>
            <div className="runtime-hero-icon" aria-hidden="true">
              {!state.canReceive ? (
                <CircleAlert className="size-5" />
              ) : attentionCount > 0 ? (
                <AlertTriangle className="size-5" />
              ) : (
                <ShieldCheck className="size-5" />
              )}
            </div>
            <div className="runtime-hero-copy">
              <div className="runtime-hero-title-row">
                <p className="text-base font-semibold tracking-tight">
                  {state.canReceive ? "收款服务可用" : "收款服务需处理"}
                </p>
                <Badge variant={!state.canReceive ? "destructive" : attentionCount ? "warning" : "success"}>
                  {attentionCount ? `${attentionCount} 项需关注` : "运行正常"}
                </Badge>
              </div>
              <p className="runtime-checked">
                <span>
                  {attentionCount === 0
                    ? `全部 ${serviceHealth.length} 项核心环节正常`
                    : `${healthyCount}/${serviceHealth.length} 项核心环节正常`}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  更新于 <RuntimeTimestamp value={updatedAt} />
                </span>
              </p>
            </div>
          </div>
          <div className="runtime-toolbar">
            <div className="runtime-toolbar-actions">
              <Button
                ref={diagnosticTrigger}
                variant="outline"
                size="sm"
                aria-haspopup="dialog"
                onClick={onOpenDiagnostics}
              >
                <Code2 data-icon="inline-start" />
                运行诊断
              </Button>
              <RefreshButton variant="outline" size="icon-sm" busy={refreshing} onClick={refresh} />
            </div>
          </div>
        </CardContent>
        {hasNotices && (
          <CardContent className="runtime-hero-notices">
            {!state.canReceive && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>已暂停接收新订单</AlertTitle>
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
          </CardContent>
        )}
      </Card>
    </section>
  );
}

function RuntimeServicesCard({
  data,
  manualScan,
  onDiagnose,
  onLedgerDiagnose,
}: {
  data: SystemStatus;
  manualScan: ReturnType<typeof useManualLedgerScan>;
  onDiagnose: (trigger: HTMLButtonElement) => void;
  onLedgerDiagnose: (trigger: HTMLButtonElement) => void;
}) {
  const state = presentSystemStatus(data);
  const serviceHealth = [
    state.ledgerHealthy,
    state.reconciliationHealthy,
    state.webhookHealthy,
    data.database.ok,
    state.backupHealthy,
  ];
  const healthyCount = serviceHealth.filter(Boolean).length;
  const manualScanFeedbackId = useId();

  return (
    <Card size="sm" className="runtime-services-card">
      <CardHeader className="runtime-services-header">
        <CardTitle role="heading" aria-level={2}>核心运行环节</CardTitle>
        <CardDescription>异常环节会自动置顶，便于优先排查。</CardDescription>
        <CardAction>
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {healthyCount} / {serviceHealth.length} 正常
          </span>
        </CardAction>
      </CardHeader>
      <CardContent className="runtime-services-content">
        <Table
          className="runtime-status-table"
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
          <TableHeader>
            <TableRow>
              <TableHead scope="col">
                服务
              </TableHead>
              <TableHead scope="col">
                状态
              </TableHead>
              <TableHead scope="col">
                任务最近成功
              </TableHead>
              <TableHead scope="col">
                运行信息
              </TableHead>
              <TableHead
                scope="col"
                className="runtime-actions-heading"
              >
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <RuntimeServices>
              <RuntimeService
                onDiagnose={onLedgerDiagnose}
                icon={RefreshCw}
                title="查账"
                enabled={data.ledger.enabled}
                healthy={state.ledgerHealthy}
                lastSuccess={data.ledger.last_success_at}
                metric={
                  data.ledger.in_flight || manualScan.pending || manualScan.error || manualScan.request || manualScan.unavailableReason ? (
                    <>
                      {data.ledger.in_flight && <p>正在查账</p>}
                      <ManualScanFeedback control={manualScan} id={manualScanFeedbackId} />
                    </>
                  ) : undefined
                }
                action={
                  <>
                    <Button variant="outline" size="sm" disabled={manualScan.disabled}
                      aria-describedby={manualScan.unavailableReason ? manualScanFeedbackId : undefined}
                      aria-busy={manualScan.pending || undefined} onClick={manualScan.submit}>
                      {manualScan.pending && <Spinner aria-hidden="true" data-icon="inline-start" />}
                      手动查账
                    </Button>
                    {(!data.ledger.collection_ready ||
                      data.ledger.consecutive_failures > 0) && (
                      <Link
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                        to="/settings/provider"
                      >
                        支付宝账号
                      </Link>
                    )}
                  </>
                }
              >
                {!data.ledger.collection_ready && (
                  <p className="font-medium text-foreground">查账尚未就绪或已中断，新订单收款入口暂不可用。</p>
                )}
                {data.ledger.last_error_code &&
                  data.ledger.diagnostics?.latest_failure?.error_code !==
                    data.ledger.last_error_code && (
                    <p>
                      {runtimeErrorMessage("查账", data.ledger.last_error_code)} · 连续失败{" "}
                      {data.ledger.consecutive_failures} 次
                    </p>
                  )}
                <LedgerIngestionDiagnostics diagnostics={data.ledger.diagnostics} />
              </RuntimeService>
              <RuntimeService
                onDiagnose={onDiagnose}
                icon={CheckCheck}
                title="自动确认收款"
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
                  <p className="font-medium text-foreground">自动确认收款尚未就绪。</p>
                )}
                {data.reconciliation.last_error_code && (
                  <p>
                    {runtimeErrorMessage("自动确认收款", data.reconciliation.last_error_code)} · 连续失败{" "}
                    {data.reconciliation.consecutive_failures} 次
                  </p>
                )}
              </RuntimeService>
              <RuntimeService
                onDiagnose={onDiagnose}
                icon={Bell}
                title="通知"
                enabled={data.webhook.enabled}
                healthy={state.webhookHealthy}
                lastSuccess={data.webhook.last_success_at}
                metric={
                  !data.webhook.enabled
                    ? "业务网站需主动查单"
                    : data.webhook.pending_deliveries > 0
                      ? "待发送 " + count(data.webhook.pending_deliveries)
                      : data.webhook.in_flight
                        ? "发送中"
                        : undefined
                }
                action={
                  !state.webhookHealthy && (
                    <Link
                      className={buttonVariants({ variant: "ghost", size: "sm" })}
                      to="/notifications"
                    >
                      查看通知
                    </Link>
                  )
                }
              >
                {data.webhook.last_error_code && (
                  <p>
                    {runtimeErrorMessage("通知", data.webhook.last_error_code)} · 连续失败{" "}
                    {data.webhook.consecutive_failures} 次
                  </p>
                )}
              </RuntimeService>
              <RuntimeService
                onDiagnose={onDiagnose}
                icon={Database}
                title="数据库"
                enabled
                healthy={data.database.ok}
                metric="SQLite"
              >
                {!data.database.ok && <p className="font-medium text-foreground">{data.database.result}</p>}
              </RuntimeService>
              <RuntimeService
                onDiagnose={onDiagnose}
                icon={HardDrive}
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
                        <p className="text-xs text-muted-foreground">
                          策略：
                          {backupIntervalLabel(data.backup_policy.interval_seconds)}
                          ，保留 {count(data.backup_policy.keep_count)} 份
                        </p>
                      )}
                      {(!data.backup.enabled ||
                        !data.backup.backup_available ||
                        data.backup.configuration_mismatch) && (
                        <p className="text-xs text-muted-foreground">
                          <a
                            data-external-link
                            className="text-foreground underline underline-offset-4"
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
                        <p className="text-xs text-muted-foreground">最近失败阶段：{backupFailureStageName(data.backup.last_error_stage)}</p>
                      )}
                    </>
                  ) : undefined
                }
              >
                {data.backup.status === "unavailable" && (
                  <p className="font-medium text-foreground">备份状态暂不可用，请检查备份目录及权限。</p>
                )}
                {data.backup.recovery_required && (
                  <p className="font-medium text-foreground">检测到上次备份或维护异常中断或锁状态异常，请按维护文档排查恢复，切勿直接覆盖运行中的数据库。</p>
                )}
                {data.backup.configuration_mismatch && (
                  <p className="font-medium text-foreground">已保存的备份策略与当前运行配置不一致，请检查服务器备份任务是否已同步。</p>
                )}
                {data.backup.clock_moved_backwards && (
                  <p className="font-medium text-foreground">系统时钟发生回退，请检查主机时间同步。</p>
                )}
                {data.backup.instance_matches === false && (
                  <p className="font-medium text-foreground">备份与当前实例不匹配，请检查备份目录。</p>
                )}
                {data.backup.status !== "unavailable" && !data.backup.backup_available && data.backup.enabled && (
                  <p className="font-medium text-foreground">暂无可用备份。</p>
                )}
                {data.backup.status !== "unavailable" && data.backup.backup_available && data.backup.backup_required && (
                  <p className="font-medium text-foreground">当前数据需要重新备份。</p>
                )}
                {data.backup.status !== "unavailable" &&
                  data.backup.enabled &&
                  data.backup.backup_available &&
                  !data.backup.ok &&
                  !data.backup.recovery_required &&
                  !data.backup.configuration_mismatch &&
                  !data.backup.clock_moved_backwards &&
                  data.backup.instance_matches !== false &&
                  !data.backup.backup_required && (
                    <p className="font-medium text-foreground">当前备份未通过健康检查，请查看备份设置或重新备份。</p>
                  )}
              </RuntimeService>
            </RuntimeServices>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function LedgerDiagnosis({ data, open, onOpenChange, finalFocus }: { data: SystemStatus; open: boolean; onOpenChange: (open: boolean) => void; finalFocus: () => HTMLElement | null }) {
  const title = useRef<HTMLHeadingElement>(null);
  const accounts = data.alipay_accounts;
  const technical = JSON.stringify({ ledger: data.ledger, accounts: accounts?.map(account => ({
    id: account.id, name: account.name, configured: account.configured, health: account.health, last_check: account.last_check,
  })) }, null, 2);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent initialFocus={title} finalFocus={finalFocus}>
      <DialogHeader>
        <DialogTitle ref={title} tabIndex={-1}>查账诊断</DialogTitle>
        <DialogDescription className="sr-only">
          查看各支付宝账号配置、连接测试与查账诊断详情。
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Alert variant={data.ledger.collection_ready ? "default" : "destructive"}>
          <AlertTitle>{data.ledger.collection_ready ? "查账已就绪" : "查账尚未就绪"}</AlertTitle>
          <AlertDescription>{!data.configured ? "先补齐支付宝账号配置，再测试连接。" : data.ledger.last_error_code
            ? runtimeErrorMessage("查账", data.ledger.last_error_code) : data.ledger.in_flight ? "正在查询支付宝账单，请等待本轮结果。" : "核对下方账号的配置、连接测试和最近查账结果。"}</AlertDescription>
        </Alert>
        <FieldList items={[
          { label: "最近成功查账", kind: "time", value: dateTime(data.ledger.last_success_at) },
          { label: "连续失败", value: data.ledger.consecutive_failures + " 次" },
        ]} />
        <LedgerIngestionDiagnostics diagnostics={data.ledger.diagnostics} />
        {accounts?.map(account => <section key={account.id} aria-label={account.name} className="flex min-w-0 flex-col gap-3">
          <h3 className="text-sm font-medium">{account.name}</h3>
          <FieldList items={[
            { label: "配置状态", value: accountState(account) },
            { label: "连接测试", value: account.last_check ? account.last_check.message : "尚未测试" },
            { label: "最近测试", kind: "time", value: dateTime(account.last_check?.checked_at) },
            { label: "查账状态", value: accountHealth(account) },
            { label: "最近成功", kind: "time", value: dateTime(account.health?.last_success_at) },
          ]} />
          <Link to={"/settings/accounts/" + encodeURIComponent(account.id)} className={buttonVariants({ variant: "outline", size: "sm" })} onClick={() => onOpenChange(false)}>配置{account.name}</Link>
        </section>)}
        {!accounts?.length && <Link to="/settings/onboarding" onClick={() => onOpenChange(false)}>继续配置支付宝账号</Link>}
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>技术数据<ChevronDown data-icon="inline-end" /></CollapsibleTrigger>
          <CollapsibleContent className="flex min-w-0 flex-col gap-2">
            <CopyValue value={technical} label="复制查账技术数据" buttonOnly />
            <pre tabIndex={0} role="region" aria-label="查账技术数据" className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere"><code>{technical}</code></pre>
          </CollapsibleContent>
        </Collapsible>
      </DialogBody>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>关闭</DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function RuntimeServices({ children }: { children: ReactNode }) {
  // A problem and its explanation stay adjacent, ahead of healthy services.
  return <>{Children.toArray(children).sort((left, right) => {
    const rank = (item: ReactNode) => isValidElement<{ healthy: boolean }>(item) && item.props.healthy ? 1 : 0;
    return rank(left) - rank(right);
  })}</>;
}

function ManualScanFeedback({ control, id }: { control: ReturnType<typeof useManualLedgerScan>; id: string }) {
  const request = control.request;
  let message: ReactNode = null;
  if (control.pending) message = "正在提交查账请求…";
  else if (control.error) message = <>{control.error.message}{control.remaining > 0 && <> 请等待 {control.remaining} 秒后重试。</>}</>;
  else if (request?.state === "WAITING") message = request.next_attempt_at
    ? <>手动查账已排队，计划开始：<time dateTime={request.next_attempt_at}>{dateTime(request.next_attempt_at)}</time></>
    : "手动查账已排队，等待调度。";
  else if (request?.state === "RUNNING") message = <>正在执行手动查账，开始于：<time dateTime={request.started_at!}>{dateTime(request.started_at!)}</time></>;
  else if (request) {
    const outcome = request.state === "FAILED" || request.outcome === "FAILED"
      ? "手动查账未完成。" : request.outcome === "COMPLETED"
        ? "手动查账已完成。" : request.outcome === "PARTIAL"
          ? "本轮查账部分完成，仍有待补查流水。" : "本轮未执行查账，请查看运行诊断。";
    message = <>{outcome}{request.error_code && <> {request.error_code === "runtime_changed" ? "运行配置已变化，请核对后重新发起。" : runtimeErrorMessage("查账", request.error_code)}</>}
      {request.finished_at && <> 结束于：<time dateTime={request.finished_at}>{dateTime(request.finished_at)}</time></>}</>;
  }
  if (!message && !control.unavailableReason) return null;
  return <div className="runtime-manual-scan-feedback">
    {message && <p role={control.error ? "alert" : "status"} aria-label="手动查账状态">{message}</p>}
    {control.unavailableReason && <p id={id}>{control.unavailableReason}</p>}
  </div>;
}

function RuntimeService({
  icon: Icon,
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
  icon: LucideIcon;
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
          <span className="runtime-service-label">
            <Icon aria-hidden="true" className="runtime-service-icon size-4 shrink-0" />
            <span>{title}</span>
          </span>
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
          <span className="runtime-mobile-label">任务最近成功</span>
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
          data-attention={attention || undefined}
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
