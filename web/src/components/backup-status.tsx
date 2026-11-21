import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, result, type BackupHealth, type RuntimeSettings } from "@/api/client";
import { listManagedBackupFiles } from "@/api/maintenance";
import { useMaintenanceAction, useMaintenanceJobs } from "@/hooks/use-maintenance";
import { Link } from "@/navigation";
import { backupIntervalLabel, dateTime } from "@/lib/format";
import { FieldDescription } from "@/components/ui/field";
import { useOptionalSystemStatus } from "@/features/system-status";
import { backupFailureStageName } from "@/lib/runtime-copy";
import { RuntimeErrorDetails } from "@/components/runtime-error-details";
import { SettingsSummary, type SettingsSummaryRow } from "@/components/settings-summary";
import { ErrorNotice } from "@/components/request-state";
import { CopyValue } from "@/components/copy-value";
import { Button } from "@/components/ui/button";
import { BackupFiles, backupFilesKey } from "@/components/backup-files";
import { MaintenanceConfirmation, MaintenanceJobResult } from "@/components/maintenance-operation";
import { DatabaseBackup } from "lucide-react";

function backupStatusMessage(backup: BackupHealth): string {
  if (backup.backup_in_progress) return "正在备份";
  if (backup.status === "unavailable") return "备份状态暂不可用，请检查备份目录及权限。";
  if (backup.recovery_required) return "检测到上次备份或维护异常中断或锁状态异常，请按维护文档排查恢复，切勿直接覆盖运行中的数据库。";
  if (backup.clock_moved_backwards) return "系统时钟发生回退，请检查主机时间同步。";
  if (backup.configuration_mismatch) return "已保存的备份策略与当前运行配置不一致，请检查服务器备份任务是否已同步。";
  if (backup.instance_matches === false) return "备份与当前实例不匹配，请检查备份目录。";
  if (backup.last_error_stage) return "最近备份失败（" + backupFailureStageName(backup.last_error_stage) + "）。";
  if (!backup.enabled) return "自动备份未运行，可立即创建备份。";
  if (!backup.backup_available) return "尚无已验证可用的备份。";
  if (backup.backup_required) return "当前数据需要重新备份。";
  if (!backup.ok) return "当前备份未通过健康检查。";
  return "备份任务已启用";
}

function useBackupStatus() {
  const shared = useOptionalSystemStatus();
  const fallback = useQuery({
    queryKey: ["status", "backup-settings"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: !shared,
    retry: false,
  });
  return shared?.status ?? fallback;
}

export function BackupOverview({ settings }: { settings: RuntimeSettings }) {
  const status = useBackupStatus();
  const maintenance = useMaintenanceJobs();
  const files = useQuery({
    queryKey: backupFilesKey,
    queryFn: ({ signal }) => listManagedBackupFiles(signal),
    refetchOnMount: "always",
    retry: false,
  });
  const backup = status.data?.data.backup;
  if (maintenance.requiresLogin) return <MaintenanceJobResult job={maintenance.latest} />;
  const current = !!backup && !status.isError && !status.isPaused;
  const notStarted = current && !backup.enabled && backup.status === "disabled" &&
    backup.last_attempt_at === null && backup.last_success_at === null && backup.content_verified_at === null &&
    (backup.retained_count === null || backup.retained_count === 0) && !backup.backup_available && !backup.last_error_stage &&
    !backup.backup_in_progress && !backup.recovery_required && !backup.clock_moved_backwards &&
    !backup.configuration_mismatch && backup.instance_matches !== false &&
    files.isSuccess && files.data.data.items.length === 0;
  const rows: SettingsSummaryRow[] = [["任务状态", status.isPending ? "正在读取…" : !current ? "当前状态待确认" : backupStatusMessage(backup)]];
  if (backup && !notStarted) rows.push(
    ["最近成功", backup.last_success_at === null ? "尚未成功备份" : dateTime(backup.last_success_at)],
    ["恢复校验", !current || backup.status === "unavailable" ? "待确认" : backup.backup_available ? "最近备份文件已验证可用" : "暂无已验证的可恢复备份文件"],
    ["最近内容校验", backup.content_verified_at === null ? "尚未通过校验" : dateTime(backup.content_verified_at)],
    ["已保留备份", backup.retained_count === null ? "未记录数量" : backup.retained_count + " 份"],
    ...(current && backup.backup_available && backup.backup_name ? [["最近可用备份", <CopyValue value={backup.backup_name} label="复制备份文件名" />] as const] : []),
    ["下次计划", !current || backup.status === "unavailable" ? "待确认" : !backup.enabled ? "未启用" : backup.backup_in_progress ? "正在执行"
      : backup.configuration_mismatch || backup.recovery_required || backup.clock_moved_backwards || backup.last_error_stage ? "等待任务恢复"
        : backup.backup_required || backup.last_success_at === null ? "等待下一次备份执行"
          : dateTime(backup.last_success_at + (backup.interval_milliseconds ?? settings.backup.interval_seconds * 1000))],
  );
  rows.push(["备份间隔", backupIntervalLabel(settings.backup.interval_seconds)], ["保留备份数量", settings.backup.keep_count + " 份"]);
  return <div className="flex flex-col gap-3">
    <ErrorNotice error={maintenance.error} retry={() => { void maintenance.refetch(); }} />
    <MaintenanceJobResult job={maintenance.active ?? maintenance.latest} />
    <ErrorNotice error={status.error} retry={() => { void status.refetch(); }} retainedData={!!backup} />
    <SettingsSummary title="自动备份" rows={rows} editTo="/settings/backup/edit"
      description={notStarted ? "可立即创建备份，也可编辑自动备份策略。" : undefined}
      actions={<BackupNowButton blocked={maintenance.blocked || !!backup?.backup_in_progress} />} />
    <BackupFiles blocked={maintenance.blocked || !!backup?.backup_in_progress} />
  </div>;
}

function BackupNowButton({ blocked }: { blocked: boolean }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ operation_id: string; kind: "BACKUP" } | null>(null);
  const operation = useMaintenanceAction(() => setOpen(false));
  return <>
    <Button variant="outline" size="sm" disabled={operation.pending || (blocked && !operation.unknown)} onClick={() => {
      if (operation.reset()) setRequest({ operation_id: crypto.randomUUID(), kind: "BACKUP" });
      setOpen(true);
    }}><DatabaseBackup data-icon="inline-start" />{operation.unknown ? "查询备份任务" : "立即备份"}</Button>
    <MaintenanceConfirmation open={open} onOpenChange={setOpen} title="立即创建一份备份？"
      description="系统会备份当前业务数据和配置，并校验备份文件是否可用。进度和结果会显示在本页。"
      confirmLabel="确认立即备份" pending={operation.pending} error={operation.error} unknown={operation.unknown}
      refreshing={operation.refreshing} onRefresh={operation.refresh}
      onConfirm={() => { if (request) operation.submit(request); }} />
  </>;
}

export function BackupStatus() {
  const status = useBackupStatus();
  const backup = status.data?.data.backup;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="备份任务状态">
      <FieldDescription>
        {status.isPending ? "正在读取备份状态…"
          : status.isError || !backup ? "备份状态暂不可用，保存仅更新策略。"
          : backupStatusMessage(backup)}
      </FieldDescription>
      <RuntimeErrorDetails title="备份错误诊断" items={[["原始失败阶段", backup?.last_error_stage]]} />
      {backup && (
        <FieldDescription>
          最近成功 {dateTime(backup.last_success_at)} · 已保留备份{" "}
          {backup.retained_count === null ? "数量未知" : backup.retained_count + " 份"}
        </FieldDescription>
      )}
      <FieldDescription>
        <Link global to="/settings/backup">查看备份与恢复</Link>{" "}
        · 主密钥须另行保管。
      </FieldDescription>
    </div>
  );
}
