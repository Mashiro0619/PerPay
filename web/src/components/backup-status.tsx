import { useQuery } from "@tanstack/react-query";
import { api, result, type BackupHealth, type RuntimeSettings } from "@/api/client";
import { backupIntervalLabel, dateTime } from "@/lib/format";
import { FieldDescription } from "@/components/ui/field";
import { useOptionalSystemStatus } from "@/features/system-status";
import { backupFailureStageName } from "@/lib/runtime-copy";
import { RuntimeErrorDetails } from "@/components/runtime-error-details";
import { SettingsSummary, type SettingsSummaryRow } from "@/components/settings-summary";
import { ErrorNotice } from "@/components/request-state";
import { CopyValue } from "@/components/copy-value";
import { buttonVariants } from "@/components/ui/button";

function backupStatusMessage(backup: BackupHealth): string {
  if (backup.backup_in_progress) return "正在备份";
  if (!backup.enabled) return "备份未启用，保存策略不会启动任务。";
  if (backup.recovery_required) return "备份任务需要恢复，请按维护文档处理。";
  if (backup.clock_moved_backwards) return "系统时钟发生回退，请检查主机时间同步。";
  if (backup.configuration_mismatch) return "备份配置与任务不一致，请检查服务器任务。";
  if (backup.instance_matches === false) return "备份与当前实例不匹配，请检查备份目录。";
  if (backup.last_error_stage) return "最近备份失败（" + backupFailureStageName(backup.last_error_stage) + "），请查看备份日志。";
  if (!backup.backup_available) return "尚无可用备份，请先完成一次备份验证。";
  if (backup.backup_required) return "当前数据需要重新备份，请检查服务器备份任务。";
  if (!backup.ok) return "当前备份未通过健康检查，请检查服务器备份任务。";
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
  const backup = status.data?.data.backup;
  const current = !!backup && !status.isError && !status.isPaused;
  const rows: SettingsSummaryRow[] = [["任务状态", status.isPending ? "正在读取…" : !current ? "当前状态待确认" : backupStatusMessage(backup)]];
  if (backup) rows.push(
    ["最近成功", backup.last_success_at === null ? "尚未成功备份" : dateTime(backup.last_success_at)],
    ["恢复校验", !current ? "待确认" : backup.backup_available ? "最近副本已验证可用" : "暂无已验证的可恢复副本"],
    ["保留记录", backup.retained_count === null ? "未记录数量" : backup.retained_count + " 份"],
    ...(current && backup.backup_available && backup.backup_name ? [["最近可用副本", <CopyValue value={backup.backup_name} label="复制备份文件名" />] as const] : []),
    ["下次计划", !current ? "待确认" : !backup.enabled ? "未启用" : backup.backup_in_progress ? "正在执行"
      : backup.configuration_mismatch || backup.recovery_required || backup.clock_moved_backwards || backup.last_error_stage ? "等待任务恢复"
        : backup.backup_required || backup.last_success_at === null ? "等待首次或恢复后备份"
          : dateTime(backup.last_success_at + (backup.interval_milliseconds ?? settings.backup.interval_seconds * 1000))],
  );
  rows.push(["备份间隔", backupIntervalLabel(settings.backup.interval_seconds)], ["保留备份数量", settings.backup.keep_count]);
  const guide = "https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md";
  return <div className="flex flex-col gap-3">
    <ErrorNotice error={status.error} retry={() => { void status.refetch(); }} retainedData={!!backup} />
    <SettingsSummary title="自动备份" rows={rows} editTo="/settings/backup/edit" actions={<>
      <a data-external-link className={buttonVariants({ variant: "ghost", size: "sm" })} href={guide + "#主密钥与备份的异地保存"} target="_blank" rel="noopener noreferrer">导出备份步骤</a>
      <a data-external-link className={buttonVariants({ variant: "ghost", size: "sm" })} href={guide + "#恢复数据库"} target="_blank" rel="noopener noreferrer">恢复说明</a>
    </>} />
  </div>;
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
          最近成功 {dateTime(backup.last_success_at)} · 保留记录{" "}
          {backup.retained_count === null ? "数量未知" : backup.retained_count + " 份"}
        </FieldDescription>
      )}
      <FieldDescription>
        <a
          data-external-link
          href="https://github.com/Mashiro0619/PerPay/blob/main/docs/maintenance.md#启用与验证备份"
          target="_blank"
          rel="noopener noreferrer"
        >
          启用与验证备份
        </a>{" "}
        · 主密钥须另行保管。
      </FieldDescription>
    </div>
  );
}
