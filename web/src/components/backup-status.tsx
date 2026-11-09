import { useQuery } from "@tanstack/react-query";
import { api, result, type BackupHealth } from "@/api/client";
import { dateTime } from "@/lib/format";
import { FieldDescription } from "@/components/ui/field";
import { useOptionalSystemStatus } from "@/features/system-status";
import { backupFailureStageName } from "@/lib/runtime-copy";
import { RuntimeErrorDetails } from "@/components/runtime-error-details";

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

export function BackupStatus() {
  const shared = useOptionalSystemStatus();
  const fallback = useQuery({
    queryKey: ["status", "backup-settings"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: !shared,
    retry: false,
  });
  const status = shared?.status ?? fallback;
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
          最近成功 {dateTime(backup.last_success_at)} · 可用备份{" "}
          {backup.retained_count ?? 0} 份
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
