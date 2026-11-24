import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, ChevronDown, Circle, CircleAlert, RotateCcw, ShieldCheck } from "lucide-react";
import { ApiError } from "@/api/client";
import { getMaintenanceJob, startMaintenance, type MaintenanceJob } from "@/api/maintenance";
import {
  applySelfUpdate,
  buildOneLineUpgradeCommand,
  clearActiveSelfUpdateHint,
  getSelfUpdateStatus,
  readActiveSelfUpdateHint,
  SELF_UPDATE_DOCS_URL,
  UPDATER_ENABLE_COMMAND,
  writeActiveSelfUpdateHint,
  type SelfUpdateStatus,
  type UpdateExecutionJob,
} from "@/api/self-update";
import { isPrereleaseVersion, isReleaseVersion } from "../../../src/shared/release-version";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/admin-dialog";
import { CopyValue } from "@/components/copy-value";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

export interface SelfUpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetVersion: string;
  currentVersion: string;
  releaseUrl?: string | undefined;
  returnFocus?: HTMLElement | null | undefined;
  pollIntervalMs?: number | undefined;
  onReload?: (() => void) | undefined;
}

type DialogPhase = "loading" | "load_error" | "confirm" | "running" | "completed" | "failed" | "assistant";
type StepState = "pending" | "active" | "done" | "skipped" | "rollback";

const MAX_RECONNECT_WAIT_MS = 5 * 60 * 1000;
const MAX_UNREACHABLE_POLLS = 10;
const MAX_MISSING_JOB_POLLS = 5;

function isTransientRestartError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof ApiError) {
    return error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;
  }
  return error instanceof Error;
}

function stageRank(stage: UpdateExecutionJob["stage"] | undefined): number {
  switch (stage) {
    case "backing_up": return 0;
    case "queued":
    case "pulling": return 1;
    case "stopping_backup":
    case "recreating_app": return 2;
    case "verifying_health":
    case "recreating_backup": return 3;
    case "completed": return 4;
    default: return 1;
  }
}

function computeStepStates(
  stage: UpdateExecutionJob["stage"] | undefined,
  includeBackup: boolean,
  reconnecting: boolean,
): readonly { id: string; label: string; state: StepState }[] {
  const rank = reconnecting ? Math.max(2, stageRank(stage)) : stageRank(stage);
  const rollingBack = stage === "rolling_back";
  const stepState = (index: number): StepState => {
    if (index === 0 && !includeBackup) return "skipped";
    if (rollingBack && index === 3) return "rollback";
    if (rank > index) return "done";
    if (rank === index) return "active";
    return "pending";
  };
  return [
    { id: "backup", label: "更新前数据库备份", state: stepState(0) },
    { id: "pull", label: "拉取官方镜像", state: stepState(1) },
    { id: "restart", label: "切换并重启服务", state: stepState(2) },
    { id: "verify", label: "验证新版本健康状态", state: stepState(3) },
  ];
}

function createOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" />;
    case "active":
      return <Spinner className="size-4 shrink-0" aria-hidden="true" />;
    case "rollback":
      return <RotateCcw className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
    case "skipped":
    case "pending":
      return <Circle className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />;
  }
}

export function SelfUpdateDialog({
  open,
  onOpenChange,
  targetVersion,
  currentVersion,
  releaseUrl,
  returnFocus,
  pollIntervalMs = 2_000,
  onReload,
}: SelfUpdateDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>("loading");
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createBackup, setCreateBackup] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [trackedJob, setTrackedJob] = useState<UpdateExecutionJob | null>(null);
  const [trackedTarget, setTrackedTarget] = useState(targetVersion);
  const [trackedIncludeBackup, setTrackedIncludeBackup] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectStartedAt, setReconnectStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [pollWarning, setPollWarning] = useState<string | null>(null);

  // Track 2 inline backup state
  const [backupJob, setBackupJob] = useState<MaintenanceJob | null>(null);
  const [backupStarting, setBackupStarting] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const reconnectStartedAtRef = useRef<number | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const assistantBackupControllerRef = useRef<AbortController | null>(null);
  const effectiveTarget = trackedTarget || targetVersion;
  const effectiveCurrent = status?.current_version || currentVersion;

  const loadCapability = useCallback(async (externalSignal?: AbortSignal) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
        return;
      }
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    setPhase("loading");
    setLoadError(null);
    setApplyError(null);
    reconnectStartedAtRef.current = null;
    setReconnecting(false);
    setReconnectStartedAt(null);
    setPollWarning(null);
    try {
      const data = await getSelfUpdateStatus(signal);
      if (signal.aborted) return;
      setStatus(data);
      const hint = readActiveSelfUpdateHint();
      if (data.active_job) {
        setTrackedJob(data.active_job);
        setTrackedTarget(data.active_job.target_version);
        setTrackedIncludeBackup(hint?.id === data.active_job.id ? hint.create_backup : data.active_job.stage === "backing_up" || data.active_job.backup_name !== null);
        setPhase("running");
        return;
      }
      if (hint) {
        // Check explicit FAILED status before current_version so a recreating_backup failure is never masked as success.
        if (data.latest_job?.id === hint.id && data.latest_job.status === "FAILED") {
          clearActiveSelfUpdateHint();
          setTrackedTarget(hint.target_version);
          setTrackedJob(data.latest_job);
          setPhase("failed");
          return;
        }
        if (
          (data.latest_job?.id === hint.id && data.latest_job.status === "SUCCEEDED") ||
          data.current_version === hint.target_version
        ) {
          clearActiveSelfUpdateHint();
          setTrackedTarget(hint.target_version);
          setTrackedJob(data.latest_job ?? null);
          setPhase("completed");
          return;
        }
        clearActiveSelfUpdateHint();
      }
      setTrackedTarget(targetVersion);
      if (data.enabled) {
        if (
          data.latest_job?.target_version === targetVersion &&
          data.latest_job.status === "FAILED" &&
          data.current_version === targetVersion
        ) {
          setTrackedJob(data.latest_job);
          setPhase("failed");
          return;
        }
        if (
          data.current_version === targetVersion ||
          (data.latest_job?.target_version === targetVersion && data.latest_job.status === "SUCCEEDED")
        ) {
          setTrackedJob(data.latest_job ?? null);
          setPhase("completed");
          return;
        }
        setCreateBackup(data.can_backup);
        setPhase("confirm");
      } else {
        setPhase("assistant");
      }
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setLoadError(error instanceof Error ? error.message : "暂时无法读取更新状态。");
      setPhase("load_error");
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
      }
    }
  }, [targetVersion]);

  useEffect(() => {
    if (!open) {
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      assistantBackupControllerRef.current?.abort();
      assistantBackupControllerRef.current = null;
      return;
    }
    const controller = new AbortController();
    setBackupError(null);
    void loadCapability(controller.signal);
    return () => {
      controller.abort();
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      assistantBackupControllerRef.current?.abort();
      assistantBackupControllerRef.current = null;
    };
  }, [open, loadCapability]);

  // Keep reconnect elapsed seconds ticking live every second while waiting for restart recovery.
  useEffect(() => {
    if (!open || phase !== "running" || !reconnecting || reconnectStartedAt === null) return;
    setNowTick(Date.now());
    const interval = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1_000);
    return () => { window.clearInterval(interval); };
  }, [open, phase, reconnecting, reconnectStartedAt]);

  // Track 1 live status & restart reconnect polling loop
  useEffect(() => {
    if (!open || phase !== "running") return;
    const controller = new AbortController();
    let timer: number | undefined;
    let active = true;
    let unreachablePolls = 0;
    let missingJobPolls = 0;
    const jobId = trackedJob?.id ?? readActiveSelfUpdateHint()?.id ?? null;

    const poll = async () => {
      if (!active || controller.signal.aborted) return;
      try {
        const next = await getSelfUpdateStatus(controller.signal);
        if (!active || controller.signal.aborted) return;
        setStatus(next);
        reconnectStartedAtRef.current = null;
        setReconnecting(false);
        setReconnectStartedAt(null);

        const matchedLatest = next.latest_job && (!jobId || next.latest_job.id === jobId)
          ? next.latest_job
          : null;

        // Always honor an active job (such as recreating_backup after app already restarted) first.
        if (next.active_job) {
          unreachablePolls = 0;
          missingJobPolls = 0;
          setPollWarning(null);
          setTrackedJob(next.active_job);
        } else if (matchedLatest?.status === "FAILED") {
          clearActiveSelfUpdateHint();
          setPollWarning(null);
          setTrackedJob(matchedLatest);
          setPhase("failed");
          return;
        } else if (matchedLatest?.status === "SUCCEEDED" || next.current_version === effectiveTarget) {
          clearActiveSelfUpdateHint();
          setPollWarning(null);
          setTrackedJob(matchedLatest ?? next.latest_job ?? null);
          setPhase("completed");
          return;
        } else if (!next.enabled && next.unavailable_reason === "unreachable") {
          unreachablePolls += 1;
          if (unreachablePolls >= MAX_UNREACHABLE_POLLS) {
            clearActiveSelfUpdateHint();
            setPollWarning("持续无法连接到伴生更新器，请检查 updater 容器状态，或刷新页面确认当前运行版本。");
            return;
          }
          setPollWarning("暂时无法连接到伴生更新器，正在继续重试…");
        } else if (next.enabled) {
          missingJobPolls += 1;
          if (missingJobPolls >= MAX_MISSING_JOB_POLLS) {
            clearActiveSelfUpdateHint();
            setPollWarning("未能查询到更新任务状态（伴生更新器可能已重启），请刷新页面确认当前运行版本。");
            return;
          }
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (isTransientRestartError(error)) {
          const now = Date.now();
          const started = reconnectStartedAtRef.current ?? now;
          reconnectStartedAtRef.current = started;
          setReconnecting(true);
          setReconnectStartedAt(started);
          setNowTick(now);
          if (now - started >= MAX_RECONNECT_WAIT_MS) {
            setPollWarning("等待服务恢复已超过 5 分钟，请检查宿主机容器运行日志，或刷新页面确认状态。");
          }
        } else {
          setPollWarning(error instanceof Error ? error.message : "查询更新进度失败，将继续尝试重连。");
        }
      }
      if (active && !controller.signal.aborted) {
        timer = window.setTimeout(() => { void poll(); }, pollIntervalMs);
      }
    };

    timer = window.setTimeout(() => { void poll(); }, pollIntervalMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, phase, trackedJob?.id, effectiveTarget, pollIntervalMs]);

  // Track 2 inline backup polling
  const activeBackupId = backupJob && (backupJob.status === "QUEUED" || backupJob.status === "RUNNING")
    ? backupJob.id
    : null;

  useEffect(() => {
    if (!open || !activeBackupId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let active = true;

    const pollBackup = async () => {
      if (!active || controller.signal.aborted) return;
      try {
        const next = await getMaintenanceJob(activeBackupId, controller.signal);
        if (!active || controller.signal.aborted) return;
        setBackupJob(next);
        if (next.status === "QUEUED" || next.status === "RUNNING") {
          timer = window.setTimeout(() => { void pollBackup(); }, Math.min(pollIntervalMs, 1_500));
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setBackupError(error instanceof Error ? error.message : "查询备份进度失败，请前往备份设置确认。");
      }
    };

    timer = window.setTimeout(() => { void pollBackup(); }, Math.min(pollIntervalMs, 1_500));
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, activeBackupId, pollIntervalMs]);

  const handleApply = async () => {
    if (submitting) return;
    setSubmitting(true);
    setApplyError(null);
    const shouldBackup = Boolean(status?.can_backup && createBackup);
    try {
      const job = await applySelfUpdate({
        operation_id: createOperationId(),
        target_version: effectiveTarget,
        create_backup: shouldBackup,
      });
      writeActiveSelfUpdateHint({
        id: job.id,
        target_version: job.target_version,
        previous_version: job.previous_version,
        create_backup: shouldBackup,
      });
      setTrackedJob(job);
      setTrackedTarget(job.target_version);
      setTrackedIncludeBackup(shouldBackup);
      setReconnecting(false);
      setReconnectStartedAt(null);
      setPollWarning(null);
      setPhase("running");
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "未能发起在线更新，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssistantBackup = async () => {
    if (backupStarting || activeBackupId) return;
    setBackupStarting(true);
    setBackupError(null);
    assistantBackupControllerRef.current?.abort();
    const controller = new AbortController();
    assistantBackupControllerRef.current = controller;
    try {
      const job = await startMaintenance({ operation_id: createOperationId(), kind: "BACKUP" }, controller.signal);
      if (!controller.signal.aborted) setBackupJob(job);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setBackupError(error instanceof Error ? error.message : "未能启动数据库备份，请稍后重试。");
    } finally {
      if (assistantBackupControllerRef.current === controller) {
        assistantBackupControllerRef.current = null;
      }
      if (!controller.signal.aborted) setBackupStarting(false);
    }
  };

  const close = () => onOpenChange(false);
  const triggerReload = () => {
    if (onReload) onReload();
    else window.location.reload();
  };

  const assistantReasonText = status?.unavailable_reason === "demo_read_only"
    ? "当前演示环境为只读模式，仅展示标准升级步骤与目标版本命令。"
    : status?.unavailable_reason === "unreachable"
      ? "暂时无法连接到伴生更新器，请先检查 updater 容器状态，或按以下两步手动完成升级。"
      : "当前实例以默认高安全模式运行（未启用伴生更新器），可通过以下两步安全完成升级。";

  const steps = computeStepStates(trackedJob?.stage, trackedIncludeBackup, reconnecting);
  const reconnectSeconds = reconnectStartedAt ? Math.max(1, Math.floor((nowTick - reconnectStartedAt) / 1000)) : 0;
  const oneLineCommand = isReleaseVersion(effectiveTarget) ? buildOneLineUpgradeCommand(effectiveTarget) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-self-update-dialog
        initialFocus={titleRef}
        finalFocus={returnFocus ? () => (returnFocus.isConnected ? returnFocus : null) : undefined}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {phase === "assistant"
              ? `升级助手 · v${effectiveTarget}`
              : phase === "completed"
                ? "更新完成"
                : phase === "failed"
                  ? "更新未完成"
                  : `更新至 v${effectiveTarget}`}
          </DialogTitle>
          <DialogDescription>
            {phase === "loading" && "正在检查在线更新能力与任务状态…"}
            {phase === "load_error" && "暂时无法获取更新器状态，请重试或查看运行状态。"}
            {phase === "confirm" && "由独立伴生更新器拉取官方镜像并平滑重启服务，主容器仍保持只读与最小权限。"}
            {phase === "running" && "请保持此窗口开启以跟踪重启进度；即使关闭窗口，后台更新仍会继续执行。"}
            {phase === "completed" && "新版本已启动并通过健康检查。"}
            {phase === "failed" && "伴生更新器已中止本次切换并保留现场信息。"}
            {phase === "assistant" && assistantReasonText}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {phase === "loading" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              <span>正在检测更新器状态…</span>
            </div>
          )}

          {phase === "load_error" && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <p role="alert" className="text-destructive">{loadError}</p>
            </div>
          )}

          {phase === "confirm" && (
            <div className="flex flex-col gap-4">
              <dl className="grid min-w-0 gap-2.5 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <dt className="text-muted-foreground">当前版本</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="font-mono font-medium">v{effectiveCurrent}</span>
                    {isPrereleaseVersion(effectiveCurrent) && <Badge variant="secondary">预发布</Badge>}
                  </dd>
                </div>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <dt className="text-muted-foreground">目标版本</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="font-mono font-medium">v{effectiveTarget}</span>
                    {isPrereleaseVersion(effectiveTarget) && <Badge variant="secondary">预发布</Badge>}
                  </dd>
                </div>
                <Separator />
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-muted-foreground">目标官方镜像</dt>
                  <dd className="break-all font-mono text-xs text-foreground">
                    ghcr.io/mashiro0619/perpay:{effectiveTarget}
                  </dd>
                </div>
              </dl>

              <label
                htmlFor="self-update-create-backup"
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3"
              >
                <Checkbox
                  id="self-update-create-backup"
                  className="mt-0.5"
                  checked={Boolean(status?.can_backup && createBackup)}
                  disabled={!status?.can_backup || submitting}
                  onCheckedChange={(checked) => setCreateBackup(checked === true)}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">更新前自动备份数据库（推荐）</span>
                  <span className="text-xs text-muted-foreground">
                    {status?.can_backup
                      ? "先执行一次在线数据库备份；若备份失败将立即中止更新，当前收款服务不受影响。"
                      : "当前运行环境未启用在线维护服务，将跳过自动备份并直接执行镜像更新。"}
                  </span>
                </span>
              </label>

              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                <p>
                  切换容器期间收银台与后台将短暂中断约 10–30 秒。若新版本启动失败或未通过健康检查，伴生更新器将自动回滚至原容器。
                </p>
              </div>

              {applyError && (
                <p role="alert" className="text-sm text-destructive">{applyError}</p>
              )}
            </div>
          )}

          {phase === "running" && (
            <div className="flex flex-col gap-4">
              <ol className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3" aria-label="更新步骤">
                {steps.map(step => (
                  <li key={step.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <StepIcon state={step.state} />
                      <span className={step.state === "pending" || step.state === "skipped" ? "text-muted-foreground" : "font-medium text-foreground"}>
                        {step.label}
                      </span>
                    </span>
                    {step.state === "done" && <Badge variant="secondary">已完成</Badge>}
                    {step.state === "active" && <Badge variant="outline">进行中</Badge>}
                    {step.state === "skipped" && <Badge variant="secondary">已跳过</Badge>}
                    {step.state === "rollback" && <Badge variant="destructive">回滚中</Badge>}
                  </li>
                ))}
              </ol>

              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground" role="status">
                  <Spinner aria-hidden="true" />
                  <span>
                    {reconnecting
                      ? "服务正在重启，等待新版本恢复连接…"
                      : trackedJob?.message ?? "正在准备更新…"}
                  </span>
                </div>
                {reconnecting && (
                  <p role="timer" aria-live="off" className="text-xs text-muted-foreground">
                    容器切换期间页面会自动重连（已等待 {reconnectSeconds} 秒），无需手动刷新。
                  </p>
                )}
                {trackedJob?.backup_name && (
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    更新前备份：{trackedJob.backup_name}
                  </p>
                )}
              </div>

              {pollWarning && (
                <p role="alert" className="text-xs text-destructive">{pollWarning}</p>
              )}
            </div>
          )}

          {phase === "completed" && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <CheckCircle2 className="size-4 shrink-0 text-foreground" aria-hidden="true" />
                <span>已成功更新至 v{effectiveTarget}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                新版本服务已就绪，请刷新页面以加载新版管理界面资源。
              </p>
              {trackedJob?.backup_name && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  更新前备份：{trackedJob.backup_name}
                </p>
              )}
            </div>
          )}

          {phase === "failed" && (
            <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-4 text-sm">
              <div className="flex items-start gap-2 font-medium text-foreground">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                <span>
                  {trackedJob?.rolled_back
                    ? `新版本启动异常，已自动回滚至 v${trackedJob.previous_version}`
                    : effectiveCurrent === effectiveTarget
                      ? `核心服务已切换至 v${effectiveTarget}，但备份服务更新未完成`
                      : "更新未完成，当前服务运行正常"}
                </span>
              </div>
              <p role="alert" className="break-words text-xs text-destructive">
                {trackedJob?.error ?? trackedJob?.message ?? "伴生更新器报告任务失败。"}
              </p>
              {trackedJob?.backup_name && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  更新前备份已保留：{trackedJob.backup_name}
                </p>
              )}
            </div>
          )}

          {phase === "assistant" && (
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">第 1 步：更新前在线备份数据库</span>
                  {backupJob?.status === "SUCCEEDED"
                    ? <Badge variant="secondary">已完成</Badge>
                    : <Badge variant="outline">推荐</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {status?.can_backup
                    ? "无需进入服务器终端，可直接在线生成一份经过完整性校验的 SQLite 备份。"
                    : status?.unavailable_reason === "demo_read_only"
                      ? "演示环境为只读模式，不执行数据库写入操作。"
                      : "当前运行环境未启用在线维护备份，可在宿主机使用维护命令先备份数据。"}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!status?.can_backup || backupStarting || activeBackupId !== null}
                    onClick={() => { void handleAssistantBackup(); }}
                  >
                    {(backupStarting || activeBackupId !== null) && <Spinner aria-hidden="true" data-icon="inline-start" />}
                    {backupJob?.status === "SUCCEEDED" ? "再次备份数据库" : "立即备份数据库"}
                  </Button>
                  {backupJob && (backupJob.status === "QUEUED" || backupJob.status === "RUNNING") && (
                    <span role="status" className="text-xs text-muted-foreground">{backupJob.message}</span>
                  )}
                </div>
                {backupJob?.status === "SUCCEEDED" && (
                  <p role="status" className="break-all font-mono text-xs text-foreground">
                    已创建备份：{backupJob.result?.backup_name ?? "已完成"}
                  </p>
                )}
                {(backupError || backupJob?.status === "FAILED") && (
                  <p role="alert" className="text-xs text-destructive">
                    {backupError ?? backupJob?.error ?? "数据库备份未完成"}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
                <span className="text-sm font-medium text-foreground">第 2 步：在宿主机一键更新容器</span>
                <div className="flex min-w-0 flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">目标镜像</span>
                  <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono">
                    <CopyValue value={`ghcr.io/mashiro0619/perpay:${effectiveTarget}`} label="复制目标镜像" />
                  </div>
                </div>
                {oneLineCommand && (
                  <div className="flex min-w-0 flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">单行升级命令（在 docker-compose.yml 所在目录执行）</span>
                    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono">
                      <CopyValue value={oneLineCommand} label="复制升级命令" />
                    </div>
                  </div>
                )}
              </div>

              <Collapsible className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <CollapsibleTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto w-full justify-between px-0 py-0 text-xs font-medium text-foreground hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent"
                    />
                  }
                >
                  <span>如何启用后台一键更新？</span>
                  <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground transition-transform [[data-panel-open]_&]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2.5 flex flex-col gap-2 text-muted-foreground">
                  <p>
                    如需以后直接在网页后台一键完成更新，可在宿主机合并启动可选伴生更新器（主容器仍保持只读与非 root，不挂载 docker.sock）：
                  </p>
                  <div className="rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-foreground">
                    <CopyValue value={UPDATER_ENABLE_COMMAND} label="复制启用伴生更新器命令" />
                  </div>
                  <div>
                    <a
                      data-external-link
                      className={buttonVariants({ variant: "ghost", size: "sm" })}
                      href={SELF_UPDATE_DOCS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      查看伴生更新器说明
                    </a>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {releaseUrl && (phase === "confirm" || phase === "assistant") && (
            <a
              data-external-link
              className={buttonVariants({ variant: "ghost" })}
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看发布说明
            </a>
          )}
          {phase === "load_error" && (
            <>
              <Button variant="outline" onClick={close}>关闭</Button>
              <Button onClick={() => { void loadCapability(); }}>重试</Button>
            </>
          )}
          {phase === "confirm" && (
            <>
              <Button variant="outline" onClick={close} disabled={submitting}>取消</Button>
              <Button onClick={() => { void handleApply(); }} disabled={submitting}>
                {submitting && <Spinner aria-hidden="true" data-icon="inline-start" />}
                确认开始更新
              </Button>
            </>
          )}
          {phase === "running" && (
            <>
              <Button variant="outline" onClick={close}>后台继续</Button>
              {pollWarning && <Button onClick={triggerReload}>刷新页面</Button>}
            </>
          )}
          {phase === "completed" && (
            <>
              <Button variant="outline" onClick={close}>稍后刷新</Button>
              <Button onClick={triggerReload}>刷新页面</Button>
            </>
          )}
          {phase === "failed" && (
            <>
              <Button variant="outline" onClick={close}>关闭</Button>
              <Button onClick={() => { void loadCapability(); }}>重新检查状态</Button>
            </>
          )}
          {(phase === "loading" || phase === "assistant") && (
            <Button onClick={close}>关闭</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
